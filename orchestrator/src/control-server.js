// Tiny HTTP control plane for the orchestrator (Node built-in http, no deps).
//
//   GET  /health        -> { ok: true }
//   GET  /status        -> current room + dummy list
//   POST /room          -> body { "roomId": "..." } : rejoin all dummies into roomId
//
// Bind host defaults to 127.0.0.1 (loopback only). Set CONTROL_HOST=0.0.0.0 to
// expose it (e.g. so the backend on another host can drive it) — there's no auth,
// so only do that on a trusted network.
import { createServer } from 'node:http';

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(json);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) reject(new Error('body too large')); // guard
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

/**
 * @param {import('./runner.js').Orchestrator} orchestrator
 * @param {{ port?:number, host?:string }} opts
 * @returns {import('node:http').Server}
 */
export function startControlServer(orchestrator, { port, host } = {}) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');

      if (req.method === 'GET' && url.pathname === '/health') {
        return send(res, 200, { ok: true });
      }

      if (req.method === 'GET' && url.pathname === '/status') {
        return send(res, 200, orchestrator.status());
      }

      if (req.method === 'POST' && url.pathname === '/room') {
        const raw = await readBody(req);
        let roomId;
        try {
          roomId = JSON.parse(raw || '{}').roomId;
        } catch {
          return send(res, 400, { error: 'invalid JSON body' });
        }
        if (!roomId) return send(res, 400, { error: 'roomId is required' });
        const status = await orchestrator.switchRoom(roomId);
        return send(res, 200, { switched: true, ...status });
      }

      return send(res, 404, { error: 'not found' });
    } catch (err) {
      // Honor typed errors (e.g. 404 room-not-found, 400 bad roomId).
      return send(res, err?.statusCode || 500, { error: err?.message || String(err) });
    }
  });

  const p = port || Number(process.env.CONTROL_PORT) || 8788;
  const h = host || process.env.CONTROL_HOST || '127.0.0.1';
  server.listen(p, h, () => {
    console.log(`[control] HTTP listening on http://${h}:${p}  (GET /status, POST /room {roomId})`);
  });
  return server;
}
