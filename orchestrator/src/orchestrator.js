// Dummy Participant Orchestrator
//
// Stages:
//   1. Load participant array (JSON file or inline default)
//   2. Resolve a media file per participant (explicit `media` or round-robin)
//   3. Generate tokens + spawn dummies (real LiveKit participants)
//   4. Publish prerecorded media via shared MediaPumps (decode-once, fan-out)
//
// Usage:
//   node src/orchestrator.js --room myroom --participants ./participants.json
//   node src/orchestrator.js --dry            # validate without connecting
//
// Runtime room switch (HTTP control plane, see control-server.js):
//   curl -X POST localhost:8788/room -d '{"roomId":"call-123"}'
//   curl localhost:8788/status
//
// Flags: --room  --participants  --media-dir  --count  --url  --duration  --dry
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join, isAbsolute, extname } from 'node:path';
import { config } from '../config.js';
import { createToken } from './token.js';
import { normalizeParticipant } from './normalize.js';
import { Orchestrator } from './runner.js';
import { startControlServer } from './control-server.js';

function parseArgs(argv) {
  const args = { dry: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry') args.dry = true;
    else if (a === '--room') args.room = argv[++i];
    else if (a === '--participants') args.participants = argv[++i];
    else if (a === '--media-dir') args.mediaDir = argv[++i];
    else if (a === '--url') args.url = argv[++i];
    else if (a === '--count') args.count = Number(argv[++i]);
    else if (a === '--duration') args.duration = Number(argv[++i]); // auto-leave after N sec
    else if (a === '--allow-create') args.allowCreate = true; // permit joining non-existent rooms
  }
  return args;
}

function loadParticipants(path) {
  // Default sample lives next to the project root.
  const file = path ? resolve(path) : resolve(process.cwd(), 'participants.json');
  if (!existsSync(file)) {
    throw new Error(
      `Participants file not found: ${file}\n` +
        `Pass --participants <path> or create participants.json. See participants.sample.json.`,
    );
  }
  const data = JSON.parse(readFileSync(file, 'utf8'));
  const arr = Array.isArray(data) ? data : data.participants;
  if (!Array.isArray(arr) || arr.length === 0) {
    throw new Error('Participants file must be a non-empty JSON array (or { participants: [...] }).');
  }
  return arr;
}

function listMediaFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => ['.mp4', '.mov', '.mkv', '.webm'].includes(extname(f).toLowerCase()))
    .map((f) => join(dir, f));
}

function resolveMediaPath(record, mediaDir, pool, index) {
  if (record.media) {
    const p = isAbsolute(record.media) ? record.media : join(mediaDir, record.media);
    return p;
  }
  if (pool.length === 0) return null;
  return pool[index % pool.length]; // round-robin shared clips
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Apply CLI overrides onto config.
  if (args.room) config.room = args.room;
  if (args.url) config.url = args.url;
  if (args.mediaDir) config.mediaDir = resolve(args.mediaDir);

  let participants = loadParticipants(args.participants);

  // Enforce dummy cap (8 by default). --count can only lower it.
  const limit = Math.min(config.maxDummies, args.count || Infinity);
  if (participants.length > limit) {
    console.log(`[cap] ${participants.length} participants in file -> using first ${limit} (max ${config.maxDummies}).`);
    participants = participants.slice(0, limit);
  }

  const pool = listMediaFiles(config.mediaDir);

  console.log('=== Dummy Participant Orchestrator ===');
  console.log(`room:       ${config.room}`);
  console.log(`url:        ${config.url}`);
  console.log(`media dir:  ${config.mediaDir}`);
  console.log(`media pool: ${pool.length ? pool.map((p) => p.split(/[\\/]/).pop()).join(', ') : '(none)'}`);
  console.log(`dummies:    ${participants.length}`);
  console.log(`format:     video ${config.video.width}x${config.video.height}@${config.video.fps} ${config.video.codec.toUpperCase()} (simulcast ${config.video.simulcast ? 'on' : 'off'}), audio ${config.audio.sampleRate}Hz x${config.audio.channels}`);
  console.log('');

  // Normalize (DB shape -> { identity, name, metadata }) + resolve media up front.
  const plan = participants.map((record, i) => {
    const norm = normalizeParticipant(record);
    const mediaPath = resolveMediaPath(norm, config.mediaDir, pool, i);
    return { norm, mediaPath };
  });

  for (const { norm, mediaPath } of plan) {
    const ok = mediaPath && existsSync(mediaPath);
    const tag = ok ? 'OK' : 'NO MEDIA';
    console.log(`  - ${norm.name || '(no name)'} [${norm.identity}]  ->  ${mediaPath ? mediaPath.split(/[\\/]/).pop() : '(none)'}  [${tag}]`);
  }
  console.log('');

  const missing = plan.filter((p) => !(p.mediaPath && existsSync(p.mediaPath)));
  if (missing.length && !args.dry) {
    throw new Error(
      `${missing.length} participant(s) have no usable media file. ` +
        `Drop mp4 files in ${config.mediaDir} or set "media" per participant.`,
    );
  }

  if (args.dry) {
    // Validate token generation too — surfaces key/secret/identity issues early.
    for (const { norm } of plan) await createToken(norm, config.room);
    console.log('[dry] tokens generated OK. No connection made. Exiting.');
    return;
  }

  // Build orchestrator: pumps decode once + fan out; dummies can switch rooms.
  // Default: join existing rooms only (no ghost-room auto-create). --allow-create opts out.
  const orchestrator = new Orchestrator(plan, { requireExisting: !args.allowCreate });

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[shutdown] ${signal} — leaving ${orchestrator.dummies.length} dummies + stopping ${orchestrator.pumps.size} pumps...`);
    await orchestrator.stop();
    console.log('[shutdown] done.');
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Join the initial room (pumps start here too).
  await orchestrator.start(config.room);
  if (orchestrator.dummies.length === 0) {
    throw new Error('No dummies joined. Check LiveKit URL/keys/room.');
  }

  // HTTP control plane: POST /room {roomId} to switch at runtime.
  startControlServer(orchestrator, {});

  console.log(`\n${orchestrator.dummies.length} dummy participant(s) live in "${config.room}", streaming media. Ctrl+C to stop.`);

  // Optional auto-shutdown (smoke tests / CI).
  if (args.duration > 0) {
    console.log(`[duration] auto-leaving in ${args.duration}s...`);
    setTimeout(() => shutdown(`duration ${args.duration}s`), args.duration * 1000);
  }
}

main().catch((err) => {
  console.error('FATAL:', err?.message || err);
  process.exit(1);
});
