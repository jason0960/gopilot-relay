/**
 * Relay Server — exported function unit tests
 *
 * Tests the exported pure functions from relay-server/src/index.ts
 * to provide focused coverage of individual helpers.
 *
 * Covers: generateRoomCode, CODE_CHARS, CODE_LENGTH, Room type.
 */

import { generateRoomCode, CODE_CHARS, CODE_LENGTH } from '../src/index';
import type { Room } from '../src/index';
import * as crypto from 'crypto';

// Hoist mock so jest.fn() works on crypto.randomBytes (non-configurable in Node built-ins).
jest.mock('crypto', () => {
  const actual = jest.requireActual<typeof import('crypto')>('crypto');
  return { ...actual, randomBytes: jest.fn(actual.randomBytes) };
});

describe('relay-server exports', () => {
  // ─── CODE_CHARS ─────────────────────────────────────────────

  describe('CODE_CHARS', () => {
    it('excludes ambiguous characters (0, O, 1, I)', () => {
      expect(CODE_CHARS).not.toContain('0');
      expect(CODE_CHARS).not.toContain('O');
      expect(CODE_CHARS).not.toContain('1');
      expect(CODE_CHARS).not.toContain('I');
    });

    it('contains only uppercase letters and digits', () => {
      expect(CODE_CHARS).toMatch(/^[A-Z2-9]+$/);
    });
  });

  // ─── CODE_LENGTH ────────────────────────────────────────────

  describe('CODE_LENGTH', () => {
    it('is 6', () => {
      expect(CODE_LENGTH).toBe(6);
    });
  });

  // ─── generateRoomCode ───────────────────────────────────────

  describe('generateRoomCode', () => {
    it('generates a code of CODE_LENGTH characters', () => {
      const rooms = new Map<string, Room>();
      const code = generateRoomCode(rooms);
      expect(code.length).toBe(CODE_LENGTH);
    });

    it('generates codes using only CODE_CHARS', () => {
      const rooms = new Map<string, Room>();
      for (let i = 0; i < 20; i++) {
        const code = generateRoomCode(rooms);
        for (const ch of code) {
          expect(CODE_CHARS).toContain(ch);
        }
      }
    });

    it('generates unique codes (no collision with existing rooms)', () => {
      const rooms = new Map<string, Room>();
      const codes = new Set<string>();
      for (let i = 0; i < 50; i++) {
        const code = generateRoomCode(rooms);
        codes.add(code);
        rooms.set(code, {
          code,
          hostSecret: 'test',
          host: null,
          clients: new Set(),
          createdAt: new Date().toISOString(),
          lastActivity: new Date().toISOString(),
          ttlMs: 60000,
        });
      }
      // With 30^6 = 729M possible codes and 50 generated, collisions should be effectively zero
      expect(codes.size).toBe(50);
    });

    it('retries when collision occurs and returns a unique code', () => {
      // Deterministically force a first-call collision:
      // randomBytes returns the same bytes twice, then different bytes on the third call.
      const collidingCode = 'AAAAAA';
      // Build a rooms map that already contains the code the first two calls will produce
      const rooms = new Map<string, Room>();
      rooms.set(collidingCode, {
        code: collidingCode,
        hostSecret: 'test',
        host: null,
        clients: new Set(),
        createdAt: new Date().toISOString(),
        lastActivity: new Date().toISOString(),
        ttlMs: 60000,
      });

      // First call: returns bytes that map to collidingCode; second call: unique bytes.
      // CODE_CHARS[0] = 'A', so fill 6 bytes of value 0 for the collision, then 1..6 for the unique code.
      const callCount = { n: 0 };
      (crypto.randomBytes as jest.Mock).mockImplementation((size: number) => {
        callCount.n++;
        if (callCount.n === 1) {
          // Produces collidingCode (all 'A's)
          return Buffer.alloc(size, 0) as any;
        }
        // Produces a different code (all 'B's → CODE_CHARS[1])
        return Buffer.alloc(size, 1) as any;
      });

      try {
        const code = generateRoomCode(rooms);
        expect(code).not.toBe(collidingCode);
        expect(code.length).toBe(CODE_LENGTH);
        expect(callCount.n).toBe(2); // confirmed the retry path was exercised
      } finally {
        jest.mocked(crypto.randomBytes).mockRestore();
      }
    });

    it('throws after 100 exhausted retries', () => {
      // Fill the map with every possible code... is impractical, so instead
      // mock randomBytes to always produce the same colliding code.
      const rooms = new Map<string, Room>();
      const collidingCode = 'AAAAAA';
      rooms.set(collidingCode, {
        code: collidingCode,
        hostSecret: 'test',
        host: null,
        clients: new Set(),
        createdAt: new Date().toISOString(),
        lastActivity: new Date().toISOString(),
        ttlMs: 60000,
      });

      jest.mocked(crypto.randomBytes).mockImplementation((size: number) => Buffer.alloc(size, 0) as any);

      try {
        expect(() => generateRoomCode(rooms)).toThrow(
          'generateRoomCode: unable to generate a unique room code after 100 attempts'
        );
      } finally {
        jest.mocked(crypto.randomBytes).mockRestore();
      }
    });
  });
});
