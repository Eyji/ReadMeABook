/**
 * Component: E2E harness Docker helpers (compose wrapper, image build, cleanup, disk ceiling)
 * Documentation: documentation/testing/e2e-harness.md
 *
 * Everything here runs from the trusted checkout. A branch under test only ever supplies a
 * Docker build context; nothing inside it is executed on the host.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const E2E_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const COMPOSE_FILE = path.join(E2E_DIR, 'compose.yml');
export const ENV_FILE = path.join(E2E_DIR, '.env.test');
export const LABEL = 'rmab-e2e=true';
export const PREVIEW_PROJECT = 'rmab-e2e-preview';
const DISK_CEILING_GB = 50;
const BUILD_CACHE_CAP = '15gb';

let commandLog = null;
export function setCommandLog(file) {
  commandLog = file;
}

function log(line) {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  console.log(`[e2e] ${line}`);
  if (commandLog) fs.appendFileSync(commandLog, `${stamped}\n`);
}

/** Run a command. capture=true returns stdout; allowFail=true never throws. */
export function run(cmd, args, { capture = false, allowFail = false, env, input, quiet = false } = {}) {
  if (!quiet) log(`$ ${cmd} ${args.join(' ')}`);
  const res = spawnSync(cmd, args, {
    env: env ? { ...process.env, ...env } : process.env,
    encoding: 'utf8',
    input,
    maxBuffer: 256 * 1024 * 1024,
    stdio: capture || input !== undefined ? ['pipe', 'pipe', 'pipe'] : 'inherit',
  });
  if (res.error) throw res.error;
  if (res.status !== 0 && !allowFail) {
    throw new Error(`${cmd} ${args.slice(0, 4).join(' ')}... exited ${res.status}${res.stderr ? `: ${res.stderr.trim().slice(-2000)}` : ''}`);
  }
  return capture ? (res.stdout || '').trim() : res.status;
}

/** Read KEY=VALUE pairs from e2e/.env.test. */
export function readEnvFile(file = ENV_FILE) {
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

export function composeArgs(project, args) {
  return ['compose', '-p', project, '-f', COMPOSE_FILE, '--env-file', ENV_FILE, ...args];
}

export function compose(project, args, env, opts = {}) {
  return run('docker', composeArgs(project, args), { env, ...opts });
}

/** Host address for a service port published on an ephemeral 127.0.0.1 port. */
export function composePort(project, service, port, env) {
  const out = compose(project, ['port', service, String(port)], env, { capture: true, quiet: true });
  const m = /(127\.0\.0\.1|0\.0\.0\.0):(\d+)/.exec(out);
  if (!m) throw new Error(`no published port for ${service}:${port} (got "${out}")`);
  return `http://127.0.0.1:${m[2]}`;
}

export function imageExists(ref) {
  return spawnSync('docker', ['image', 'inspect', ref], { stdio: 'ignore' }).status === 0;
}

export function imageSize(ref) {
  const bytes = Number(run('docker', ['image', 'inspect', '-f', '{{.Size}}', ref], { capture: true, allowFail: true, quiet: true }));
  return Number.isFinite(bytes) ? `${(bytes / 1e9).toFixed(2)} GB` : 'unknown';
}

export function gitShortSha(dir) {
  return run('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], { capture: true, quiet: true });
}

/** Build the RMAB image from a branch worktree (build context only; never executed on the host). */
export function buildRmabImage({ worktree, dockerfile, tag, slug }) {
  const df = dockerfile || path.join(worktree, 'dockerfile.unified');
  const sha = gitShortSha(worktree);
  run('docker', [
    'build', '-f', df, '-t', tag,
    '--label', LABEL, '--label', `rmab-e2e.slug=${slug}`, '--label', `rmab-e2e.sha=${sha}`,
    '--build-arg', `GIT_COMMIT=${sha}`, '--build-arg', `APP_VERSION=e2e-${sha}`,
    '--build-arg', `BUILD_DATE=${new Date().toISOString()}`,
    worktree,
  ]);
  return { tag, sha };
}

/** `docker builder prune` flag that caps the cache (renamed in newer Docker releases). */
function builderPruneArgs() {
  const help = run('docker', ['builder', 'prune', '--help'], { capture: true, allowFail: true, quiet: true });
  if (help.includes('--max-used-space')) return ['builder', 'prune', '-f', '--max-used-space', BUILD_CACHE_CAP];
  return ['builder', 'prune', '-f', '--keep-storage', BUILD_CACHE_CAP];
}

const UNIT = { B: 1, KB: 1e3, kB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 };
function parseSize(s) {
  const m = /^([\d.]+)\s*([kKMGT]?B)/.exec(String(s).trim());
  return m ? Number(m[1]) * (UNIT[m[2]] || UNIT[m[2].toUpperCase()] || 1) : 0;
}

/** `docker system df` totals in GB: { images, buildCache, volumes, containers, total, raw }. */
export function dockerDf() {
  const raw = run('docker', ['system', 'df', '--format', '{{json .}}'], { capture: true, allowFail: true, quiet: true });
  const rows = raw.split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  const get = (type) => parseSize(rows.find((r) => r.Type === type)?.Size || '0B') / 1e9;
  const result = { images: get('Images'), containers: get('Containers'), volumes: get('Local Volumes'), buildCache: get('Build Cache') };
  result.total = result.images + result.volumes + result.buildCache;
  result.raw = run('docker', ['system', 'df'], { capture: true, allowFail: true, quiet: true });
  return result;
}

/**
 * Remove rmab-e2e-* LEFTOVERS only (pool-safe: other slots may be mid-run on the same daemon).
 * - A stack is a leftover when none of its containers is running (stopped containers or orphan volumes).
 * - Images: only `rmab-e2e/*` images labelled with this run's slug, plus our dangling images.
 * The preview stack and `protect` refs are never touched; other teams' images are never removed.
 */
export function pruneLeftovers({ slug, protect = [] } = {}) {
  const list = (args) => run('docker', args, { capture: true, allowFail: true, quiet: true }).split(/\r?\n/).filter(Boolean);
  const running = new Set(list(['ps', '--filter', 'label=com.docker.compose.project', '--format', '{{.Label "com.docker.compose.project"}}']));
  const projects = new Set(
    [...list(['ps', '-a', '--filter', 'label=com.docker.compose.project', '--format', '{{.Label "com.docker.compose.project"}}']),
     ...list(['volume', 'ls', '--format', '{{.Label "com.docker.compose.project"}}'])]
      .filter((p) => p.startsWith('rmab-e2e-') && p !== PREVIEW_PROJECT && !running.has(p))
  );
  for (const project of projects) {
    // Always pass our compose file: never let compose pick up a compose file from the cwd.
    compose(project, ['down', '-v', '--remove-orphans'], { E2E_SLUG: project.replace(/^rmab-e2e-/, ''), RMAB_IMAGE: 'unused', RMAB_PORT: '0' }, { allowFail: true });
    for (const v of list(['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`])) run('docker', ['volume', 'rm', v], { allowFail: true });
  }
  if (slug) {
    for (const ref of list(['images', '--filter', `label=rmab-e2e.slug=${slug}`, '--format', '{{.Repository}}:{{.Tag}}']).filter((r) => r.startsWith('rmab-e2e/') && !protect.includes(r))) {
      run('docker', ['image', 'rm', ref], { allowFail: true });
    }
  }
  run('docker', ['image', 'prune', '-f', '--filter', `label=${LABEL}`], { allowFail: true });
  run('docker', builderPruneArgs(), { allowFail: true });
}

/** Disk ceiling check before a build: prune if images + cache + volumes exceed 50 GB. */
export function enforceDiskCeiling({ slug, protect, warn }) {
  const df = dockerDf();
  if (df.total > DISK_CEILING_GB) {
    warn(`docker system df total ${df.total.toFixed(1)} GB > ${DISK_CEILING_GB} GB: pruning rmab-e2e leftovers and build cache`);
    pruneLeftovers({ slug, protect });
  }
  return df;
}

/**
 * Per-run cleanup (runs in `finally`, including failures and Ctrl-C):
 * down -v, remove images this run created, prune our dangling images, cap the build cache.
 */
export function cleanupRun({ project, env, images = [] }) {
  compose(project, ['down', '-v', '--remove-orphans'], env, { allowFail: true });
  for (const ref of images) run('docker', ['image', 'rm', ref], { allowFail: true });
  run('docker', ['image', 'prune', '-f', '--filter', `label=${LABEL}`], { allowFail: true });
  run('docker', builderPruneArgs(), { allowFail: true });
}
