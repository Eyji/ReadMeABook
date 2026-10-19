#!/usr/bin/env node
/**
 * Component: E2E harness runner (stack / unit / preview / down)
 * Documentation: documentation/testing/e2e-harness.md
 *
 * Run from a TRUSTED checkout. The branch under test is passed with --worktree and is only ever
 * used as a Docker build context. Cleanup runs after every stack/unit run, including failures.
 *
 *   npm run e2e -- --slug <s> --port <3401-3499> (--image <ref> | --worktree <dir>) [options]
 *   npm run e2e:unit -- --slug <s> --worktree <dir>
 *   npm run e2e -- preview --image <ref> [--replace-image <old ref>]
 *   npm run e2e -- down --slug <s>
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  E2E_DIR, PREVIEW_PROJECT, LABEL, run, compose, composePort, readEnvFile, imageExists, imageSize,
  buildRmabImage, gitShortSha, enforceDiskCeiling, cleanupRun, dockerDf, setCommandLog,
} from './lib/docker.mjs';

const REPO = path.dirname(E2E_DIR);
const PLAYWRIGHT_CLI = path.join(REPO, 'node_modules', '@playwright', 'test', 'cli.js');
const RELEASE_REPO = 'ghcr.io/kikootwo/readmeabook';

const USAGE = `usage:
  node e2e/run.mjs [stack] --slug <s> --port <3401-3499> (--image <ref> | --worktree <dir>)
       [--dockerfile <file>] [--specs <a,b>] [--scenario <name>] [--backend abs|plex]
       [--upgrade-from <release tag, e.g. 1.2.3>] [--evidence <dir>] [--offline-fixtures] [--rm-image]
  node e2e/run.mjs unit --slug <s> --worktree <dir> [--evidence <dir>]
  node e2e/run.mjs preview --image <ref> [--replace-image <ref>] [--evidence <dir>]
  node e2e/run.mjs down --slug <s>`;

function parseArgs(argv) {
  const opts = { command: 'stack', specs: 'smoke.spec.ts', backend: 'abs', scenario: 'smoke' };
  const flags = new Set(['offline-fixtures', 'rm-image', 'help']);
  let i = 0;
  if (argv[0] && !argv[0].startsWith('--')) opts.command = argv[i++];
  for (; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    if (flags.has(key)) opts[key] = true;
    else if (argv[i].startsWith('--') && argv[i + 1] !== undefined) opts[key] = argv[++i];
    else throw new Error(`bad argument ${argv[i]}\n${USAGE}`);
  }
  if (opts.help) {
    console.log(USAGE);
    process.exit(0);
  }
  if (!['stack', 'unit', 'preview', 'down'].includes(opts.command)) throw new Error(`unknown command ${opts.command}\n${USAGE}`);
  if (opts.command === 'preview') {
    opts.slug = 'preview';
    opts.port = '3400';
  }
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(opts.slug || '')) throw new Error(`--slug must match [a-z0-9-] (got ${opts.slug})`);
  if (opts.command === 'stack') {
    const port = Number(opts.port);
    if (!(port >= 3401 && port <= 3499)) throw new Error('--port must be in 3401-3499 (3400 is the preview)');
    if (!opts.image === !opts.worktree) throw new Error('pass exactly one of --image or --worktree');
  }
  if (opts.command === 'unit' && !opts.worktree) throw new Error('unit needs --worktree');
  if (opts.command === 'preview' && !opts.image) throw new Error('preview needs --image');
  if (!['abs', 'plex'].includes(opts.backend)) throw new Error('--backend must be abs or plex');
  if (opts.worktree) {
    opts.worktree = path.resolve(opts.worktree);
    if (!fs.existsSync(path.join(opts.worktree, 'package.json'))) throw new Error(`--worktree ${opts.worktree} is not a checkout`);
  }
  return opts;
}

function evidenceDir(opts) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
  const base = path.resolve(opts.evidence || process.env.E2E_EVIDENCE_DIR || path.join(os.tmpdir(), 'rmab-e2e-evidence'));
  const dir = path.join(base, `${opts.slug}-${opts.command}-${stamp}`);
  // Evidence must never land inside a build context.
  for (const ctx of [opts.worktree, E2E_DIR].filter(Boolean)) {
    const rel = path.relative(ctx, dir);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) throw new Error(`evidence dir ${dir} is inside build context ${ctx}`);
  }
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function playwright(env, specs, project) {
  const args = [PLAYWRIGHT_CLI, 'test', '-c', path.join(E2E_DIR, 'playwright.config.ts'), ...specs];
  if (project) args.push('--project', project);
  console.log(`[e2e] $ playwright test ${specs.join(' ')}${project ? ` --project ${project}` : ''}`);
  const res = spawnSync(process.execPath, args, { cwd: REPO, stdio: 'inherit', env: { ...process.env, ...env } });
  return res.status ?? 1;
}

async function saveRecorder(controlUrl, file) {
  try {
    const res = await fetch(`${controlUrl}/__control/requests`);
    fs.writeFileSync(file, JSON.stringify(await res.json(), null, 2));
  } catch (error) {
    fs.writeFileSync(file, JSON.stringify({ error: String(error) }));
  }
}

/** Logs, recorder dump, canary count, image sizes, disk usage. Never throws. */
async function collectEvidence(ctx) {
  try {
    const logs = compose(ctx.project, ['logs', '--no-color', '--timestamps'], ctx.env, { capture: true, allowFail: true, quiet: true });
    fs.writeFileSync(path.join(ctx.evidence, 'compose.log'), logs);
    const key = ctx.secrets.PROWLARR_API_KEY;
    const rmabLines = logs.split(/\r?\n/).filter((l) => l.startsWith('rmab'));
    ctx.summary.canaryInRmabLogs = rmabLines.filter((l) => l.includes(key)).length;
    if (ctx.controlUrl) await saveRecorder(ctx.controlUrl, path.join(ctx.evidence, 'fake-arr-requests.json'));
  } catch (error) {
    ctx.summary.evidenceError = String(error);
  }
  ctx.summary.imageSizes = Object.fromEntries(ctx.sizeRefs.filter(imageExists).map((ref) => [ref, imageSize(ref)]));
}

function upStack(ctx, rmabImage, { generatedSecrets = false } = {}) {
  const env = { ...ctx.env, RMAB_IMAGE: rmabImage };
  if (generatedSecrets) Object.assign(env, { RMAB_JWT_SECRET: '', RMAB_JWT_REFRESH_SECRET: '', RMAB_CONFIG_ENCRYPTION_KEY: '', RMAB_POSTGRES_PASSWORD: '' });
  compose(ctx.project, ['up', '-d', '--no-build'], env);
  ctx.env = env;
  ctx.controlUrl = composePort(ctx.project, 'fake-arr', 9999, env);
  const absUrl = composePort(ctx.project, 'abs', 80, env);
  return {
    ...ctx.secrets,
    E2E_PROJECT: ctx.project,
    E2E_SLUG: ctx.opts.slug,
    E2E_BASE_URL: `http://127.0.0.1:${ctx.opts.port}`,
    E2E_CONTROL_URL: ctx.controlUrl,
    E2E_ABS_URL: absUrl,
    E2E_BACKEND: ctx.opts.backend,
    E2E_EVIDENCE_DIR: ctx.evidence,
    E2E_COMPOSE_ENV: JSON.stringify({ E2E_SLUG: env.E2E_SLUG, RMAB_IMAGE: env.RMAB_IMAGE, RMAB_PORT: env.RMAB_PORT }),
  };
}

async function stackOrPreview(opts) {
  const evidence = evidenceDir(opts);
  setCommandLog(path.join(evidence, 'commands.log'));
  const project = opts.command === 'preview' ? PREVIEW_PROJECT : `rmab-e2e-${opts.slug}`;
  const fakeArrRef = `rmab-e2e/fake-arr:${opts.slug}`;
  const ctx = {
    opts, evidence, project, controlUrl: null, sizeRefs: [], created: [],
    secrets: readEnvFile(),
    env: { E2E_SLUG: opts.slug, RMAB_PORT: opts.port, RMAB_IMAGE: 'unset', E2E_SCENARIO: opts.scenario, FAKE_ARR_TAG: opts.slug, FIXTURE_METADATA: opts['offline-fixtures'] ? 'test/offline-metadata.json' : '' },
    summary: { command: opts.command, slug: opts.slug, project, startedAt: new Date().toISOString(), warnings: [] },
  };
  const warn = (msg) => {
    console.warn(`[e2e] WARNING ${msg}`);
    ctx.summary.warnings.push(msg);
  };
  let interrupted = false;
  const onSignal = () => {
    interrupted = true;
    warn('interrupted: cleaning up');
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  let status = 1;
  try {
    ctx.summary.dfBefore = enforceDiskCeiling({ protect: opts.image ? [opts.image] : [], warn }).total.toFixed(1);
    compose(project, ['down', '-v', '--remove-orphans'], ctx.env, { allowFail: true }); // fresh volumes every run

    let image = opts.image;
    if (image) {
      if (!imageExists(image)) throw new Error(`image ${image} not found locally`);
      // A supplied image is kept unless --rm-image (e.g. a fail-before base image built for this run only).
      if (opts.command === 'stack' && opts['rm-image']) ctx.created.push(image);
    } else {
      image = `rmab-e2e/${opts.slug}:${gitShortSha(opts.worktree)}`;
      ctx.created.push(image);
      buildRmabImage({ worktree: opts.worktree, dockerfile: opts.dockerfile && path.resolve(opts.dockerfile), tag: image, slug: opts.slug });
    }
    ctx.sizeRefs.push(image, fakeArrRef);
    ctx.summary.image = image;
    if (interrupted) throw new Error('interrupted');

    compose(project, ['build', 'fake-arr'], ctx.env);
    ctx.created.push(fakeArrRef);

    if (opts['upgrade-from']) {
      const oldRef = `${RELEASE_REPO}:${opts['upgrade-from'].replace(/^v/, '')}`;
      const hadOld = imageExists(oldRef);
      if (!hadOld) run('docker', ['pull', oldRef]);
      if (!hadOld) ctx.created.push(oldRef);
      ctx.sizeRefs.push(oldRef);
      ctx.summary.upgradeFrom = oldRef;
      // Phase 1: last release on fresh volumes with image-generated secrets (the real upgrade path).
      let pwEnv = upStack(ctx, oldRef, { generatedSecrets: true });
      status = playwright({ ...pwEnv, E2E_PHASE: 'upgrade-seed' }, ['upgrade.spec.ts'], 'chromium');
      if (status !== 0 || interrupted) throw new Error('upgrade seed phase failed');
      compose(project, ['stop', 'rmab'], ctx.env);
      compose(project, ['rm', '-f', 'rmab'], ctx.env);
      // Phase 2: branch image on the same volumes.
      pwEnv = upStack(ctx, image, { generatedSecrets: true });
      status = playwright({ ...pwEnv, E2E_PHASE: 'upgrade-verify' }, ['upgrade.spec.ts'], 'chromium');
    } else {
      const pwEnv = upStack(ctx, image);
      const specs = opts.command === 'preview' ? ['preview-seed.spec.ts'] : opts.specs.split(',').map((s) => s.trim());
      status = playwright({ ...pwEnv, E2E_PHASE: opts.command }, specs, 'chromium');
    }
  } catch (error) {
    console.error(`[e2e] ${error.message}`);
    ctx.summary.error = error.message;
    if (status === 0) status = 2;
  } finally {
    await collectEvidence(ctx);
    if (opts.command === 'preview') {
      // The preview stays up; only the replaced preview image is removed.
      if (opts['replace-image'] && opts['replace-image'] !== opts.image) run('docker', ['image', 'rm', opts['replace-image']], { allowFail: true });
    } else {
      cleanupRun({ project, env: ctx.env, images: ctx.created });
    }
    const df = dockerDf();
    fs.writeFileSync(path.join(evidence, 'docker-df.txt'), `${df.raw}\n`);
    Object.assign(ctx.summary, { status, finishedAt: new Date().toISOString(), dfAfterGB: df.total.toFixed(1), removedImages: opts.command === 'preview' ? [] : ctx.created });
    if (df.total > 50) warn(`docker system df still ${df.total.toFixed(1)} GB after cleanup`);
    fs.writeFileSync(path.join(evidence, 'summary.json'), `${JSON.stringify(ctx.summary, null, 2)}\n`);
    console.log(`[e2e] ${status === 0 ? 'PASS' : 'FAIL'} — evidence: ${evidence}`);
  }
  return status;
}

function unit(opts) {
  const evidence = evidenceDir(opts);
  setCommandLog(path.join(evidence, 'commands.log'));
  const tag = `rmab-e2e/${opts.slug}-unit:${gitShortSha(opts.worktree)}`;
  let status = 1;
  try {
    // Harness-owned Dockerfile (+ Dockerfile.test.dockerignore) from this trusted checkout; the worktree is context only.
    run('docker', ['build', '-f', path.join(E2E_DIR, 'Dockerfile.test'), '-t', tag, '--label', LABEL, '--label', `rmab-e2e.slug=${opts.slug}`, opts.worktree]);
    const res = spawnSync('docker', ['run', '--rm', '--network', 'none', '--user', 'node', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '4096', tag], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
    fs.writeFileSync(path.join(evidence, 'unit.log'), `${res.stdout || ''}\n${res.stderr || ''}`);
    process.stdout.write((res.stdout || '').split(/\r?\n/).slice(-25).join('\n') + '\n');
    status = res.status ?? 1;
  } catch (error) {
    console.error(`[e2e] ${error.message}`);
  } finally {
    run('docker', ['image', 'rm', tag], { allowFail: true });
    cleanupRun({ project: `rmab-e2e-${opts.slug}-unit`, env: { E2E_SLUG: `${opts.slug}-unit`, RMAB_IMAGE: 'unused', RMAB_PORT: '0' }, images: [] });
    console.log(`[e2e] unit ${status === 0 ? 'PASS' : 'FAIL'} — log: ${path.join(evidence, 'unit.log')}`);
  }
  return status;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.command === 'down') {
    cleanupRun({ project: `rmab-e2e-${opts.slug}`, env: { E2E_SLUG: opts.slug, RMAB_IMAGE: 'unused', RMAB_PORT: '0' }, images: [`rmab-e2e/fake-arr:${opts.slug}`] });
    return 0;
  }
  if (opts.command === 'unit') return unit(opts);
  return stackOrPreview(opts);
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`[e2e] ${error.message}`);
    process.exit(2);
  }
);
