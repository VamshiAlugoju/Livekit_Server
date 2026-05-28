// Generate a LiveKit access token for a dummy participant.
// Mirrors cb-backend-nest LiveKitService.generateToken: identity + metadata only
// (no `name`), so dummies are indistinguishable from real participants.
// Dummies only publish, never subscribe (canSubscribe:false keeps them lean).
import { AccessToken } from 'livekit-server-sdk';
import { config } from '../config.js';

/**
 * @param {{ identity:string, metadata:string }} normalized from normalizeParticipant()
 * @param {string} room room name
 * @returns {Promise<string>} signed JWT
 */
export async function createToken({ identity, metadata }, room) {
  if (!identity) throw new Error('participant identity is required');

  const at = new AccessToken(config.apiKey, config.apiSecret, {
    identity,
    metadata,
  });

  at.addGrant({
    room,
    roomJoin: true,
    canPublish: true,
    canPublishData: true,
    canSubscribe: false, // dummies don't need to receive others' media
  });

  return at.toJwt();
}
