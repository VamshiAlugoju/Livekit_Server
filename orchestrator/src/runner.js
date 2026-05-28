// Orchestrator: owns the pumps + the live set of dummies, and supports
// switching every dummy to a new room at runtime.
//
// Pumps are created once per unique media file and keep decoding across room
// switches — switching only disconnects/reconnects the LiveKit clients, it does
// NOT re-decode media. switchRoom() is serialized so overlapping requests can't
// interleave joins/leaves.
import { DummyParticipant } from './dummy.js';
import { MediaPump } from './media-pump.js';
import { roomExists } from './room-admin.js';
import { config } from '../config.js';

export class Orchestrator {
  /**
   * @param {Array<{norm:object, mediaPath:string}>} plan normalized participants + resolved media
   * @param {{ requireExisting?:boolean }} [opts] when requireExisting (default true),
   *   refuse to join a room that doesn't already exist (no ghost-room auto-create).
   */
  constructor(plan, opts = {}) {
    this.plan = plan;
    this.requireExisting = opts.requireExisting !== false;
    /** @type {Map<string, MediaPump>} */
    this.pumps = new Map();
    /** @type {DummyParticipant[]} */
    this.dummies = [];
    this.room = null;
    this.switching = false;
    this._lock = Promise.resolve(); // serializes switchRoom/leaveAll
  }

  _getPump(mediaPath) {
    let pump = this.pumps.get(mediaPath);
    if (!pump) {
      pump = new MediaPump(mediaPath, { video: config.video, audio: config.audio });
      this.pumps.set(mediaPath, pump);
    }
    return pump;
  }

  // Create + start one pump per unique media file. Idempotent.
  startPumps() {
    for (const { mediaPath } of this.plan) this._getPump(mediaPath);
    for (const pump of this.pumps.values()) pump.start();
  }

  // Throw a 404-tagged error if the room must exist but doesn't.
  async _assertRoom(room) {
    if (!this.requireExisting) return;
    if (!(await roomExists(room))) {
      throw Object.assign(new Error(`room "${room}" does not exist (join-existing-only mode)`), {
        statusCode: 404,
      });
    }
  }

  // Connect every planned dummy into `room` and wire its sources to the pump.
  async _joinAll(room) {
    this.room = room;
    for (const { norm, mediaPath } of this.plan) {
      const dummy = new DummyParticipant(norm);
      try {
        const sources = await dummy.join(room);
        this.dummies.push(dummy);
        this._getPump(mediaPath).addSubscriber(sources);
      } catch (err) {
        console.error(`[dummy:${norm.name || norm.identity}] join failed:`, err?.message || err);
      }
    }
  }

  // Disconnect all dummies and detach their sources from the pumps.
  async _leaveAll() {
    const leaving = this.dummies;
    this.dummies = [];
    for (const pump of this.pumps.values()) pump.clearSubscribers();
    await Promise.all(leaving.map((d) => d.leave()));
  }

  // Run `fn` exclusively (serialize switches/shutdown).
  _serialize(fn) {
    const next = this._lock.then(fn, fn);
    // Swallow rejection on the lock chain; callers still see fn's result.
    this._lock = next.then(
      () => {},
      () => {},
    );
    return next;
  }

  async start(room) {
    await this._assertRoom(room); // fail before spawning pumps if room missing
    this.startPumps();
    await this._serialize(() => this._joinAll(room));
    return this.status();
  }

  async switchRoom(newRoom) {
    if (!newRoom || typeof newRoom !== 'string') {
      throw Object.assign(new Error('roomId must be a non-empty string'), { statusCode: 400 });
    }
    // Verify the target exists BEFORE leaving the current room — a bad switch
    // must not strand the dummies in no room.
    await this._assertRoom(newRoom);
    return this._serialize(async () => {
      const from = this.room;
      this.switching = true;
      console.log(`[switch] ${from || '(none)'} -> ${newRoom} : leaving ${this.dummies.length} dummies...`);
      await this._leaveAll();
      await this._joinAll(newRoom);
      this.switching = false;
      console.log(`[switch] now in "${newRoom}" with ${this.dummies.length} dummies.`);
      return this.status();
    });
  }

  async stop() {
    await Promise.all([...this.pumps.values()].map((p) => p.stop()));
    await this._serialize(() => this._leaveAll());
  }

  status() {
    return {
      room: this.room,
      switching: this.switching,
      count: this.dummies.length,
      planned: this.plan.length,
      dummies: this.dummies.map((d) => ({ identity: d.identity, name: d.normalized.name })),
    };
  }
}
