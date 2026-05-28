// MediaPump: decode ONE mp4 with ffmpeg and fan raw frames out to many sources.
//
// Why fan-out: 9 dummies sharing a clip should decode it once, not 9x. Each
// dummy registers its own VideoSource/AudioSource; the pump captures the same
// decoded frame into every registered source. Big CPU win at scale.
//
// Pacing: ffmpeg `-re` emits at native (real-time) rate, and we consume the
// pipe with an async iterator (`for await`), so reading naturally back-pressures
// ffmpeg. No manual frame timers needed.
import { spawn } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import { VideoFrame, AudioFrame, VideoBufferType } from "@livekit/rtc-node";

export class MediaPump {
  /**
   * @param {string} filePath absolute path to source mp4
   * @param {object} opts
   * @param {{width:number,height:number,fps:number}} opts.video
   * @param {{sampleRate:number,channels:number,frameMs:number}} opts.audio
   */
  constructor(filePath, { video, audio }) {
    this.filePath = filePath;
    this.video = video;
    this.audio = audio;

    /** @type {Set<import('@livekit/rtc-node').VideoSource>} */
    this.videoSources = new Set();
    /** @type {Set<import('@livekit/rtc-node').AudioSource>} */
    this.audioSources = new Set();

    this.procs = [];
    this.running = false;

    // I420: width*height (Y) + 2 * (width/2 * height/2) (U,V) = w*h*3/2 bytes.
    this.videoFrameBytes = (video.width * video.height * 3) / 2;
    // s16le mono/stereo chunk: samplesPerChannel * channels * 2 bytes.
    this.audioSamplesPerChannel = Math.round(
      (audio.sampleRate * audio.frameMs) / 1000,
    );
    this.audioFrameBytes = this.audioSamplesPerChannel * audio.channels * 2;
  }

  addSubscriber({ videoSource, audioSource }) {
    if (videoSource) this.videoSources.add(videoSource);
    if (audioSource) this.audioSources.add(audioSource);
  }

  // Drop all current sources (used on room switch). Decode keeps running; frames
  // are simply discarded until new subscribers register.
  clearSubscribers() {
    this.videoSources.clear();
    this.audioSources.clear();
  }

  start() {
    if (this.running) return;
    this.running = true;
    // Run video + audio decode pipelines concurrently; restart on exit while running.
    this._runVideo();
    this._runAudio();
  }

  async stop() {
    this.running = false;
    for (const proc of this.procs) {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
    this.procs = [];
  }

  _spawn(args) {
    const proc = spawn(ffmpegPath, args, {
      stdio: ["ignore", "pipe", "ignore"],
    });
    this.procs.push(proc);
    return proc;
  }

  async _runVideo() {
    const { width, height, fps } = this.video;
    while (this.running) {
      const proc = this._spawn([
        "-hide_banner",
        "-loglevel",
        "error",
        "-re", // pace at real-time
        "-stream_loop",
        "-1", // loop the file forever
        "-i",
        this.filePath,
        "-an", // no audio in this pipeline
        "-f",
        "rawvideo",
        "-pix_fmt",
        "yuv420p", // == I420
        "-s",
        `${width}x${height}`,
        "-r",
        String(fps),
        "pipe:1",
      ]);

      try {
        let leftover = Buffer.alloc(0);
        for await (const chunk of proc.stdout) {
          if (!this.running) break;
          leftover = leftover.length ? Buffer.concat([leftover, chunk]) : chunk;
          while (leftover.length >= this.videoFrameBytes) {
            const raw = leftover.subarray(0, this.videoFrameBytes);
            leftover = leftover.subarray(this.videoFrameBytes);
            this._captureVideo(raw);
          }
        }
      } catch (err) {
        if (this.running)
          console.error("[pump:video] stream error", err?.message);
      }
      // `-stream_loop -1` should never exit; if it does, loop restarts it.
    }
  }

  _captureVideo(raw) {
    if (this.videoSources.size === 0) return;
    // Copy: ffmpeg buffer is reused; VideoFrame must own its bytes.
    const data = new Uint8Array(raw); // copies the subarray
    for (const src of this.videoSources) {
      if (src.closed) continue;
      const frame = new VideoFrame(
        data,
        this.video.width,
        this.video.height,
        VideoBufferType.I420,
      );
      try {
        src.captureFrame(frame);
      } catch {
        /* source closed mid-publish */
      }
    }
  }

  async _runAudio() {
    const { sampleRate, channels } = this.audio;
    while (this.running) {
      const proc = this._spawn([
        "-hide_banner",
        "-loglevel",
        "error",
        "-re",
        "-stream_loop",
        "-1",
        "-i",
        this.filePath,
        "-vn",
        "-af",
        "volume=0.01",
        "-f",
        "s16le",
        "-acodec",
        "pcm_s16le",
        "-ar",
        String(sampleRate),
        "-ac",
        String(channels),
        "pipe:1",
      ]);

      try {
        let leftover = Buffer.alloc(0);
        for await (const chunk of proc.stdout) {
          if (!this.running) break;
          leftover = leftover.length ? Buffer.concat([leftover, chunk]) : chunk;
          while (leftover.length >= this.audioFrameBytes) {
            const raw = leftover.subarray(0, this.audioFrameBytes);
            leftover = leftover.subarray(this.audioFrameBytes);
            await this._captureAudio(raw);
          }
        }
      } catch (err) {
        if (this.running)
          console.error("[pump:audio] stream error", err?.message);
      }
    }
  }

  async _captureAudio(raw) {
    if (this.audioSources.size === 0) return;
    // Int16Array view over a copied buffer (aligned). Object byte length is fixed.
    const copy = Buffer.from(raw);
    const i16 = new Int16Array(copy.buffer, copy.byteOffset, copy.length / 2);
    const captures = [];
    for (const src of this.audioSources) {
      if (src.closed) continue;
      const frame = new AudioFrame(
        i16,
        this.audio.sampleRate,
        this.audio.channels,
        this.audioSamplesPerChannel,
      );
      // captureFrame resolves when the source queue has room -> back-pressure.
      captures.push(src.captureFrame(frame).catch(() => {}));
    }
    await Promise.all(captures);
  }
}
