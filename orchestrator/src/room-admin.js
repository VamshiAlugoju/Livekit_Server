// LiveKit admin helpers (server SDK). Used to verify a room already exists
// before dummies join — otherwise a wrong/early roomId would auto-create an
// empty ghost room.
import { RoomServiceClient } from 'livekit-server-sdk';
import { config } from '../config.js';

let client;
function svc() {
  if (!client) {
    const httpUrl = config.url.replace('wss://', 'https://').replace('ws://', 'http://');
    client = new RoomServiceClient(httpUrl, config.apiKey, config.apiSecret);
  }
  return client;
}

/**
 * @param {string} name room name
 * @returns {Promise<boolean>} true if the room currently exists on the server
 */
export async function roomExists(name) {
  const rooms = await svc().listRooms([name]);
  return rooms.some((r) => r.name === name);
}
