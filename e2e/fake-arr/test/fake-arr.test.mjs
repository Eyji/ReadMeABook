/**
 * Component: E2E fake-arr unit tests (node:test, host-run, real HTTP on ephemeral ports)
 * Documentation: documentation/testing/e2e-harness.md
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startFakeArr } from '../src/server.js';
import { loadConfig } from '../src/state.js';
import { generate } from '../../fixtures/generate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const E2E = path.resolve(HERE, '../..');
// parse-torrent is the exact library RMAB uses to read .torrent files (qbittorrent.service.ts).
const { default: parseTorrent } = await import(pathToFileURL(path.join(E2E, '..', 'node_modules', 'parse-torrent', 'index.js')).href);

let tmp;
let fa;
let cfg;
const KEY = 'test-canary-key';

const base = (svc) => `http://127.0.0.1:${cfg.ports[svc]}`;
const control = (p, body) =>
  fetch(`${base('control')}/__control${p}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}).then((r) => r.json());
const posix = (p) => p.split(path.sep).join('/');

async function loadDef(def) {
  const res = await control('/scenario', { definition: def });
  assert.equal(res.ok, true, JSON.stringify(res));
}

async function qbitLogin() {
  const res = await fetch(`${base('qbit')}/api/v2/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'e2e', password: 'pw' }),
  });
  assert.equal(await res.text(), 'Ok.');
  return res.headers.get('set-cookie').split(';')[0];
}

async function search(query = 'Fixture') {
  const res = await fetch(`${base('prowlarr')}/api/v1/search?query=${encodeURIComponent(query)}&type=search`, { headers: { 'X-Api-Key': KEY } });
  assert.equal(res.status, 200);
  return res.json();
}

async function waitFor(fn, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-arr-'));
  await generate({
    out: path.join(tmp, 'fixtures'),
    manifest: path.join(E2E, 'fixtures', 'manifest.json'),
    metadata: path.join(E2E, 'fixtures', 'test', 'offline-metadata.json'),
    ffmpeg: process.env.FFMPEG || 'ffmpeg',
  });
  fs.mkdirSync(path.join(tmp, 'downloads'));
  fs.mkdirSync(path.join(tmp, 'media', 'audiobooks'), { recursive: true });
  cfg = loadConfig({
    PROWLARR_API_KEY: KEY,
    QBIT_USER: 'e2e',
    QBIT_PASS: 'pw',
    SAB_API_KEY: 'sabkey',
    PLEX_TOKEN: 'plextoken',
    FIXTURES_DIR: path.join(tmp, 'fixtures'),
    SCENARIOS_DIR: path.join(E2E, 'scenarios'),
    DOWNLOADS_DIR: posix(path.join(tmp, 'downloads')),
    MEDIA_DIR: posix(path.join(tmp, 'media')),
    PUBLIC_HOST: '127.0.0.1',
    TRACKER_HOST: 'localhost',
    PROWLARR_PORT: '0', TRACKER_PORT: '0', QBIT_PORT: '0', SAB_PORT: '0', PLEX_PORT: '0', CONTROL_PORT: '0',
    SCENARIO: 'smoke',
  });
  fa = await startFakeArr(cfg);
});

after(async () => {
  await fa?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('every committed scenario loads against the fixture index', async () => {
  for (const name of await control('/scenarios')) {
    const res = await control('/scenario', { name });
    assert.equal(res.ok, true, `${name}: ${res.error}`);
  }
});

test('prowlarr: key required; results are Prowlarr-shaped with apikey/link/file download URLs', async () => {
  await control('/scenario', { name: 'smoke' });
  assert.equal((await fetch(`${base('prowlarr')}/api/v1/search?query=x`)).status, 401);
  const viaQuery = await fetch(`${base('prowlarr')}/api/v1/indexer?apikey=${KEY}`);
  assert.equal(viaQuery.status, 200);
  const results = await search('Fixture Book One Test Author');
  assert.equal(results.length, 2);
  const good = results.find((r) => r.title.includes('Unabridged'));
  assert.equal(good.title, 'Test Author - Fixture Book One (Unabridged) [MP3 64kbps]');
  assert.equal(good.size, 420 * 1024 * 1024);
  const u = new URL(good.downloadUrl);
  assert.match(u.pathname, /^\/1\/download$/);
  assert.equal(u.searchParams.get('apikey'), KEY);
  assert.ok(u.searchParams.get('link'));
  assert.equal(u.searchParams.get('file'), 'Fixture Book One');
  assert.equal(good.protocol, 'torrent');
  assert.equal(good.categories[0].id, 3030);
});

test('prowlarr: RSS feed is torznab XML with links', async () => {
  const res = await fetch(`${base('prowlarr')}/1/api?apikey=${KEY}&t=search&cat=3030`);
  const xml = await res.text();
  assert.match(xml, /<rss/);
  assert.match(xml, /torznab:attr name="seeders"/);
  assert.match(xml, /\/1\/download\?apikey=/);
});

test('grab: status sequence repeats its last value, then served torrent parses with the RMAB parser', async () => {
  await loadDef({
    name: 'unit-503',
    book: 'martian',
    releases: [
      { id: 'A', title: '{{author}} - {{title}} [M4B]', fixture: 'martian-m4b', grab: { statuses: [503, 429, 200] } },
      { id: 'B', title: '{{author}} - {{title}} [MP3]', fixture: 'martian-mp3', grab: { statuses: [503] } },
    ],
  });
  const [a, b] = await search('Fixture Book Two');
  const statusesA = [];
  for (let i = 0; i < 4; i++) statusesA.push((await fetch(a.downloadUrl)).status);
  assert.deepEqual(statusesA, [503, 429, 200, 200]);
  for (let i = 0; i < 3; i++) assert.equal((await fetch(b.downloadUrl)).status, 503);
  const body = Buffer.from(await (await fetch(a.downloadUrl)).arrayBuffer());
  const parsed = await parseTorrent(body);
  assert.equal(parsed.infoHash, a.infoHash);
  assert.equal(parsed.name, 'Fixture Book Two');
  assert.equal(parsed.files.length, 1);
  const noKey = new URL(a.downloadUrl);
  noKey.searchParams.delete('apikey');
  assert.equal((await fetch(noKey)).status, 401);
  assert.equal((await fetch(noKey, { headers: { 'X-Api-Key': KEY } })).status, 200);
});

test('redirect knobs: other-port, tracker, relative, magnet at hop 2, direct; recorder keeps listener + headers', async () => {
  await control('/scenario', { name: 'key-scope' });
  const results = await search('Fixture Book One');
  const t = (suffix) => results.find((r) => r.protocol === 'torrent' && r.title.endsWith(` ${suffix}`));

  const other = await fetch(t('other-port').downloadUrl, { redirect: 'manual' });
  assert.equal(other.status, 302);
  assert.equal(other.headers.get('location'), `http://127.0.0.1:${cfg.ports.tracker}/t/t-other-port/0`);

  const tracker = await fetch(t('tracker').downloadUrl, { redirect: 'manual' });
  assert.equal(tracker.headers.get('location'), `http://localhost:${cfg.ports.tracker}/t/t-tracker/0`);

  const rel = await fetch(t('relative').downloadUrl, { redirect: 'manual' });
  assert.equal(rel.headers.get('location'), '/t/t-relative/0');
  const relBody = await fetch(new URL(rel.headers.get('location'), t('relative').downloadUrl));
  assert.equal(relBody.headers.get('content-type'), 'application/x-bittorrent');

  const hop1 = await fetch(t('magnet-hop2').downloadUrl, { redirect: 'manual' });
  const hop2 = await fetch(hop1.headers.get('location'), { redirect: 'manual' });
  assert.equal(hop2.status, 302);
  assert.match(hop2.headers.get('location'), /^magnet:\?xt=urn:btih:[0-9a-f]{40}/);

  const direct = t('direct').downloadUrl;
  assert.equal(new URL(direct).port, String(cfg.ports.tracker));
  assert.equal(new URL(direct).searchParams.get('apikey'), null);
  assert.equal((await fetch(direct, { headers: { 'X-Api-Key': KEY } })).status, 200);

  // Following a chain with fetch() forwards custom headers across origins: the recorder must show it.
  await fetch(t('tracker').downloadUrl, { headers: { 'X-Api-Key': KEY } });
  const records = await fetch(`${base('control')}/__control/requests`).then((r) => r.json());
  const trackerHits = records.filter((r) => r.listener === cfg.ports.tracker && r.path.startsWith('/t/t-tracker/'));
  assert.ok(trackerHits.length >= 1);
  assert.equal(trackerHits.at(-1).headers['x-api-key'], KEY);
  assert.equal(trackerHits.at(-1).service, 'tracker');
  const usenet = results.filter((r) => r.protocol === 'usenet');
  assert.equal(usenet.length, 4);
});

test('qbit: auth, category, multipart add, progress with non-zero dlspeed, completion drops files, delete', async () => {
  await loadDef({ name: 'unit-qbit', book: 'phm', releases: [{ id: 'q', title: '{{title}} [MP3]', fixture: 'phm-mp3', download: { completeMs: 600 } }] });
  assert.equal((await fetch(`${base('qbit')}/api/v2/torrents/info`)).status, 403);
  const cookie = await qbitLogin();
  const h = { Cookie: cookie };
  const form = (o) => ({ method: 'POST', headers: { ...h, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o) });
  await fetch(`${base('qbit')}/api/v2/torrents/createCategory`, form({ category: 'readmeabook', savePath: cfg.downloadsDir }));
  const cats = await fetch(`${base('qbit')}/api/v2/torrents/categories`, { headers: h }).then((r) => r.json());
  assert.equal(cats.readmeabook.savePath, cfg.downloadsDir);
  assert.equal(await fetch(`${base('qbit')}/api/v2/app/version`, { headers: h }).then((r) => r.text()), 'v4.6.5');

  const [rel] = await search('Fixture Book One');
  const torrent = Buffer.from(await (await fetch(rel.downloadUrl)).arrayBuffer());
  const fd = new FormData();
  fd.append('torrents', new Blob([torrent], { type: 'application/x-bittorrent' }), 'x.torrent');
  fd.append('category', 'readmeabook');
  fd.append('paused', 'false');
  assert.equal(await fetch(`${base('qbit')}/api/v2/torrents/add`, { method: 'POST', headers: h, body: fd }).then((r) => r.text()), 'Ok.');

  const info = async () => (await fetch(`${base('qbit')}/api/v2/torrents/info?hashes=${rel.infoHash}`, { headers: h }).then((r) => r.json()))[0];
  const first = await info();
  assert.equal(first.state, 'downloading');
  assert.ok(first.dlspeed > 0);
  assert.equal(first.content_path, `${cfg.downloadsDir}/Fixture Book One`);
  const done = await waitFor(async () => {
    const t = await info();
    return t.state === 'uploading' ? t : null;
  });
  assert.equal(done.progress, 1);
  assert.ok(done.completion_on > 0);
  assert.ok(fs.existsSync(path.join(done.content_path, '01 - Chapter 1.mp3')));
  const files = await fetch(`${base('qbit')}/api/v2/torrents/files?hash=${rel.infoHash}`, { headers: h }).then((r) => r.json());
  assert.equal(files.length, 3);

  const st = await control('/state');
  assert.equal(st.torrents[0].releaseId, 'q');
  await fetch(`${base('qbit')}/api/v2/torrents/delete`, form({ hashes: rel.infoHash, deleteFiles: 'true' }));
  assert.equal((await fetch(`${base('qbit')}/api/v2/torrents/info`, { headers: h }).then((r) => r.json())).length, 0);
  assert.equal(fs.existsSync(done.content_path), false);
});

test('qbit: magnet add, stall knob holds progress at 0 B/s, fail knob reports error', async () => {
  await loadDef({
    name: 'unit-knobs',
    book: 'phm',
    releases: [
      { id: 'm', link: 'magnet', title: '{{title}} magnet', fixture: 'phm-mp3', download: { completeMs: 200, stallAtPct: 50 } },
      { id: 'f', title: '{{title}} fail', fixture: 'phm-mp3', download: { completeMs: 200, failAtPct: 30 } },
    ],
  });
  const results = await search('Fixture');
  const magnet = results.find((r) => r.magnetUrl);
  assert.equal(magnet.downloadUrl, undefined);
  const cookie = await qbitLogin();
  const add = (o) => fetch(`${base('qbit')}/api/v2/torrents/add`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o) }).then((r) => r.text());
  assert.equal(await add({ urls: magnet.magnetUrl, category: 'readmeabook' }), 'Ok.');
  const failing = results.find((r) => r.title.endsWith('fail'));
  assert.equal(await add({ urls: `magnet:?xt=urn:btih:${failing.infoHash}` }), 'Ok.');
  await new Promise((r) => setTimeout(r, 300));
  const list = await fetch(`${base('qbit')}/api/v2/torrents/info`, { headers: { Cookie: cookie } }).then((r) => r.json());
  const stalled = list.find((t) => t.hash === magnet.infoHash);
  assert.equal(stalled.state, 'stalledDL');
  assert.equal(stalled.progress, 0.5);
  assert.equal(stalled.dlspeed, 0);
  assert.equal(list.find((t) => t.hash === failing.infoHash).state, 'error');
});

test('sab: config, set_config category, addfile, queue then history with storage + files', async () => {
  await loadDef({ name: 'unit-sab', book: 'phm', indexers: [{ id: 2, name: 'U', protocol: 'usenet' }], releases: [{ id: 'n', protocol: 'usenet', indexerId: 2, title: '{{title}} nzb', fixture: 'phm-m4b', download: { completeMs: 400 } }] });
  const api = (q) => fetch(`${base('sab')}/api?${new URLSearchParams({ output: 'json', apikey: 'sabkey', ...q })}`).then((r) => r.json());
  assert.equal((await fetch(`${base('sab')}/api?mode=version&apikey=bad`).then((r) => r.json())).status, false);
  assert.equal((await api({ mode: 'version' })).version, '4.3.3');
  await api({ mode: 'set_config', section: 'categories', keyword: 'readmeabook', dir: 'readmeabook' });
  const conf = await api({ mode: 'get_config' });
  assert.equal(conf.config.misc.complete_dir, cfg.downloadsDir);
  assert.ok(Array.isArray(conf.config.categories));
  const [rel] = await search('Fixture');
  const nzb = Buffer.from(await (await fetch(rel.downloadUrl)).arrayBuffer());
  const fd = new FormData();
  fd.append('nzbfile', new Blob([nzb], { type: 'application/x-nzb' }), 'x.nzb');
  for (const [k, v] of Object.entries({ mode: 'addfile', cat: 'readmeabook', output: 'json', apikey: 'sabkey' })) fd.append(k, v);
  const added = await fetch(`${base('sab')}/api`, { method: 'POST', body: fd }).then((r) => r.json());
  assert.equal(added.status, true);
  const id = added.nzo_ids[0];
  const q = await api({ mode: 'queue' });
  assert.equal(q.queue.slots[0].nzo_id, id);
  const slot = await waitFor(async () => (await api({ mode: 'history' })).history.slots.find((s) => s.nzo_id === id));
  assert.equal(slot.status, 'Completed');
  assert.equal(slot.storage, `${cfg.downloadsDir}/readmeabook/Fixture Book One`);
  assert.ok(fs.existsSync(path.join(slot.storage, 'Fixture Book One.m4b')));
  await api({ mode: 'history', name: 'delete', value: id });
  assert.equal((await api({ mode: 'history' })).history.slots.length, 0);
});

test('plex: identity, sections, library listing from the media volume, refresh counter', async () => {
  const hdr = { 'X-Plex-Token': 'plextoken', Accept: 'application/json' };
  assert.equal((await fetch(`${base('plex')}/identity`)).status, 401);
  const id = await fetch(`${base('plex')}/identity`, { headers: hdr }).then((r) => r.json());
  assert.ok(id.MediaContainer.machineIdentifier);
  const sections = await fetch(`${base('plex')}/library/sections`, { headers: hdr }).then((r) => r.json());
  assert.equal(sections.MediaContainer.Directory[0].Location[0].path, `${cfg.mediaDir}/audiobooks`);
  fs.mkdirSync(path.join(tmp, 'media', 'audiobooks', 'Test Author', 'Fixture Book One'), { recursive: true });
  const all = await fetch(`${base('plex')}/library/sections/1/all?type=9`, { headers: hdr }).then((r) => r.json());
  assert.equal(all.MediaContainer.Metadata[0].title, 'Fixture Book One');
  assert.equal(all.MediaContainer.Metadata[0].parentTitle, 'Test Author');
  await fetch(`${base('plex')}/library/sections/1/refresh`, { headers: hdr });
  assert.equal((await control('/state')).plexRefreshes, 1);
});
