/**
 * Component: Per-process Startup Secret
 * Documentation: documentation/backend/services/scheduler.md
 *
 * Generated in memory by the instrumentation hook and checked by the init
 * route. Lives on globalThis so every module copy in the same process
 * sees it. Never logged, never put in env, never written to disk.
 */

import { randomBytes, timingSafeEqual } from 'crypto';
import { STARTUP_SECRET_BYTES } from '@/lib/constants/startup';

const SECRET_SLOT = Symbol.for('rmab.startup.secret');
const store = globalThis as unknown as Record<symbol, string | undefined>;

/** Return this process's startup secret, creating it on first use. */
export function getOrCreateStartupSecret(): string {
  if (!store[SECRET_SLOT]) {
    store[SECRET_SLOT] = randomBytes(STARTUP_SECRET_BYTES).toString('hex');
  }
  return store[SECRET_SLOT] as string;
}

/** True only when a secret exists in this process and `candidate` matches it. */
export function isStartupSecret(candidate: string | null | undefined): boolean {
  const secret = store[SECRET_SLOT];
  if (!secret || typeof candidate !== 'string') return false;
  const expected = Buffer.from(secret, 'utf8');
  const received = Buffer.from(candidate, 'utf8');
  if (expected.length !== received.length) return false;
  return timingSafeEqual(expected, received);
}
