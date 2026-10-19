/**
 * Component: E2E fake-arr shared state (config, fixtures, scenario, request recorder)
 * Documentation: documentation/testing/e2e-harness.md
 */

import fs from 'node:fs';
import path from 'node:path';
import { buildTorrent, buildNzb, buildMagnet, magnetHash } from './bencode.js';

export function loadConfig(env = process.env) {
  return {
    prowlarrApiKey: env.PROWLARR_API_KEY || 'rmab-e2e-canary-prowlarr-key',
    qbitUser: env.QBIT_USER || 'e2e',
    qbitPass: env.QBIT_PASS || 'e2e-password',
    sabApiKey: env.SAB_API_KEY || 'rmab-e2e-sab-key',
    plexToken: env.PLEX_TOKEN || 'rmab-e2e-plex-token',
    puid: Number(env.PUID || 1000),
    pgid: Number(env.PGID || 1000),
    fixturesDir: env.FIXTURES_DIR || '/fixtures',
    scenariosDir: env.SCENARIOS_DIR || '/scenarios',
    downloadsDir: env.DOWNLOADS_DIR || '/downloads',
    mediaDir: env.MEDIA_DIR || '/media',
    publicHost: env.PUBLIC_HOST || 'fake-arr',
    trackerHost: env.TRACKER_HOST || 'tracker.e2e',
    ports: {
      prowlarr: Number(env.PROWLARR_PORT || 9696),
      tracker: Number(env.TRACKER_PORT || 9797),
      qbit: Number(env.QBIT_PORT || 8081),
      sab: Number(env.SAB_PORT || 8085),
      plex: Number(env.PLEX_PORT || 32400),
      control: Number(env.CONTROL_PORT || 9999),
    },
    defaultScenario: env.SCENARIO || 'smoke',
  };
}

const MAX_RECORDS = 5000;

export class State {
  constructor(config) {
    this.config = config;
    this.fixtureIndex = readJson(path.join(config.fixturesDir, 'index.json'));
    this.reset();
  }

  reset() {
    this.seq = 0;
    this.records = [];
    this.scenario = null;
    this.releases = new Map(); // id -> release (with derived torrent/nzb data)
    this.byHash = new Map(); // infoHash -> release id
    this.torrents = new Map(); // hash -> qbit torrent record
    this.nzbs = new Map(); // nzo_id -> sab job record
    this.qbitCategories = {};
    this.qbitSessions = new Set();
    this.sabCategories = {};
    this.plexRefreshes = 0;
  }

  /** Record one inbound request (all headers kept verbatim: the key-leak checks need them). */
  record(entry) {
    this.seq += 1;
    const rec = { seq: this.seq, ts: Date.now(), ...entry };
    this.records.push(rec);
    if (this.records.length > MAX_RECORDS) this.records.shift();
    return rec;
  }

  listScenarios() {
    if (!fs.existsSync(this.config.scenariosDir)) return [];
    return fs
      .readdirSync(this.config.scenariosDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''));
  }

  loadScenarioByName(name) {
    if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`invalid scenario name: ${name}`);
    const file = path.join(this.config.scenariosDir, `${name}.json`);
    return this.loadScenario(readJson(file));
  }

  /** Replace all state with a scenario definition. */
  loadScenario(def) {
    if (!def || !Array.isArray(def.releases)) throw new Error('scenario must define releases[]');
    this.reset();
    this.scenario = { indexers: [{ id: 1, name: 'E2E Torrents', protocol: 'torrent' }], search: {}, ...def };
    for (const raw of def.releases) {
      const release = this.deriveRelease(raw, def);
      if (this.releases.has(release.id)) throw new Error(`duplicate release id ${release.id}`);
      this.releases.set(release.id, release);
      if (release.infoHash) this.byHash.set(release.infoHash, release.id);
    }
    return this.scenario;
  }

  book(key) {
    const book = this.fixtureIndex.books?.[key];
    if (!book) throw new Error(`unknown book "${key}"`);
    return book;
  }

  fixture(id) {
    const fixture = this.fixtureIndex.fixtures?.[id];
    if (!fixture) throw new Error(`unknown fixture "${id}"`);
    return fixture;
  }

  deriveRelease(raw, def) {
    if (!raw.id || !/^[A-Za-z0-9_-]+$/.test(raw.id)) throw new Error(`release id must be [A-Za-z0-9_-]+: ${raw.id}`);
    const bookKey = raw.book || def.book;
    const book = bookKey ? this.book(bookKey) : {};
    const fill = (s) =>
      String(s).replace(/\{\{(\w+)\}\}/g, (_, k) => {
        if (book[k] === undefined) throw new Error(`template field {{${k}}} not in book ${bookKey}`);
        return book[k];
      });
    const fixture = this.fixture(raw.fixture);
    const protocol = raw.protocol || 'torrent';
    const indexerId = raw.indexerId ?? this.scenario.indexers[0].id;
    const indexer = this.scenario.indexers.find((i) => i.id === indexerId);
    if (!indexer) throw new Error(`release ${raw.id}: unknown indexerId ${indexerId}`);
    const name = fill(raw.name || fixture.folder);
    const files = fixture.files.map((f) => ({ path: f.rel.split('/'), length: f.size }));
    const tracker = `http://${this.config.trackerHost}:${this.config.ports.tracker}/announce`;
    const release = {
      ...raw,
      protocol,
      indexerId,
      indexerName: indexer.name,
      title: fill(raw.title),
      name,
      files,
      sizeBytes: Math.round((raw.sizeMB ?? 300) * 1024 * 1024),
      grab: { statuses: [200], redirects: [], ...(raw.grab || {}) },
      download: { completeMs: 4000, ...(raw.download || {}) },
      grabAttempts: 0,
    };
    if (protocol === 'torrent') {
      if (raw.link === 'magnet') {
        release.infoHash = magnetHash(`${def.name}:${raw.id}`);
        release.magnet = buildMagnet(release.infoHash, name, tracker);
      } else {
        const torrent = buildTorrent({ name, files, announce: tracker });
        release.infoHash = torrent.infoHash;
        release.torrentFile = torrent.buffer;
        release.magnet = buildMagnet(torrent.infoHash, name, tracker);
      }
    } else {
      release.nzbFile = buildNzb({ name, files });
    }
    return release;
  }

  releaseForHash(hash) {
    const id = this.byHash.get(String(hash).toLowerCase());
    return id ? this.releases.get(id) : undefined;
  }

  /** Match an NZB upload back to its release by the <meta type="name"> we emitted. */
  releaseForNzb(buffer) {
    const name = /<meta type="name">([^<]*)<\/meta>/.exec(buffer.toString('utf8'))?.[1];
    if (!name) return undefined;
    const unescaped = name.replace(/&lt;/g, '<').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    return [...this.releases.values()].find((r) => r.protocol === 'usenet' && r.name === unescaped);
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
