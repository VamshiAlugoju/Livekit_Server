// Central config. Shares the SAME env as cb-backend-nest: we load that project's
// .env so LiveKit URLs stay in sync with the backend.
//
// NOTE on keys: cb-backend-nest's LiveKitService HARDCODES apiKey='devkey' /
// apiSecret='secret' and ignores LIVEKIT_API_KEY/SECRET from .env (those are
// placeholders). The LiveKit server therefore authenticates with devkey/secret.
// We mirror that exactly — using the .env key/secret would fail auth.
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load cb-backend-nest/.env (override with CB_BACKEND_ENV). Does not overwrite
// vars already set in this process's own environment.
const backendEnvPath =
  process.env.CB_BACKEND_ENV ||
  resolve(__dirname, "../../cb-backend-nest/.env");
if (existsSync(backendEnvPath)) {
  loadEnv({ path: backendEnvPath, quiet: true });
} else {
  console.warn(
    `[config] cb-backend-nest .env not found at ${backendEnvPath} — using defaults`,
  );
}

export const config = {
  // Client-reachable URL handed to the rtc-node client. Same vars as the backend.
  url:
    process.env.LIVEKIT_CLIENT_URL ||
    process.env.LIVEKIT_SERVER_URL ||
    "ws://10.10.10.122:7880",

  // Match LiveKitService: keys are hardcoded, NOT read from env.
  apiKey: "devkey",
  apiSecret: "secret",

  // Default room. Override with --room <name>.
  room: process.env.LIVEKIT_ROOM || "dummy-room",

  // Hard cap on dummy count (2 real + 8 dummy = 10, matches room maxParticipants).
  maxDummies: 5,

  // Default media dir (drop your mp4 files here). Override with --media-dir.
  mediaDir: process.env.MEDIA_DIR || join(__dirname, "media"),

  // Decode/publish format. Forced via ffmpeg so frame sizes are deterministic.
  video: {
    // width: Number(process.env.VIDEO_WIDTH) || 1280, // 720p source → 3 layers incl 180p
    // height: Number(process.env.VIDEO_HEIGHT) || 720,
    width: Number(process.env.VIDEO_WIDTH) || 160, // 720p source → 3 layers incl 180p
    height: Number(process.env.VIDEO_HEIGHT) || 80,
    fps: Number(process.env.VIDEO_FPS) || 10, // match real publisher cap
    // Simulcast on (parity with real clients). 720p source yields q/h/f
    // (180/360/720). Set VIDEO_SIMULCAST=false to publish a single layer.
    simulcast: false,
    // Wire codec: vp8 | h264 | vp9 | av1 | h265. Default h264 (RN client parity).
    codec: (process.env.VIDEO_CODEC || "h264").toLowerCase(),
  },
  audio: {
    sampleRate: Number(process.env.AUDIO_RATE) || 48000,
    channels: Number(process.env.AUDIO_CHANNELS) || 1,
    // Audio frame chunk in ms (samplesPerChannel = rate * ms/1000).
    frameMs: Number(process.env.AUDIO_FRAME_MS) || 20,
  },
};
