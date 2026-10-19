/**
 * Component: One-time Application Initialization (runs inside the init route)
 * Documentation: documentation/backend/services/scheduler.md
 *
 * Readiness check (database + Redis), then credential migration and scheduler
 * start. Runs at most once per process; concurrent callers share one run.
 */

import Redis from 'ioredis';
import { prisma } from '@/lib/db';
import { getSchedulerService } from '@/lib/services/scheduler.service';
import { runCredentialMigration } from '@/lib/services/credential-migration.service';
import { RMABLogger } from '@/lib/utils/logger';
import { STARTUP_REDIS_PING_TIMEOUT_MS } from '@/lib/constants/startup';

const logger = RMABLogger.create('Startup');

export type AppInitOutcome = 'initialized' | 'already-initialized' | 'not-ready' | 'failed';

interface InitState {
  done: boolean;
  inFlight?: Promise<AppInitOutcome>;
}

const STATE_SLOT = Symbol.for('rmab.startup.init-state');
const store = globalThis as unknown as Record<symbol, InitState | undefined>;

function state(): InitState {
  if (!store[STATE_SLOT]) store[STATE_SLOT] = { done: false };
  return store[STATE_SLOT] as InitState;
}

async function databaseReady(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch (error) {
    logger.warn('Database not ready for startup init', { error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

/** Redis answers PONG (not LOADING) before Bull queues start. */
async function redisReady(): Promise<boolean> {
  const client = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    connectTimeout: STARTUP_REDIS_PING_TIMEOUT_MS,
    retryStrategy: () => null,
  });
  try {
    await client.connect();
    return (await client.ping()) === 'PONG';
  } catch (error) {
    logger.warn('Redis not ready for startup init', { error: error instanceof Error ? error.message : String(error) });
    return false;
  } finally {
    client.disconnect();
  }
}

async function runInit(): Promise<AppInitOutcome> {
  if (!(await databaseReady()) || !(await redisReady())) return 'not-ready';
  try {
    logger.info('Initializing application services...');
    await runCredentialMigration();
    await getSchedulerService().start();
    state().done = true;
    logger.info('Application services initialized successfully');
    return 'initialized';
  } catch (error) {
    logger.error('Failed to initialize services', { error: error instanceof Error ? error.message : String(error) });
    return 'failed';
  }
}

/** Initialize once per process. Later calls return 'already-initialized' without re-running. */
export async function runAppInitOnce(): Promise<AppInitOutcome> {
  const current = state();
  if (current.done) return 'already-initialized';
  if (!current.inFlight) {
    current.inFlight = runInit().finally(() => {
      current.inFlight = undefined;
    });
  }
  return current.inFlight;
}
