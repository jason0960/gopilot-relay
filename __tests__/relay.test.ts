/**
 * Relay Server — integration tests
 *
 * Imports the ACTUAL production createRelayServer() factory and tests it
 * on a random port. No reimplementation — every line of coverage hits
 * the real relay-server/src/index.ts code.
 *
 * Covers:
 * - Health endpoint
 * - /rooms endpoint (disabled → 403)
 * - Room creation via /relay/host
 * - Client join via /relay/join?code=XXXX
 * - Message forwarding: host→client, client→host
 * - Host rejoin via /relay/rejoin
 * - Host disconnect notification to clients
 * - Client disconnect notification to host
 * - Invalid room code handling
 * - Unknown path rejection
 * - Server capacity limits
 */
import WebSocket from 'ws';
import {
  createRelayServer,
  generateRoomCode,
  RelayServerInstance,
  Room,
  DEFAULT_MAX_MESSAGE_SIZE,
  DEFAULT_RATE_LIMIT_MAX,
  DEFAULT_RATE_LIMIT_WINDOW_MS,
  DEFAULT_MAX_CLIENTS_PER_ROOM,
  DEFAULT_MAX_CONNECTIONS_PER_IP,
  DEFAULT_CONNECTION_RATE_WINDOW_MS,
} from '../src/index';

// ─── Test Helpers ───────────────────────────────────────────────

/** Buffered WebSocket wrapper — queues messages received before waitForMessage is called */
interface BufferedWs {
  ws: WebSocket;
  messages: any[];
  waitForMessage(timeout?: number): Promise<any>;
}

function connectWs(port: number, path: string): Promise<BufferedWs> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    const messages: any[] = [];
    const waiters: Array<(msg: any) => void> = [];

    ws.on('message', (data) => {
      const parsed = JSON.parse(data.toString());
      if (waiters.length > 0) {
        waiters.shift()!(parsed);
      } else {
        messages.push(parsed);
      }
    });

    const buffered: BufferedWs = {
      ws,
      messages,
      waitForMessage(timeout = 5000): Promise<any> {
        if (messages.length > 0) {
          return Promise.resolve(messages.shift()!);
        }
        return new Promise((res, rej) => {
          const timer = setTimeout(() => rej(new Error('Timeout waiting for message')), timeout);
          waiters.push((msg) => {
            clearTimeout(timer);
            res(msg);
          });
        });
      },
    };

    ws.once('open', () => resolve(buffered));
    ws.once('error', reject);
  });
}

function waitForClose(ws: WebSocket, timeout = 5000): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout waiting for close')), timeout);
    ws.once('close', (code: number, reason: Buffer) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString() });
    });
  });
}

// ─── Tests ──────────────────────────────────────────────────────

describe('Relay Server (production code)', () => {
  let relay: RelayServerInstance;
  let port: number;
  let openSockets: WebSocket[] = [];

  beforeAll(async () => {
    relay = createRelayServer({
      port: 0,             // random port — no collisions
      maxRooms: 5,         // low cap for capacity tests
      heartbeatIntervalMs: 60_000, // slow heartbeat so it doesn't interfere
      maxConnectionsPerIp: 200,    // generous — many tests create connections
    });
    port = await relay.start();
  });

  afterEach(() => {
    for (const ws of openSockets) {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    }
    openSockets = [];
    // Clear rooms between tests to avoid MAX_ROOMS cap
    relay.rooms.clear();
    relay.pairings.clear();
  });

  afterAll(async () => {
    await relay.stop();
  });

  function track(b: BufferedWs): BufferedWs {
    openSockets.push(b.ws);
    return b;
  }

  // ─── HTTP Endpoints ─────────────────────────────────────────

  describe('HTTP endpoints', () => {
    it('GET /health returns status ok and room count', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      const body: any = await res.json();
      expect(res.status).toBe(200);
      expect(body.status).toBe('ok');
      expect(typeof body.rooms).toBe('number');
    });

    it('GET /rooms returns 404 (endpoint removed)', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/rooms`);
      expect(res.status).toBe(404);
    });

    it('GET /unknown returns 404', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/nope`);
      expect(res.status).toBe(404);
    });

    it('OPTIONS returns 204 (CORS preflight)', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { method: 'OPTIONS' });
      expect(res.status).toBe(204);
    });
  });

  // ─── Pairing Exchange ───────────────────────────────────────

  describe('pairing exchange', () => {
    const samplePairing = {
      projectId: 'test-project',
      topicName: 'TestTopic',
      mobileSubscription: 'mobile-sub',
      extensionSubscription: 'ext-sub',
      userId: 'ext-abc123',
      accessToken: 'fake-token-123',
      tokenExpiry: Date.now() + 3_600_000,
    };

    it('POST /pair deposits data and returns a room code', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(samplePairing),
      });
      expect(res.status).toBe(201);
      const body: any = await res.json();
      expect(body.code).toMatch(/^[A-Z0-9]{6}$/);
      expect(relay.pairings.has(body.code)).toBe(true);
    });

    it('GET /pair/:code returns pairing data and deletes it (one-time use)', async () => {
      // Deposit
      const postRes = await fetch(`http://127.0.0.1:${port}/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(samplePairing),
      });
      const { code } = await postRes.json() as { code: string };

      // Fetch
      const getRes = await fetch(`http://127.0.0.1:${port}/pair/${code}`);
      expect(getRes.status).toBe(200);
      const data: any = await getRes.json();
      expect(data.projectId).toBe('test-project');
      expect(data.accessToken).toBe('fake-token-123');

      // Second fetch should 404 (one-time use)
      const getRes2 = await fetch(`http://127.0.0.1:${port}/pair/${code}`);
      expect(getRes2.status).toBe(404);
    });

    it('GET /pair/:code with unknown code returns 404', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/pair/ZZZZZZ`);
      expect(res.status).toBe(404);
      const body: any = await res.json();
      expect(body.error).toContain('not found');
    });

    it('POST /pair with invalid JSON returns 400', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json',
      });
      expect(res.status).toBe(400);
    });

    it('POST /pair with non-object body returns 400', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify('just a string'),
      });
      expect(res.status).toBe(400);
    });

    it('pairing codes are case-insensitive on fetch', async () => {
      const postRes = await fetch(`http://127.0.0.1:${port}/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(samplePairing),
      });
      const { code } = await postRes.json() as { code: string };

      // Fetch with lowercase
      const getRes = await fetch(`http://127.0.0.1:${port}/pair/${code.toLowerCase()}`);
      expect(getRes.status).toBe(200);
    });

    it('pairing code does not collide with room codes', async () => {
      // Create a WS room
      const host = track(await connectWs(port, '/relay/host'));
      const roomMsg = await host.waitForMessage();
      const roomCode = roomMsg.code;

      // Create a pairing — should get a different code
      const postRes = await fetch(`http://127.0.0.1:${port}/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(samplePairing),
      });
      const { code: pairingCode } = await postRes.json() as { code: string };
      expect(pairingCode).not.toBe(roomCode);
    });

    it('CORS headers are present on pairing responses', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(samplePairing),
      });
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
    });
  });

  // ─── Room Creation ────────────────────────────────────────────

  describe('room creation', () => {
    it('host receives room_created with code and hostSecret', async () => {
      const host = track(await connectWs(port, '/relay/host'));
      const msg = await host.waitForMessage();

      expect(msg.type).toBe('relay.room_created');
      expect(msg.code).toMatch(/^[A-Z0-9]{6}$/);
      expect(msg.hostSecret).toMatch(/^[a-f0-9]{32}$/);
    });

    it('room code uses only safe characters (no 0/O/1/I)', async () => {
      const host = track(await connectWs(port, '/relay/host'));
      const msg = await host.waitForMessage();
      expect(msg.code).not.toMatch(/[01OI]/);
    });

    it('room actually exists in server state after creation', async () => {
      const host = track(await connectWs(port, '/relay/host'));
      const msg = await host.waitForMessage();
      expect(relay.rooms.has(msg.code)).toBe(true);
      const room = relay.rooms.get(msg.code)!;
      expect(room.hostSecret).toBe(msg.hostSecret);
      expect(room.clients.size).toBe(0);
    });

    it('rejects host when server at capacity', async () => {
      // Fill up to maxRooms (5)
      for (let i = 0; i < 5; i++) {
        const h = track(await connectWs(port, '/relay/host'));
        await h.waitForMessage();
      }

      // 6th should be rejected
      const ws = new WebSocket(`ws://127.0.0.1:${port}/relay/host`);
      openSockets.push(ws);
      const { code } = await waitForClose(ws);
      expect(code).toBe(4010);
    });
  });

  // ─── Client Join ──────────────────────────────────────────────

  describe('client join', () => {
    it('client receives relay.joined with hostConnected=true', async () => {
      const host = track(await connectWs(port, '/relay/host'));
      const created = await host.waitForMessage();

      const client = track(await connectWs(port, `/relay/join?code=${created.code}`));
      const joined = await client.waitForMessage();

      expect(joined.type).toBe('relay.joined');
      expect(joined.code).toBe(created.code);
      expect(joined.hostConnected).toBe(true);
    });

    it('host receives relay.client_joined', async () => {
      const host = track(await connectWs(port, '/relay/host'));
      const created = await host.waitForMessage();

      const client = track(await connectWs(port, `/relay/join?code=${created.code}`));
      await client.waitForMessage(); // consume relay.joined

      const notification = await host.waitForMessage();
      expect(notification.type).toBe('relay.client_joined');
      expect(notification.clientCount).toBe(1);
    });

    it('invalid code closes with 4004', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/relay/join?code=ZZZZZZ`);
      openSockets.push(ws);
      const { code } = await waitForClose(ws);
      expect(code).toBe(4004);
    });
  });

  // ─── Message Forwarding ───────────────────────────────────────

  describe('message forwarding', () => {
    it('forwards host messages to clients', async () => {
      const host = track(await connectWs(port, '/relay/host'));
      const created = await host.waitForMessage();

      const client = track(await connectWs(port, `/relay/join?code=${created.code}`));
      await client.waitForMessage(); // relay.joined
      await host.waitForMessage(); // relay.client_joined

      host.ws.send(JSON.stringify({ type: 'request', id: 'test-1', method: 'chat.response' }));

      const received = await client.waitForMessage();
      expect(received.type).toBe('request');
      expect(received.id).toBe('test-1');
      expect(received.method).toBe('chat.response');
    });

    it('forwards client messages to host', async () => {
      const host = track(await connectWs(port, '/relay/host'));
      const created = await host.waitForMessage();

      const client = track(await connectWs(port, `/relay/join?code=${created.code}`));
      await client.waitForMessage(); // relay.joined
      await host.waitForMessage(); // relay.client_joined

      client.ws.send(JSON.stringify({ type: 'request', id: 'c-1', method: 'chat.send' }));

      const received = await host.waitForMessage();
      expect(received.type).toBe('request');
      expect(received.id).toBe('c-1');
    });

    it('host _relayTarget message is forwarded to all clients', async () => {
      const host = track(await connectWs(port, '/relay/host'));
      const created = await host.waitForMessage();

      const client = track(await connectWs(port, `/relay/join?code=${created.code}`));
      await client.waitForMessage(); // relay.joined
      await host.waitForMessage(); // relay.client_joined

      host.ws.send(JSON.stringify({ _relayTarget: 'broadcast', data: 'hello' }));

      const received = await client.waitForMessage();
      expect(received._relayTarget).toBe('broadcast');
      expect(received.data).toBe('hello');
    });

    it('client messages when host unavailable are dropped gracefully', async () => {
      const host = track(await connectWs(port, '/relay/host'));
      const created = await host.waitForMessage();

      const client = track(await connectWs(port, `/relay/join?code=${created.code}`));
      await client.waitForMessage(); // relay.joined
      await host.waitForMessage(); // relay.client_joined

      // Disconnect host
      const closeP = new Promise<void>(r => host.ws.once('close', () => r()));
      host.ws.close();
      await closeP;

      await client.waitForMessage(); // relay.host_disconnected

      // Client sends — should not throw
      client.ws.send(JSON.stringify({ type: 'request', id: 'orphan' }));
      // Give it a moment to process without crashing
      await new Promise(r => setTimeout(r, 100));
      // Server still alive — check health
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.status).toBe(200);
    }, 10000);
  });

  // ─── Host Disconnect / Rejoin ─────────────────────────────────

  describe('host disconnect', () => {
    it('clients receive relay.host_disconnected when host leaves', async () => {
      const host = track(await connectWs(port, '/relay/host'));
      const created = await host.waitForMessage();

      const client = track(await connectWs(port, `/relay/join?code=${created.code}`));
      await client.waitForMessage(); // relay.joined
      await host.waitForMessage(); // relay.client_joined

      const closeP = new Promise<void>(r => host.ws.once('close', () => r()));
      host.ws.close();
      await closeP;

      const notification = await client.waitForMessage();
      expect(notification.method).toBe('relay.host_disconnected');
    }, 10000);
  });

  describe('host rejoin', () => {
    it('host can rejoin with secret and clients are notified', async () => {
      const host = track(await connectWs(port, '/relay/host'));
      const created = await host.waitForMessage();
      const { code, hostSecret } = created;

      const client = track(await connectWs(port, `/relay/join?code=${code}`));
      await client.waitForMessage(); // relay.joined
      await host.waitForMessage(); // relay.client_joined

      const closeP = new Promise<void>(r => host.ws.once('close', () => r()));
      host.ws.close();
      await closeP;

      await client.waitForMessage(); // relay.host_disconnected

      const newHost = track(await connectWs(port, `/relay/rejoin?code=${code}&secret=${hostSecret}`));
      const rejoined = await newHost.waitForMessage();
      expect(rejoined.type).toBe('relay.rejoined');
      expect(rejoined.code).toBe(code);
      expect(rejoined.clientCount).toBe(1);

      const reconnected = await client.waitForMessage();
      expect(reconnected.method).toBe('relay.host_reconnected');
    }, 10000);

    it('rejoin with wrong secret closes with 4004', async () => {
      const host = track(await connectWs(port, '/relay/host'));
      const created = await host.waitForMessage();

      const badWs = new WebSocket(
        `ws://127.0.0.1:${port}/relay/rejoin?code=${created.code}&secret=wrong`,
      );
      openSockets.push(badWs);
      const { code: closeCode } = await waitForClose(badWs);
      expect(closeCode).toBe(4004);
    }, 10000);

    it('rejoin replaces old host connection', async () => {
      const host = track(await connectWs(port, '/relay/host'));
      const created = await host.waitForMessage();
      const { code, hostSecret } = created;

      // Rejoin while old host is still connected — old host gets closed with 4009
      const hostCloseP = waitForClose(host.ws);
      const newHost = track(await connectWs(port, `/relay/rejoin?code=${code}&secret=${hostSecret}`));
      const rejoined = await newHost.waitForMessage();
      expect(rejoined.type).toBe('relay.rejoined');

      const { code: oldCloseCode } = await hostCloseP;
      expect(oldCloseCode).toBe(4009);
    }, 10000);

    it('message forwarding works after rejoin', async () => {
      const host = track(await connectWs(port, '/relay/host'));
      const created = await host.waitForMessage();
      const { code, hostSecret } = created;

      const client = track(await connectWs(port, `/relay/join?code=${code}`));
      await client.waitForMessage(); // relay.joined
      await host.waitForMessage(); // relay.client_joined

      // Disconnect original host
      const closeP = new Promise<void>(r => host.ws.once('close', () => r()));
      host.ws.close();
      await closeP;
      await client.waitForMessage(); // relay.host_disconnected

      // Rejoin
      const newHost = track(await connectWs(port, `/relay/rejoin?code=${code}&secret=${hostSecret}`));
      await newHost.waitForMessage(); // relay.rejoined
      await client.waitForMessage(); // relay.host_reconnected

      // New host sends message → client receives
      newHost.ws.send(JSON.stringify({ type: 'test', id: 'after-rejoin' }));
      const received = await client.waitForMessage();
      expect(received.type).toBe('test');
      expect(received.id).toBe('after-rejoin');
    }, 10000);
  });

  // ─── Client Disconnect ───────────────────────────────────────

  describe('client disconnect', () => {
    it('host receives relay.client_left when client leaves', async () => {
      const host = track(await connectWs(port, '/relay/host'));
      const created = await host.waitForMessage();

      const client = track(await connectWs(port, `/relay/join?code=${created.code}`));
      await client.waitForMessage(); // relay.joined
      await host.waitForMessage(); // relay.client_joined

      const closeP2 = new Promise<void>(r => client.ws.once('close', () => r()));
      client.ws.close();
      await closeP2;

      const notification = await host.waitForMessage();
      expect(notification.type).toBe('relay.client_left');
      expect(notification.clientCount).toBe(0);
    }, 10000);
  });

  // ─── Unknown Path ─────────────────────────────────────────────

  describe('unknown WS path', () => {
    it('closes with 4000', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/bad/path`);
      openSockets.push(ws);
      const { code } = await waitForClose(ws);
      expect(code).toBe(4000);
    });
  });

  // ─── Room Code Generation (using production export) ──────────

  describe('generateRoomCode', () => {
    it('generates 6-char codes from safe alphabet', () => {
      const testRooms = new Map<string, Room>();
      for (let i = 0; i < 50; i++) {
        const code = generateRoomCode(testRooms);
        expect(code).toHaveLength(6);
        expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
      }
    });

    it('avoids collisions', () => {
      const testRooms = new Map<string, Room>();
      const codes = new Set<string>();
      for (let i = 0; i < 20; i++) {
        const code = generateRoomCode(testRooms);
        codes.add(code);
        testRooms.set(code, {} as Room);
      }
      expect(codes.size).toBe(20);
    });
  });
});

// ─── DoS Protection Tests ───────────────────────────────────────
// Uses a separate server instance with aggressive limits so tests
// run quickly and deterministically.

describe('Relay Server DoS Protections', () => {
  let relay: RelayServerInstance;
  let port: number;
  let openSockets: WebSocket[] = [];

  // Very tight limits for testing
  const MAX_MSG_SIZE = 256;           // 256 bytes
  const RATE_MAX = 5;                 // 5 messages per window
  const RATE_WINDOW = 10_000;         // 10s window
  const MAX_CLIENTS = 2;             // 2 clients per room
  const MAX_CONN_PER_IP = 30;         // generous — mostly testing message limits
  const CONN_RATE_WINDOW = 60_000;

  beforeAll(async () => {
    relay = createRelayServer({
      port: 0,
      maxRooms: 100,
      heartbeatIntervalMs: 60_000,
      maxMessageSize: MAX_MSG_SIZE,
      rateLimitMax: RATE_MAX,
      rateLimitWindowMs: RATE_WINDOW,
      maxClientsPerRoom: MAX_CLIENTS,
      maxConnectionsPerIp: MAX_CONN_PER_IP,
      connectionRateWindowMs: CONN_RATE_WINDOW,
    });
    port = await relay.start();
  });

  afterEach(() => {
    for (const ws of openSockets) {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    }
    openSockets = [];
    relay.rooms.clear();
  });

  afterAll(async () => {
    await relay.stop();
  });

  function track(b: BufferedWs): BufferedWs {
    openSockets.push(b.ws);
    return b;
  }

  // ─── Exported Constants ─────────────────────────────────────

  describe('exported default constants', () => {
    it('DEFAULT_MAX_MESSAGE_SIZE is 1 MB', () => {
      expect(DEFAULT_MAX_MESSAGE_SIZE).toBe(1 * 1024 * 1024);
    });

    it('DEFAULT_RATE_LIMIT_MAX is 60', () => {
      expect(DEFAULT_RATE_LIMIT_MAX).toBe(60);
    });

    it('DEFAULT_RATE_LIMIT_WINDOW_MS is 10_000', () => {
      expect(DEFAULT_RATE_LIMIT_WINDOW_MS).toBe(10_000);
    });

    it('DEFAULT_MAX_CLIENTS_PER_ROOM is 10', () => {
      expect(DEFAULT_MAX_CLIENTS_PER_ROOM).toBe(10);
    });

    it('DEFAULT_MAX_CONNECTIONS_PER_IP is 20', () => {
      expect(DEFAULT_MAX_CONNECTIONS_PER_IP).toBe(20);
    });

    it('DEFAULT_CONNECTION_RATE_WINDOW_MS is 60_000', () => {
      expect(DEFAULT_CONNECTION_RATE_WINDOW_MS).toBe(60_000);
    });
  });

  // ─── Message Size Limits ────────────────────────────────────

  describe('message size limits', () => {
    it('host message under limit is forwarded normally', async () => {
      const host = track(await connectWs(port, '/relay/host'));
      const created = await host.waitForMessage();

      const client = track(await connectWs(port, `/relay/join?code=${created.code}`));
      await client.waitForMessage(); // relay.joined
      await host.waitForMessage(); // relay.client_joined

      const smallMsg = JSON.stringify({ type: 'test', data: 'ok' });
      host.ws.send(smallMsg);
      const received = await client.waitForMessage();
      expect(received.type).toBe('test');
    });

    it('host oversized message closes connection with 4013', async () => {
      const host = track(await connectWs(port, '/relay/host'));
      await host.waitForMessage(); // relay.room_created

      // Send a message larger than MAX_MSG_SIZE (256 bytes)
      const oversizedMsg = 'X'.repeat(MAX_MSG_SIZE + 100);
      const closeP = waitForClose(host.ws);
      host.ws.send(oversizedMsg);
      const { code } = await closeP;
      // ws library enforces maxPayload at transport level → 1009
      // OR our app-layer check → 4013
      expect([1009, 4013]).toContain(code);
    });

    it('client oversized message closes connection', async () => {
      const host = track(await connectWs(port, '/relay/host'));
      const created = await host.waitForMessage();

      const client = track(await connectWs(port, `/relay/join?code=${created.code}`));
      await client.waitForMessage(); // relay.joined
      await host.waitForMessage(); // relay.client_joined

      const oversizedMsg = 'X'.repeat(MAX_MSG_SIZE + 100);
      const closeP = waitForClose(client.ws);
      client.ws.send(oversizedMsg);
      const { code } = await closeP;
      expect([1009, 4013]).toContain(code);
    });
  });

  // ─── Per-Socket Rate Limiting ─────────────────────────────────

  describe('per-socket rate limiting', () => {
    it('allows messages up to the rate limit', async () => {
      const host = track(await connectWs(port, '/relay/host'));
      const created = await host.waitForMessage();

      const client = track(await connectWs(port, `/relay/join?code=${created.code}`));
      await client.waitForMessage(); // relay.joined
      await host.waitForMessage(); // relay.client_joined

      // Send exactly RATE_MAX messages — all should arrive
      for (let i = 0; i < RATE_MAX; i++) {
        host.ws.send(JSON.stringify({ type: 'test', seq: i }));
      }

      for (let i = 0; i < RATE_MAX; i++) {
        const msg = await client.waitForMessage();
        expect(msg.seq).toBe(i);
      }
    });

    it('host gets error after exceeding rate limit', async () => {
      const host = track(await connectWs(port, '/relay/host'));
      const created = await host.waitForMessage();

      const client = track(await connectWs(port, `/relay/join?code=${created.code}`));
      await client.waitForMessage(); // relay.joined
      await host.waitForMessage(); // relay.client_joined

      // Exhaust the rate limit
      for (let i = 0; i < RATE_MAX; i++) {
        host.ws.send(JSON.stringify({ type: 'test', seq: i }));
      }

      // Drain forwarded messages from client
      for (let i = 0; i < RATE_MAX; i++) {
        await client.waitForMessage();
      }

      // Next message should be rate-limited — host gets error back
      host.ws.send(JSON.stringify({ type: 'test', seq: 'over-limit' }));
      const errorMsg = await host.waitForMessage();
      expect(errorMsg.type).toBe('error');
      expect(errorMsg.code).toBe(4029);
      expect(errorMsg.message).toBe('Rate limit exceeded');
    });

    it('client gets error after exceeding rate limit', async () => {
      const host = track(await connectWs(port, '/relay/host'));
      const created = await host.waitForMessage();

      const client = track(await connectWs(port, `/relay/join?code=${created.code}`));
      await client.waitForMessage(); // relay.joined
      await host.waitForMessage(); // relay.client_joined

      // Exhaust the rate limit
      for (let i = 0; i < RATE_MAX; i++) {
        client.ws.send(JSON.stringify({ type: 'test', seq: i }));
      }

      // Drain forwarded messages from host
      for (let i = 0; i < RATE_MAX; i++) {
        await host.waitForMessage();
      }

      // Next message should be rate-limited
      client.ws.send(JSON.stringify({ type: 'test', seq: 'over-limit' }));
      const errorMsg = await client.waitForMessage();
      expect(errorMsg.type).toBe('error');
      expect(errorMsg.code).toBe(4029);
    });

    it('rate-limited messages are not forwarded to the other side', async () => {
      const host = track(await connectWs(port, '/relay/host'));
      const created = await host.waitForMessage();

      const client = track(await connectWs(port, `/relay/join?code=${created.code}`));
      await client.waitForMessage(); // relay.joined
      await host.waitForMessage(); // relay.client_joined

      // Exhaust rate limit
      for (let i = 0; i < RATE_MAX; i++) {
        host.ws.send(JSON.stringify({ type: 'test', seq: i }));
      }
      for (let i = 0; i < RATE_MAX; i++) {
        await client.waitForMessage();
      }

      // Send over-limit message
      host.ws.send(JSON.stringify({ type: 'test', seq: 'should-not-arrive' }));

      // Host gets rate limit error
      await host.waitForMessage();

      // Now send a legitimate message after the window would have had some room
      // We verify nothing extra arrived at client by sending a marker and checking it's next
      // Wait briefly, then send a within-limit new message
      await new Promise(r => setTimeout(r, 50));

      // Client should NOT have received the rate-limited message
      // Verify by checking the buffered messages array is empty
      expect(client.messages.length).toBe(0);
    });
  });

  // ─── Per-Room Client Cap ──────────────────────────────────────

  describe('per-room client cap', () => {
    it('allows clients up to the limit', async () => {
      const host = track(await connectWs(port, '/relay/host'));
      const created = await host.waitForMessage();

      const client1 = track(await connectWs(port, `/relay/join?code=${created.code}`));
      const joined1 = await client1.waitForMessage();
      expect(joined1.type).toBe('relay.joined');

      const client2 = track(await connectWs(port, `/relay/join?code=${created.code}`));
      const joined2 = await client2.waitForMessage();
      expect(joined2.type).toBe('relay.joined');
    });

    it('rejects client when room is full with 4011', async () => {
      const host = track(await connectWs(port, '/relay/host'));
      const created = await host.waitForMessage();

      // Fill room to MAX_CLIENTS (2)
      for (let i = 0; i < MAX_CLIENTS; i++) {
        const c = track(await connectWs(port, `/relay/join?code=${created.code}`));
        await c.waitForMessage(); // relay.joined
      }

      // 3rd client should be rejected
      const ws = new WebSocket(`ws://127.0.0.1:${port}/relay/join?code=${created.code}`);
      openSockets.push(ws);
      const { code } = await waitForClose(ws);
      expect(code).toBe(4011);
    });

    it('client can join after another leaves', async () => {
      const host = track(await connectWs(port, '/relay/host'));
      const created = await host.waitForMessage();

      const client1 = track(await connectWs(port, `/relay/join?code=${created.code}`));
      await client1.waitForMessage(); // relay.joined

      const client2 = track(await connectWs(port, `/relay/join?code=${created.code}`));
      await client2.waitForMessage(); // relay.joined

      // Room is now full — disconnect client1
      const closeP = new Promise<void>(r => client1.ws.once('close', () => r()));
      client1.ws.close();
      await closeP;

      // Give server a moment to process
      await new Promise(r => setTimeout(r, 50));

      // New client can now join
      const client3 = track(await connectWs(port, `/relay/join?code=${created.code}`));
      const joined3 = await client3.waitForMessage();
      expect(joined3.type).toBe('relay.joined');
    });
  });

  // ─── Connection Rate Limiting ─────────────────────────────────

  describe('connection rate limiting', () => {
    it('rejects connections that exceed the IP rate limit', async () => {
      // Create a separate server with very low connection rate limit
      const strictRelay = createRelayServer({
        port: 0,
        maxRooms: 100,
        heartbeatIntervalMs: 60_000,
        maxConnectionsPerIp: 3,
        connectionRateWindowMs: 60_000,
      });
      const strictPort = await strictRelay.start();

      const sockets: WebSocket[] = [];
      try {
        // 3 connections should succeed
        for (let i = 0; i < 3; i++) {
          const b = await connectWs(strictPort, '/relay/host');
          sockets.push(b.ws);
          await b.waitForMessage(); // relay.room_created
        }

        // 4th connection should be rejected with 4029
        const ws = new WebSocket(`ws://127.0.0.1:${strictPort}/relay/host`);
        sockets.push(ws);
        const { code } = await waitForClose(ws);
        expect(code).toBe(4029);
      } finally {
        for (const ws of sockets) {
          if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
            ws.close();
          }
        }
        await strictRelay.stop();
      }
    }, 15000);
  });

  // ─── Rejoin Host Rate Limiting ────────────────────────────────

  describe('rejoin host rate limiting', () => {
    it('rate limits messages from rejoined host', async () => {
      const host = track(await connectWs(port, '/relay/host'));
      const created = await host.waitForMessage();
      const { code: roomCode, hostSecret } = created;

      const client = track(await connectWs(port, `/relay/join?code=${roomCode}`));
      await client.waitForMessage(); // relay.joined
      await host.waitForMessage(); // relay.client_joined

      // Disconnect host
      const closeP = new Promise<void>(r => host.ws.once('close', () => r()));
      host.ws.close();
      await closeP;
      await client.waitForMessage(); // relay.host_disconnected

      // Rejoin
      const newHost = track(await connectWs(port, `/relay/rejoin?code=${roomCode}&secret=${hostSecret}`));
      await newHost.waitForMessage(); // relay.rejoined
      await client.waitForMessage(); // relay.host_reconnected

      // Exhaust rate limit on new host
      for (let i = 0; i < RATE_MAX; i++) {
        newHost.ws.send(JSON.stringify({ type: 'test', seq: i }));
      }
      for (let i = 0; i < RATE_MAX; i++) {
        await client.waitForMessage();
      }

      // Over-limit → error
      newHost.ws.send(JSON.stringify({ type: 'test', seq: 'over' }));
      const errorMsg = await newHost.waitForMessage();
      expect(errorMsg.type).toBe('error');
      expect(errorMsg.code).toBe(4029);
    }, 10000);
  });
});
