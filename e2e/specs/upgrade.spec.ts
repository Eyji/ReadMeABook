/**
 * Component: E2E upgrade spec (last release seeded on fresh volumes → branch image on the same volumes)
 * Documentation: documentation/testing/e2e-harness.md
 *
 * run.mjs --upgrade-from <tag> runs this file twice: E2E_PHASE=upgrade-seed on the release image,
 * then E2E_PHASE=upgrade-verify on the branch image. Both phases use image-generated secrets that
 * persist in the config volume, which is the real upgrade path.
 */

import fs from 'node:fs';
import { test, expect } from '@playwright/test';
import { env, evidencePath, writeEvidence, waitFor, fakeArr, tableRowCounts, urls, Rmab } from '../lib/harness';

const phase = process.env.E2E_PHASE;
const SNAPSHOT = () => evidencePath('upgrade', 'before.json');
// Rows that must survive unchanged; every other table may only grow (jobs, events, caches).
const EXACT_TABLES = ['users', 'audiobooks', 'requests', 'download_history', 'api_tokens', 'blocked_releases'];

test.skip(phase !== 'upgrade-seed' && phase !== 'upgrade-verify', 'upgrade spec only runs via run.mjs --upgrade-from');

test('upgrade-seed: seed requests on the release image and snapshot row counts', async () => {
  test.skip(phase !== 'upgrade-seed');
  const rmab = await Rmab.loginAdmin();
  const books = await fakeArr.books();
  await fakeArr.scenario('preview');
  const seeded: Record<string, string> = {};
  for (const key of ['phm', 'martian', 'artemis']) {
    const res = await rmab.requestBook(books[key]);
    seeded[key] = res.request.id;
  }
  await waitFor('phm available or downloaded', async () => ['downloaded', 'available'].includes((await rmab.findRequest(books.phm.asin))?.status), { timeoutMs: 300_000, intervalMs: 3_000 });
  await waitFor('artemis failed', async () => (await rmab.findRequest(books.artemis.asin))?.status === 'failed', { timeoutMs: 300_000, intervalMs: 3_000 });
  const requests = await rmab.get<{ requests: any[] }>('/api/requests?limit=100');
  const counts = tableRowCounts();
  expect(counts.requests).toBe(3);
  writeEvidence('upgrade/before.json', {
    counts,
    statuses: Object.fromEntries(requests.requests.map((r) => [r.audiobook?.audibleAsin, r.status])),
    seeded,
    version: await (await fetch(`${urls.rmab()}/api/health`)).json().catch(() => null),
  });
});

test('upgrade-verify: branch image keeps data, logins and decryptable secrets', async ({ page }) => {
  test.skip(phase !== 'upgrade-verify');
  const before = JSON.parse(fs.readFileSync(SNAPSHOT(), 'utf8'));
  const health = await fetch(`${urls.rmab()}/api/health`);
  expect(health.ok).toBe(true);

  // Admin login still works (password hash + JWT secrets carried over in the config volume).
  const rmab = await Rmab.loginAdmin();
  const counts = tableRowCounts();
  writeEvidence('upgrade/after.json', { counts });
  for (const table of EXACT_TABLES) {
    if (table in before.counts) expect.soft(counts[table], `rows in ${table}`).toBe(before.counts[table]);
  }
  for (const [table, n] of Object.entries<number>(before.counts)) {
    expect.soft(counts[table] ?? -1, `table ${table} lost rows`).toBeGreaterThanOrEqual(n);
  }

  // Request statuses survived.
  const requests = await rmab.get<{ requests: any[] }>('/api/requests?limit=100');
  for (const r of requests.requests) {
    const was = before.statuses[r.audiobook?.audibleAsin];
    if (was === 'failed' || was === 'available') expect.soft(r.status, `status of ${r.audiobook?.title}`).toBe(was);
  }

  // Encrypted settings still decrypt: an interactive search needs the stored Prowlarr key, and
  // fake Prowlarr only answers with the exact canary value.
  await fakeArr.scenario('preview');
  const failed = requests.requests.find((r) => r.status === 'failed');
  expect(failed, 'a failed request to search for').toBeTruthy();
  const search = await rmab.post<any>(`/api/requests/${failed.id}/interactive-search`, {});
  writeEvidence('upgrade/interactive-search.json', search);
  const records = await fakeArr.requests();
  const searches = records.filter((r) => r.service === 'prowlarr' && r.path === '/api/v1/search');
  expect(searches.length).toBeGreaterThan(0);
  expect(searches.every((r) => r.headers['x-api-key'] === env('PROWLARR_API_KEY') && r.status === 200)).toBe(true);

  await page.goto('/login');
  await page.locator('#admin-username').fill(env('E2E_ADMIN_USER'));
  await page.locator('#admin-password').fill(env('E2E_ADMIN_PASSWORD'));
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30_000 });
  await page.goto('/requests');
  await page.screenshot({ path: evidencePath('upgrade', 'requests-after-upgrade.png'), fullPage: true });
});
