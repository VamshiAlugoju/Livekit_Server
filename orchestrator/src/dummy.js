// DummyParticipant: one synthetic LiveKit participant.
// Connects, publishes a video + audio track backed by VideoSource/AudioSource.
// The actual frames are pushed by a shared MediaPump (see media-pump.js) — this
// class only owns the connection, tracks, and sources.
import {
  Room,
  RoomEvent,
  VideoSource,
  AudioSource,
  LocalVideoTrack,
  LocalAudioTrack,
  TrackPublishOptions,
  TrackSource,
  VideoCodec,
} from '@livekit/rtc-node';
import { createToken } from './token.js';
import { config } from '../config.js';

// config.video.codec (string) -> rtc-node VideoCodec enum.
const VIDEO_CODECS = {
  vp8: VideoCodec.VP8,
  h264: VideoCodec.H264,
  vp9: VideoCodec.VP9,
  av1: VideoCodec.AV1,
  h265: VideoCodec.H265,
};

export class DummyParticipant {
  /**
   * @param {{ identity:string, name?:string, metadata:string }} normalized from normalizeParticipant()
   */
  constructor(normalized) {
    this.normalized = normalized;
    this.identity = normalized.identity;
    this.label = normalized.name || normalized.identity; // for logs
    this.room = new Room();
    this.videoSource = null;
    this.audioSource = null;
    this.connected = false;
  }

  async join(room) {
    this.room_ = room;
    const token = await createToken(this.normalized, room);

    this.room.on(RoomEvent.Disconnected, (reason) => {
      this.connected = false;
      console.log(`[dummy:${this.label}] disconnected (${reason})`);
    });

    await this.room.connect(config.url, token, {
      autoSubscribe: false, // publish-only; don't pull others' media
      dynacast: true,
    });
    this.connected = true;

    // Sources sized to the forced decode format.
    this.videoSource = new VideoSource(config.video.width, config.video.height);
    this.audioSource = new AudioSource(config.audio.sampleRate, config.audio.channels);

    const videoTrack = LocalVideoTrack.createVideoTrack('camera', this.videoSource);
    const audioTrack = LocalAudioTrack.createAudioTrack('microphone', this.audioSource);

    await this.room.localParticipant.publishTrack(
      videoTrack,
      new TrackPublishOptions({
        source: TrackSource.SOURCE_CAMERA,
        simulcast: config.video.simulcast,
        videoCodec: VIDEO_CODECS[config.video.codec] ?? VideoCodec.H264,
      }),
    );
    await this.room.localParticipant.publishTrack(
      audioTrack,
      new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }),
    );

    console.log(`[dummy:${this.label}] joined "${room}" as ${this.identity} + published camera/mic`);
    // Sources are registered with the MediaPump by the orchestrator.
    return { videoSource: this.videoSource, audioSource: this.audioSource };
  }

  async leave() {
    try {
      await this.videoSource?.close();
      await this.audioSource?.close();
    } catch {
      /* sources may already be closed */
    }
    try {
      if (this.connected) await this.room.disconnect();
    } catch {
      /* already disconnected */
    }
  }
}
