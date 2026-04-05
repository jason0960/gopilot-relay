import { createServer, IncomingMessage, Server } from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import * as crypto from 'crypto';
import * as url from 'url';

// ─── Types ──────────────────────────────────────────────────────

export interface Room {
  /** Short room code (6 chars, e.g. "A3F9K2") */
  code: string;
  /** Secret token only the host knows — prevents room hijacking */
  hostSecret: string;
  /** The IDE-side WebSocket (VS Code extension) */
  host: WebSocket | null;
  /** All connected mobile clients */
  clients: Set<WebSocket>;
  /** ISO timestamp of room creation */
  createdAt: string;
  /** ISO timestamp of last activity */
  lastActivity: string;
  /** Room expires after this many ms of inactivity */
  ttlMs: number;
}

/**
 * A pairing entry stores opaque JSON data (e.g. Pub/Sub pairing info)
 * behind a short room code. The mobile app fetches it once by code,
 * then the entry is deleted (one-time use).
 */
export interface Pairing {
  code: string;
  data: unknown;
  createdAt: number;
  /** TTL in milliseconds (default: 10 minutes). */
  ttlMs: number;
}

/** Default pairing TTL: 10 minutes */
export const DEFAULT_PAIRING_TTL_MS = 10 * 60 * 1000;

// ─── Constants ──────────────────────────────────────────────────

export const CODE_LENGTH = 6;
export const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // No 0/O/1/I ambiguity

// ─── Room Code Generation ───────────────────────────────────────

export function generateRoomCode(existingRooms: Map<string, Room>): string {
  let code: string;
  let attempts = 0;
  do {
    code = '';
    const bytes = crypto.randomBytes(CODE_LENGTH);
    for (let i = 0; i < CODE_LENGTH; i++) {
      code += CODE_CHARS[bytes[i] % CODE_CHARS.length];
    }
    attempts++;
    if (attempts >= 100 && existingRooms.has(code)) {
      throw new Error('generateRoomCode: unable to generate a unique room code after 100 attempts');
    }
  } while (existingRooms.has(code));
  return code;
}

// ─── Configuration ──────────────────────────────────────────────

/** Default max message size: 1 MB */
export const DEFAULT_MAX_MESSAGE_SIZE = 1 * 1024 * 1024;
/** Default rate limit: 60 messages per window */
export const DEFAULT_RATE_LIMIT_MAX = 60;
/** Default rate limit window: 10 seconds */
export const DEFAULT_RATE_LIMIT_WINDOW_MS = 10_000;
/** Default max clients per room */
export const DEFAULT_MAX_CLIENTS_PER_ROOM = 10;
/** Default max connections per IP per window */
export const DEFAULT_MAX_CONNECTIONS_PER_IP = 20;
/** Default connection rate window: 60 seconds */
export const DEFAULT_CONNECTION_RATE_WINDOW_MS = 60_000;

export interface RelayServerOptions {
  port?: number;
  roomTtlMs?: number;
  maxRooms?: number;
  heartbeatIntervalMs?: number;
  debugRelay?: boolean;
  /** Maximum WebSocket message size in bytes (default: 1 MB) */
  maxMessageSize?: number;
  /** Max messages per socket per rate-limit window (default: 60) */
  rateLimitMax?: number;
  /** Rate limit window in ms (default: 10 000) */
  rateLimitWindowMs?: number;
  /** Max client connections per room (default: 10) */
  maxClientsPerRoom?: number;
  /** Max new WS connections per IP per window (default: 20) */
  maxConnectionsPerIp?: number;
  /** Connection rate window in ms (default: 60 000) */
  connectionRateWindowMs?: number;
  /**
   * When true, the server trusts the `x-forwarded-for` header for IP detection.
   * Only enable this when the relay is behind a trusted reverse proxy (e.g. nginx,
   * Caddy, a load balancer).  Defaults to false — `req.socket.remoteAddress` is
   * used instead, which cannot be spoofed by clients.
   */
  trustProxy?: boolean;
}

// ─── Relay Server Instance ──────────────────────────────────────

export interface RelayServerInstance {
  httpServer: Server;
  wss: WebSocketServer;
  rooms: Map<string, Room>;
  pairings: Map<string, Pairing>;
  /** Start listening on the configured port. Returns actual port. */
  start(): Promise<number>;
  /** Gracefully shut down the server. */
  stop(): Promise<void>;
}

/**
 * Factory function: creates a fully wired relay server without
 * starting it.  Tests call this directly; the standalone entry
 * point at the bottom of the file calls `createRelayServer().start()`.
 */
export function createRelayServer(opts: RelayServerOptions = {}): RelayServerInstance {
  const port = opts.port ?? parseInt(process.env.PORT || '4800', 10);
  const roomTtlMs = opts.roomTtlMs ?? parseInt(process.env.ROOM_TTL_MS || String(4 * 60 * 60 * 1000), 10);
  const maxRooms = opts.maxRooms ?? parseInt(process.env.MAX_ROOMS || '1000', 10);
  const heartbeatIntervalMs = opts.heartbeatIntervalMs ?? 30_000;
  const debugRelay = opts.debugRelay ?? process.env.DEBUG_RELAY === '1';
  const maxMessageSize = opts.maxMessageSize ?? DEFAULT_MAX_MESSAGE_SIZE;
  const rateLimitMax = opts.rateLimitMax ?? DEFAULT_RATE_LIMIT_MAX;
  const rateLimitWindowMs = opts.rateLimitWindowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS;
  const maxClientsPerRoom = opts.maxClientsPerRoom ?? DEFAULT_MAX_CLIENTS_PER_ROOM;
  const maxConnectionsPerIp = opts.maxConnectionsPerIp ?? DEFAULT_MAX_CONNECTIONS_PER_IP;
  const connectionRateWindowMs = opts.connectionRateWindowMs ?? DEFAULT_CONNECTION_RATE_WINDOW_MS;
  const trustProxy = opts.trustProxy ?? false;

  // ─── State ──────────────────────────────────────────────────

  const rooms = new Map<string, Room>();
  const pairings = new Map<string, Pairing>();
  const wsToRoom = new Map<WebSocket, { roomCode: string; role: 'host' | 'client' }>();
  const alive = new Map<WebSocket, boolean>();

  // ─── Rate Limiting State ─────────────────────────────────────

  /** Per-socket sliding window: timestamps of recent messages */
  const messageTimestamps = new Map<WebSocket, number[]>();

  /** Per-IP connection rate: timestamps of recent connections */
  const connectionTimestamps = new Map<string, number[]>();

  /**
   * Returns true if the socket has exceeded its message rate limit.
   * Mutates the timestamps array (appends current time, prunes old).
   */
  function isRateLimited(ws: WebSocket): boolean {
    const now = Date.now();
    let timestamps = messageTimestamps.get(ws);
    if (!timestamps) {
      timestamps = [];
      messageTimestamps.set(ws, timestamps);
    }
    // Prune timestamps outside the window
    const cutoff = now - rateLimitWindowMs;
    while (timestamps.length > 0 && timestamps[0] <= cutoff) {
      timestamps.shift();
    }
    if (timestamps.length >= rateLimitMax) {
      return true;
    }
    timestamps.push(now);
    return false;
  }

  /**
   * Returns true if this IP has exceeded its connection rate limit.
   */
  function isConnectionRateLimited(ip: string): boolean {
    const now = Date.now();
    let timestamps = connectionTimestamps.get(ip);
    if (!timestamps) {
      timestamps = [];
      connectionTimestamps.set(ip, timestamps);
    }
    const cutoff = now - connectionRateWindowMs;
    while (timestamps.length > 0 && timestamps[0] <= cutoff) {
      timestamps.shift();
    }
    // Reclaim map entry when all timestamps have expired (frees memory for idle IPs).
    if (timestamps.length === 0) {
      connectionTimestamps.delete(ip);
    }
    if (timestamps.length >= maxConnectionsPerIp) {
      return true;
    }
    timestamps.push(now);
    // If the entry was deleted above, re-register the (now non-empty) array.
    if (!connectionTimestamps.has(ip)) {
      connectionTimestamps.set(ip, timestamps);
    }
    return false;
  }

  /** Check message size. Returns true if oversized. */
  function isOversized(data: WebSocket.Data): boolean {
    if (typeof data === 'string') return Buffer.byteLength(data) > maxMessageSize;
    if (Buffer.isBuffer(data)) return data.length > maxMessageSize;
    if (Array.isArray(data)) {
      let total = 0;
      for (const buf of data) total += buf.length;
      return total > maxMessageSize;
    }
    return false;
  }

  /** Clean up rate-limiting state for a disconnected socket */
  function cleanupSocket(ws: WebSocket): void {
    messageTimestamps.delete(ws);
  }

  function log(msg: string): void {
    console.log(`[${new Date().toISOString()}] ${msg}`);
  }

  // ─── HTTP Server ────────────────────────────────────────────

  const httpServer = createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const parsedUrl = url.parse(req.url || '', true);

    if (parsedUrl.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        rooms: rooms.size,
        uptime: process.uptime(),
      }));
      return;
    }

    // ─── Pairing Exchange Endpoints ──────────────────────────

    // POST /pair — deposit pairing data, get back a room code
    if (parsedUrl.pathname === '/pair' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (!parsed || typeof parsed !== 'object') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Body must be a JSON object' }));
            return;
          }
          // Generate a unique code (reuse the room code generator with pairings as extra check)
          const allCodes = new Map<string, any>([...rooms, ...pairings]);
          const code = generateRoomCode(allCodes as Map<string, Room>);
          const pairing: Pairing = {
            code,
            data: parsed,
            createdAt: Date.now(),
            ttlMs: DEFAULT_PAIRING_TTL_MS,
          };
          pairings.set(code, pairing);
          log(`[Pairing ${code}] Created (${body.length} bytes)`);
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ code }));
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON body' }));
        }
      });
      return;
    }

    // GET /pair/:code — fetch and delete pairing data (one-time use)
    const pairMatch = parsedUrl.pathname?.match(/^\/pair\/([A-Z0-9]{4,8})$/i);
    if (pairMatch && req.method === 'GET') {
      const code = pairMatch[1].toUpperCase();
      const pairing = pairings.get(code);
      if (!pairing) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Pairing not found or expired' }));
        return;
      }
      // One-time use — delete after fetch
      pairings.delete(code);
      log(`[Pairing ${code}] Fetched and deleted`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(pairing.data));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  // ─── WebSocket Server ─────────────────────────────────────────

  const wss = new WebSocketServer({ server: httpServer, maxPayload: maxMessageSize });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    // ─── Connection rate limiting per IP ──────────────────────
    // Only honour x-forwarded-for when the server is configured to trust a
    // reverse proxy — otherwise a client could spoof an arbitrary IP to bypass
    // per-IP connection limits.
    const ip = (trustProxy
      ? req.headers['x-forwarded-for']?.toString().split(',')[0].trim()
      : undefined)
      || req.socket.remoteAddress
      || 'unknown';

    if (isConnectionRateLimited(ip)) {
      log(`[RATE LIMIT] Connection rate exceeded for IP ${ip}`);
      ws.close(4029, 'Too many connections');
      return;
    }

    const parsedUrl = url.parse(req.url || '', true);
    const pathname = parsedUrl.pathname || '';

    alive.set(ws, true);
    ws.on('pong', () => alive.set(ws, true));

    if (pathname === '/relay/host') {
      handleHostConnection(ws);
      return;
    }

    if (pathname === '/relay/join') {
      const code = (parsedUrl.query.code as string || '').toUpperCase();
      handleClientConnection(ws, code);
      return;
    }

    if (pathname === '/relay/rejoin') {
      const code = (parsedUrl.query.code as string || '').toUpperCase();
      const secret = parsedUrl.query.secret as string || '';
      handleHostRejoin(ws, code, secret);
      return;
    }

    ws.close(4000, 'Unknown path. Use /relay/host or /relay/join?code=XXXX');
  });

  // ─── Host Connection ────────────────────────────────────────

  function handleHostConnection(ws: WebSocket): void {
    if (rooms.size >= maxRooms) {
      ws.close(4010, 'Server at capacity');
      return;
    }

    const code = generateRoomCode(rooms);
    const hostSecret = crypto.randomBytes(16).toString('hex');

    const room: Room = {
      code,
      hostSecret,
      host: ws,
      clients: new Set(),
      createdAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
      ttlMs: roomTtlMs,
    };

    rooms.set(code, room);
    wsToRoom.set(ws, { roomCode: code, role: 'host' });

    ws.send(JSON.stringify({
      type: 'relay.room_created',
      code,
      hostSecret,
    }));

    log(`[Room ${code}] Created by host`);

    ws.on('message', (data) => {
      if (isOversized(data)) {
        log(`[Room ${code}] Host message rejected — oversized`);
        ws.close(4013, 'Message too large');
        return;
      }
      if (isRateLimited(ws)) {
        log(`[Room ${code}] Host message rejected — rate limited`);
        ws.send(JSON.stringify({ type: 'error', code: 4029, message: 'Rate limit exceeded' }));
        return;
      }
      const raw = data.toString();
      room.lastActivity = new Date().toISOString();
      if (debugRelay) { log(`[Room ${code}] HOST→CLIENTS (${raw.length} bytes): ${raw.substring(0, 300)}`); }

      try {
        const msg = JSON.parse(raw);
        if (msg._relayTarget) {
          for (const client of room.clients) {
            if (client.readyState === WebSocket.OPEN) {
              client.send(raw);
            }
          }
          return;
        }
      } catch {
        // Not JSON or no relay control — forward as-is
      }

      log(`[Room ${code}] Forwarding to ${room.clients.size} clients`);
      for (const client of room.clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(raw);
        }
      }
    });

    ws.on('close', () => {
      log(`[Room ${code}] Host disconnected`);
      wsToRoom.delete(ws);
      alive.delete(ws);
      cleanupSocket(ws);

      for (const client of room.clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({
            type: 'event',
            method: 'relay.host_disconnected',
            params: {},
            id: crypto.randomUUID(),
          }));
        }
      }

      room.host = null;
    });

    ws.on('error', (err) => {
      log(`[Room ${code}] Host error: ${err.message}`);
    });
  }

  // ─── Client Connection ────────────────────────────────────────

  function handleClientConnection(ws: WebSocket, code: string): void {
    const room = rooms.get(code);

    if (!room) {
      ws.close(4004, 'Room not found');
      return;
    }

    if (room.clients.size >= maxClientsPerRoom) {
      log(`[Room ${code}] Client rejected — room full (${room.clients.size}/${maxClientsPerRoom})`);
      ws.close(4011, 'Room full');
      return;
    }

    room.clients.add(ws);
    room.lastActivity = new Date().toISOString();
    wsToRoom.set(ws, { roomCode: code, role: 'client' });

    log(`[Room ${code}] Client joined (${room.clients.size} clients)`);

    ws.send(JSON.stringify({
      type: 'relay.joined',
      code,
      hostConnected: room.host !== null && room.host.readyState === WebSocket.OPEN,
    }));

    if (room.host && room.host.readyState === WebSocket.OPEN) {
      room.host.send(JSON.stringify({
        type: 'relay.client_joined',
        clientCount: room.clients.size,
      }));
    }

    ws.on('message', (data) => {
      if (isOversized(data)) {
        log(`[Room ${code}] Client message rejected — oversized`);
        ws.close(4013, 'Message too large');
        return;
      }
      if (isRateLimited(ws)) {
        log(`[Room ${code}] Client message rejected — rate limited`);
        ws.send(JSON.stringify({ type: 'error', code: 4029, message: 'Rate limit exceeded' }));
        return;
      }
      const raw = data.toString();
      room.lastActivity = new Date().toISOString();
      if (debugRelay) { log(`[Room ${code}] CLIENT→HOST (${raw.length} bytes): ${raw.substring(0, 300)}`); }

      if (room.host && room.host.readyState === WebSocket.OPEN) {
        room.host.send(raw);
        log(`[Room ${code}] Forwarded to host OK`);
      } else {
        log(`[Room ${code}] WARN: Host not available (host=${!!room.host}, readyState=${room.host?.readyState})`);
      }
    });

    ws.on('close', () => {
      room.clients.delete(ws);
      wsToRoom.delete(ws);
      alive.delete(ws);
      cleanupSocket(ws);
      log(`[Room ${code}] Client left (${room.clients.size} remaining)`);

      if (room.host && room.host.readyState === WebSocket.OPEN) {
        room.host.send(JSON.stringify({
          type: 'relay.client_left',
          clientCount: room.clients.size,
        }));
      }
    });

    ws.on('error', (err) => {
      log(`[Room ${code}] Client error: ${err.message}`);
    });
  }

  // ─── Host Reconnection ───────────────────────────────────────

  function handleHostRejoin(ws: WebSocket, code: string, secret: string): void {
    const room = rooms.get(code);

    if (!room || room.hostSecret !== secret) {
      ws.close(4004, 'Invalid room or secret');
      return;
    }

    if (room.host && room.host.readyState === WebSocket.OPEN) {
      room.host.close(4009, 'Replaced by new host connection');
    }

    room.host = ws;
    room.lastActivity = new Date().toISOString();
    wsToRoom.set(ws, { roomCode: code, role: 'host' });

    alive.set(ws, true);
    ws.on('pong', () => alive.set(ws, true));

    ws.send(JSON.stringify({
      type: 'relay.rejoined',
      code,
      clientCount: room.clients.size,
    }));

    log(`[Room ${code}] Host rejoined (${room.clients.size} clients waiting)`);

    for (const client of room.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({
          type: 'event',
          method: 'relay.host_reconnected',
          params: {},
          id: crypto.randomUUID(),
        }));
      }
    }

    ws.on('message', (data) => {
      if (isOversized(data)) {
        log(`[Room ${code}] Host rejoin message rejected — oversized`);
        ws.close(4013, 'Message too large');
        return;
      }
      if (isRateLimited(ws)) {
        log(`[Room ${code}] Host rejoin message rejected — rate limited`);
        ws.send(JSON.stringify({ type: 'error', code: 4029, message: 'Rate limit exceeded' }));
        return;
      }
      const raw = data.toString();
      room.lastActivity = new Date().toISOString();

      for (const client of room.clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(raw);
        }
      }
    });

    ws.on('close', () => {
      log(`[Room ${code}] Host disconnected (rejoin)`);
      wsToRoom.delete(ws);
      alive.delete(ws);
      cleanupSocket(ws);
      room.host = null;

      for (const client of room.clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({
            type: 'event',
            method: 'relay.host_disconnected',
            params: {},
            id: crypto.randomUUID(),
          }));
        }
      }
    });

    ws.on('error', (err) => {
      log(`[Room ${code}] Host rejoin error: ${err.message}`);
    });
  }

  // ─── Intervals ────────────────────────────────────────────────

  let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  let cleanupInterval: ReturnType<typeof setInterval> | null = null;

  // ─── Public interface ─────────────────────────────────────────

  return {
    httpServer,
    wss,
    rooms,
    pairings,
    start(): Promise<number> {
      return new Promise((resolve) => {
        heartbeatInterval = setInterval(() => {
          for (const [ws, isAlive] of alive) {
            if (!isAlive) {
              ws.terminate();
              alive.delete(ws);
              // Eagerly clean up per-socket state in case the 'close' event
              // fires late or not at all after terminate().
              wsToRoom.delete(ws);
              cleanupSocket(ws);
              continue;
            }
            alive.set(ws, false);
            ws.ping();
          }
        }, heartbeatIntervalMs);
        heartbeatInterval.unref();

        cleanupInterval = setInterval(() => {
          const now = Date.now();
          for (const [code, room] of rooms) {
            const lastActivity = new Date(room.lastActivity).getTime();
            if (now - lastActivity > room.ttlMs) {
              log(`[Room ${code}] Expired — cleaning up`);
              if (room.host && room.host.readyState === WebSocket.OPEN) {
                room.host.close(4008, 'Room expired');
              }
              for (const client of room.clients) {
                if (client.readyState === WebSocket.OPEN) {
                  client.close(4008, 'Room expired');
                }
              }
              rooms.delete(code);
            }
          }
          // Clean up expired pairings
          for (const [code, pairing] of pairings) {
            if (now - pairing.createdAt > pairing.ttlMs) {
              log(`[Pairing ${code}] Expired — cleaning up`);
              pairings.delete(code);
            }
          }
        }, 60_000);
        cleanupInterval.unref();

        httpServer.listen(port, () => {
          const addr = httpServer.address() as { port: number };
          log(`AgentDeck Relay Server listening on port ${addr.port}`);
          log(`  Room TTL: ${roomTtlMs / 1000 / 60} minutes`);
          log(`  Max rooms: ${maxRooms}`);
          resolve(addr.port);
        });
      });
    },
    stop(): Promise<void> {
      return new Promise((resolve) => {
        log('Shutting down...');
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        if (cleanupInterval) clearInterval(cleanupInterval);

        for (const [, room] of rooms) {
          if (room.host && room.host.readyState === WebSocket.OPEN) {
            room.host.close(1001, 'Server shutting down');
          }
          for (const client of room.clients) {
            if (client.readyState === WebSocket.OPEN) {
              client.close(1001, 'Server shutting down');
            }
          }
        }

        wss.close(() => {
          httpServer.close(() => resolve());
        });
      });
    },
  };
}

// ─── Standalone Entry Point ─────────────────────────────────────

if (require.main === module || process.env.RELAY_AUTOSTART === '1') {
  const server = createRelayServer();
  server.start();

  const shutdown = () => {
    server.stop().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
