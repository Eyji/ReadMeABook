/**
 * Component: E2E public-image fetch fallback (registry HTTP API -> OCI layout -> docker load)
 * Documentation: documentation/testing/e2e-harness.md
 *
 * Used only when `docker pull` of a PUBLIC ghcr.io image fails (e.g. a daemon whose ghcr.io auth is
 * broken while anonymous HTTPS from the host works). Every blob is verified against its sha256
 * digest, so the loaded image is bit-identical to what `docker pull` would have produced.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const INDEX_TYPES = ['application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json'];
const MANIFEST_TYPES = ['application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json'];
const NUL = String.fromCharCode(0);

export function parseRef(ref) {
  const m = /^([^/]+)\/([^:@]+)(?::([^@]+))?(?:@(sha256:[0-9a-f]{64}))?$/.exec(ref);
  if (!m) throw new Error(`cannot parse image ref ${ref}`);
  return { registry: m[1], repo: m[2], tag: m[3] || 'latest', digest: m[4] };
}

/** Minimal ustar writer (names < 100 chars, regular files only); avoids host tar quirks on Windows. */
function writeTar(root, relPaths, out) {
  const fd = fs.openSync(out, 'w');
  const chunk = Buffer.alloc(1 << 20);
  const octal = (n, width) => `${n.toString(8).padStart(width - 1, '0')}${NUL}`;
  try {
    for (const rel of relPaths) {
      const file = path.join(root, rel);
      const size = fs.statSync(file).size;
      const h = Buffer.alloc(512);
      h.write(rel.split(path.sep).join('/'), 0, 100, 'utf8');
      h.write(octal(0o644, 8), 100);
      h.write(octal(0, 8), 108);
      h.write(octal(0, 8), 116);
      h.write(octal(size, 12), 124);
      h.write(octal(Math.floor(Date.now() / 1000), 12), 136);
      h.write(' '.repeat(8), 148);
      h.write('0', 156);
      h.write(`ustar${NUL}00`, 257);
      let sum = 0;
      for (const b of h) sum += b;
      h.write(`${sum.toString(8).padStart(6, '0')}${NUL} `, 148);
      fs.writeSync(fd, h);
      const src = fs.openSync(file, 'r');
      let read;
      while ((read = fs.readSync(src, chunk, 0, chunk.length)) > 0) fs.writeSync(fd, chunk, 0, read);
      fs.closeSync(src);
      const pad = (512 - (size % 512)) % 512;
      if (pad) fs.writeSync(fd, Buffer.alloc(pad));
    }
    fs.writeSync(fd, Buffer.alloc(1024));
  } finally {
    fs.closeSync(fd);
  }
}

async function token(registry, repo) {
  if (registry !== 'ghcr.io') throw new Error(`fetch fallback only supports ghcr.io (got ${registry})`);
  const res = await fetch(`https://ghcr.io/token?scope=repository:${repo}:pull`);
  if (!res.ok) throw new Error(`token: HTTP ${res.status}`);
  return (await res.json()).token;
}

async function getBlob(base, auth, ref, accept, dest) {
  const res = await fetch(`${base}/${accept ? 'manifests' : 'blobs'}/${ref}`, {
    headers: { Authorization: `Bearer ${auth}`, ...(accept ? { Accept: accept.join(',') } : {}) },
  });
  if (!res.ok) throw new Error(`GET ${ref}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const actual = `sha256:${createHash('sha256').update(buf).digest('hex')}`;
  if (ref.startsWith('sha256:') && actual !== ref) throw new Error(`digest mismatch for ${ref}: got ${actual}`);
  if (dest) fs.writeFileSync(dest, buf);
  return { buf, type: res.headers.get('content-type') || '', digest: actual };
}

/** Fetch `ref` (linux/amd64) and `docker load` it, tagged as `<registry>/<repo>:<tag>`. Returns that tag. */
export async function fetchAndLoad(ref, { platform = { os: 'linux', architecture: 'amd64' }, log = console.log } = {}) {
  const { registry, repo, tag, digest } = parseRef(ref);
  const base = `https://${registry}/v2/${repo}`;
  const auth = await token(registry, repo);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmab-e2e-oci-'));
  const blobs = path.join(dir, 'blobs', 'sha256');
  fs.mkdirSync(blobs, { recursive: true });
  const tar = path.join(os.tmpdir(), `rmab-e2e-oci-${Date.now()}.tar`);
  try {
    let top = await getBlob(base, auth, digest || tag, [...INDEX_TYPES, ...MANIFEST_TYPES]);
    let desc;
    if (INDEX_TYPES.some((t) => top.type.startsWith(t))) {
      const index = JSON.parse(top.buf.toString('utf8'));
      desc = index.manifests.find((m) => m.platform?.os === platform.os && m.platform?.architecture === platform.architecture);
      if (!desc) throw new Error(`no ${platform.os}/${platform.architecture} manifest in ${ref}`);
      top = await getBlob(base, auth, desc.digest, MANIFEST_TYPES, path.join(blobs, desc.digest.slice(7)));
    } else {
      fs.writeFileSync(path.join(blobs, top.digest.slice(7)), top.buf);
      desc = { mediaType: top.type, digest: top.digest, size: top.buf.length };
    }
    const manifest = JSON.parse(top.buf.toString('utf8'));
    const all = [manifest.config, ...manifest.layers];
    for (const [i, blob] of all.entries()) {
      log(`[e2e] fetch ${registry}/${repo}: blob ${i + 1}/${all.length} (${(blob.size / 1e6).toFixed(1)} MB)`);
      await getBlob(base, auth, blob.digest, null, path.join(blobs, blob.digest.slice(7)));
    }
    const name = `${registry}/${repo}:${tag}`;
    fs.writeFileSync(path.join(dir, 'oci-layout'), JSON.stringify({ imageLayoutVersion: '1.0.0' }));
    fs.writeFileSync(
      path.join(dir, 'index.json'),
      JSON.stringify({
        schemaVersion: 2,
        manifests: [{ mediaType: desc.mediaType || manifest.mediaType, digest: desc.digest, size: desc.size, annotations: { 'io.containerd.image.name': name, 'org.opencontainers.image.ref.name': tag } }],
      })
    );
    writeTar(dir, ['oci-layout', 'index.json', ...fs.readdirSync(blobs).map((b) => path.join('blobs', 'sha256', b))], tar);
    const load = spawnSync('docker', ['load', '-i', tar], { encoding: 'utf8' });
    if (load.status !== 0) throw new Error(`docker load failed: ${load.stderr}`);
    log(`[e2e] ${load.stdout.trim()}`);
    if (spawnSync('docker', ['image', 'inspect', name], { stdio: 'ignore' }).status !== 0) {
      const id = /sha256:[0-9a-f]{64}/.exec(load.stdout)?.[0];
      if (!id || spawnSync('docker', ['tag', id, name], { stdio: 'inherit' }).status !== 0) throw new Error(`loaded image is not tagged ${name}`);
    }
    return name;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(tar, { force: true });
  }
}
