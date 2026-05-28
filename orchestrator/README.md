# Dummy Participant Orchestrator

Lightweight Node.js service that spawns **synthetic LiveKit participants** which
publish prerecorded MP4 media. To the React Native clients they are
indistinguishable from real remote users — they appear in
`room.remoteParticipants`, participant lists, video grids, and active-speaker
lists like any standard LiveKit user.

No browsers, no Puppeteer/Selenium, no emulators. Just Node + ffmpeg.

## How it works

```
participants.json ──▶ orchestrator ──▶ N DummyParticipants ──▶ LiveKit Room
                          │                                        ▲
                          └── MediaPump (ffmpeg) ─ decode once ─────┘
                              fan I420 video + s16le audio to all sources
```

1. **Load** participant array (`participants.json`).
2. **Resolve** a media file per participant (explicit `media` field, else round-robin over `media/`).
3. **Spawn**: each participant gets a unique identity + metadata baked into its token, connects as a real LiveKit client (`@livekit/rtc-node`), and publishes a camera + mic track.
4. **Publish**: a `MediaPump` decodes each unique clip *once* with ffmpeg and fans the raw frames out to every dummy that shares it (CPU win at scale).

- `autoSubscribe: false` / `canSubscribe: false` — dummies only publish, never receive.
- Audio carries real PCM energy, so dummies show up in active-speaker lists.

## Setup

```bash
cd livekit/orchestrator
npm install            # already done; pulls @livekit/rtc-node, livekit-server-sdk, ffmpeg-static
```

Drop one or more `.mp4` files into `media/` (or set `media` per participant).

## Run

```bash
# validate config + tokens + media without connecting
npm run dry

# launch
node src/orchestrator.js --room <roomId> --participants ./participants.json
```

Ctrl+C leaves all dummies and stops ffmpeg cleanly.

## Runtime room switch (HTTP control plane)

The orchestrator joins `--room` at launch, then exposes a tiny HTTP API so you can
move every dummy into a different room **without restarting** — useful when the
backend creates the call room dynamically. Switching disconnects + reconnects the
LiveKit clients with new tokens; the ffmpeg pumps keep decoding (no re-decode),
and identities are preserved across the switch.

```
GET  /health            -> { "ok": true }
GET  /status            -> { room, switching, count, planned, dummies:[{identity,name}] }
POST /room  {"roomId"}  -> rejoins all dummies into roomId, returns new status
                           404 if the room doesn't exist (join-existing-only)
```

```bash
curl localhost:8788/status
curl -X POST localhost:8788/room -H 'Content-Type: application/json' -d '{"roomId":"call-123"}'
```

- Binds `127.0.0.1:8788` by default. Env: `CONTROL_PORT`, `CONTROL_HOST`.
- **No auth.** Only set `CONTROL_HOST=0.0.0.0` (to let the backend on another host drive it) on a trusted network.

### Flags

| Flag | Meaning | Default |
|------|---------|---------|
| `--room <name>` | LiveKit room to join | `dummy-room` (or `LIVEKIT_ROOM`) |
| `--participants <path>` | JSON array of participants | `./participants.json` |
| `--media-dir <dir>` | Folder of mp4 clips | `./media` |
| `--count <n>` | Cap number of dummies | all |
| `--url <ws url>` | LiveKit ws/wss URL | from backend `.env` |
| `--duration <sec>` | Auto-leave after N seconds (smoke test) | off (run forever) |
| `--allow-create` | Permit joining/creating non-existent rooms | off (join existing only) |
| `--dry` | Validate only, no connection | off |

### Env — shared with cb-backend-nest

`config.js` loads `cb-backend-nest/.env` (override path with `CB_BACKEND_ENV`), so
the LiveKit **URL** stays in sync with the backend (`LIVEKIT_CLIENT_URL` /
`LIVEKIT_SERVER_URL`).

**Keys:** `apiKey`/`apiSecret` are hardcoded to `devkey`/`secret` — mirroring
`LiveKitService`, which ignores `LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET` (those are
placeholders). The server authenticates with `devkey`/`secret`.

Other overridable env: `LIVEKIT_ROOM`, `MAX_DUMMIES`, `MEDIA_DIR`, `VIDEO_WIDTH`,
`VIDEO_HEIGHT`, `VIDEO_FPS`, `VIDEO_SIMULCAST` (default on; `false` = single layer,
~half the encode cost), `VIDEO_CODEC` (`vp8`|`h264`|`vp9`|`av1`|`h265`, default
`h264` for RN parity), `AUDIO_RATE`, `AUDIO_CHANNELS`, `AUDIO_FRAME_MS`.

## participants.json

Array of records in your DB shape (see `participants.sample.json`):

```json
[
  { "userId": "6964d3757894ba2eda2ba9eb", "name": "Gnana Kumar",
    "username": "Kumar", "image": "https://.../x.jpg" }
]
```

Each record is **normalized to match real participants exactly** (see
`cb-backend-nest` `livekit-calls.service.ts`):

- **identity** = random uuid — real participants use `Participant.participantId = uuid()`. Frontend never keys off identity, so dummies are indistinguishable. (Override with an explicit `identity`/`participantId` field if you want.)
- **metadata** = `JSON.stringify({ userId, name, username, image })` — the same shape real participants carry. The client reads `participant.metadata` for name/username/avatar.
- Token carries **no `name`** field (real doesn't either).
- `media` *(optional)* — clip filename in `media/` or absolute path. Omit to round-robin the `media/` pool.

> Cap: max **8** dummies (`config.maxDummies`, env `MAX_DUMMIES`). 2 real + 8 dummy = 10 = room `maxParticipants`. Extra records in the file are dropped with a `[cap]` log.

## Join-existing-only

By default the orchestrator **only joins a room that already exists** — it checks
`RoomServiceClient.listRooms` before connecting. This prevents a wrong or early
`roomId` from auto-creating an empty ghost room (LiveKit auto-creates rooms on
join otherwise).

- Startup with a missing `--room` → exits with `room "<x>" does not exist`.
- `POST /room` with a missing room → `404`, dummies stay in their current room (the check runs *before* leaving, so a bad switch never strands them).
- Pass `--allow-create` to opt out (let dummies create the room).

Typical flow: a real call starts → backend creates the room → backend (or you)
`POST /room {roomId}` → dummies populate that existing call.

## Gotchas

- **Room cap:** `cb-backend-nest` `LiveKitService.createRoom` sets `maxParticipants: 10`. 2 real + 8 dummy = 10 fits exactly — don't add a 9th dummy without bumping it.
- **CPU:** each unique clip = one ffmpeg decode. Reuse clips across dummies to keep it cheap. Distinct clips per dummy = N decodes.
- **Format:** frames are forced to the configured size, so source clips of any resolution work.
