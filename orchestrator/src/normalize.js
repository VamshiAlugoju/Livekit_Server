// Map a raw participant record (your DB shape) -> what a dummy needs.
//
// Parity with REAL participants (cb-backend-nest livekit-calls.service.ts):
//   - identity  = random uuid (real uses Participant.participantId = uuid())
//   - metadata  = JSON.stringify({ userId, name, username, image })
//   - token carries NO `name` field (real doesn't either; UI reads metadata.name)
//
// Frontend cannot distinguish real vs synthetic: same identity shape, same
// metadata shape.
import { randomUUID } from 'node:crypto';

/**
 * @param {object} record raw record, e.g. { userId, name, username, image, media? }
 * @returns {{ identity:string, name:string|undefined, metadata:string, media:string|undefined }}
 */
export function normalizeParticipant(record) {
  if (!record || typeof record !== 'object') {
    throw new Error('participant record must be an object');
  }

  // Explicit identity/participantId wins; else mimic real uuid identity.
  const identity = record.identity || record.participantId || randomUUID();

  // If caller supplied metadata, respect it; else build the real-participant shape.
  const metadata =
    record.metadata != null
      ? typeof record.metadata === 'string'
        ? record.metadata
        : JSON.stringify(record.metadata)
      : JSON.stringify({
          userId: record.userId ?? null,
          name: record.name ?? null,
          username: record.username ?? null,
          image: record.image ?? null,
        });

  return { identity, name: record.name, metadata, media: record.media };
}
