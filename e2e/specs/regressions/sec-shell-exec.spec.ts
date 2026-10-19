/**
 * Component: E2E acceptance spec - media tools must not run through a shell
 * Documentation: documentation/testing/e2e-harness.md
 *
 * Untracked harness spec (added by the harness tester; not part of the chore/e2e-harness branch).
 *
 * Drives the real download+organize path: a multi-file mp3 release whose download FOLDER name
 * (the torrent/release name, which is attacker-controlled by the indexer) carries shell
 * metacharacters. With chapter merging enabled, every chapter file path handed to ffprobe/ffmpeg
 * contains that folder. If a media tool is spawned through a shell, the embedded `$(...)` / backtick
 * command substitution runs and drops a sentinel file inside the rmab container.
 *
 * Fixed code (execFile/spawn argv arrays): no shell -> no sentinel -> this spec PASSES.
 * Vulnerable code (promisified exec): sentinel is created -> this spec FAILS.
 */

import { test, expect, type Page } from '@playwright/test';
import { snap, env, writeEvidence, waitFor, Rmab, stackExec } from '../../lib/harness';

const shot = (page: Page, name: string) => snap(page, 'sec-shell-exec', name);

// Distinctive sentinel basenames (no '/': a path component cannot contain one). If a shell ever
// evaluates the folder name, these are touched in ffprobe's cwd.
const SENTINELS = ['rmab_pwned_dollar', 'rmab_pwned_tick'];

// Download folder name = attacker-controlled release name. Contains a command substitution,
// a backtick pair, a single quote and spaces - exactly the metacharacters under test.
const PAYLOAD_FOLDER = "RMAB $(touch " + SENTINELS[0] + ") `touch " + SENTINELS[1] + "` O'Brien";

function findSentinels(): string[] {
  // Search the rmab container's whole filesystem for any sentinel the shell would have dropped.
  const out = stackExec('rmab', [
    'sh', '-c',
    `find / -xdev -name 'rmab_pwned_*' 2>/dev/null; true`,
  ]);
  return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

test('media tools run without a shell: metacharacter file paths do not execute during chapter merge', async ({ page }) => {
  const control = env('E2E_CONTROL_URL');

  // Resolve the fixture book metadata (title/author/narrator) from fake-arr.
  const books: Record<string, any> = await (await fetch(`${control}/__control/books`)).json();
  const book = books.phm;

  const rmab = await Rmab.loginAdmin();

  await test.step('enable chapter merging through the admin settings API', async () => {
    const settings = await rmab.get<{ paths: any }>('/api/admin/settings');
    const paths = { ...settings.paths, chapterMergingEnabled: true };
    const res = await rmab.raw('PUT', '/api/admin/settings/paths', paths);
    expect(res.ok, `PUT settings/paths -> ${res.status}`).toBeTruthy();
    const after = await rmab.get<{ paths: any }>('/api/admin/settings');
    expect(after.paths.chapterMergingEnabled).toBe(true);
    writeEvidence('sec-shell-exec/settings-paths.json', after.paths);
  });

  await test.step('inject a 3-file mp3 release whose download folder carries shell metacharacters', async () => {
    const definition = {
      name: 'sec-shell-exec',
      book: 'phm',
      indexers: [{ id: 1, name: 'E2E Torrents', protocol: 'torrent', priority: 25 }],
      releases: [
        {
          id: 'metachar',
          // Title is clean so RMAB's matcher/ranker pairs it with the requested book...
          title: '{{author}} - {{title}} (Unabridged) [MP3 64kbps]',
          // ...but the torrent NAME (the on-disk download folder) is the hostile input.
          name: PAYLOAD_FOLDER,
          sizeMB: 420,
          seeders: 60,
          fixture: 'phm-mp3',
        },
      ],
    };
    const res = await fetch(`${control}/__control/scenario`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ definition }),
    });
    const body = await res.json();
    expect(res.ok, `scenario load -> ${res.status} ${JSON.stringify(body)}`).toBeTruthy();
    expect(body.releases).toContain('metachar');
    writeEvidence('sec-shell-exec/scenario.json', { payloadFolder: PAYLOAD_FOLDER, sentinels: SENTINELS, result: body });
  });

  await test.step('no sentinel exists before the download (baseline)', async () => {
    const pre = findSentinels();
    writeEvidence('sec-shell-exec/sentinels-before.txt', pre.join('\n') || '(none)');
    expect(pre, 'sentinel present before the run - stale container state').toEqual([]);
  });

  await test.step('sign in and request the book from its search card', async () => {
    await page.goto('/login');
    await page.locator('#admin-username').fill(env('E2E_ADMIN_USER'));
    await page.locator('#admin-password').fill(env('E2E_ADMIN_PASSWORD'));
    await page.getByRole('button', { name: 'Login', exact: true }).click();
    await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30_000 });

    await page.goto('/search');
    await page.getByPlaceholder('Search by title, author, or narrator...').fill(book.title);
    const card = page.locator(`article[aria-label^="View details for ${book.title} by"]`).first();
    await expect(card).toBeVisible({ timeout: 60_000 });
    await shot(page, '01-search-results');
    await card.hover();
    await card.getByRole('button', { name: 'Request', exact: true }).click();
    await shot(page, '02-requested');
  });

  const findMine = async () => {
    const body = await rmab.get<{ requests: any[] }>('/api/requests?limit=100');
    return body.requests.find((r) => r.audiobook?.title === book.title) || null;
  };
  const request = await waitFor('request row', findMine, { timeoutMs: 30_000 });
  writeEvidence('sec-shell-exec/request-created.json', request);

  await test.step('download completes and the organize/chapter-merge step runs', async () => {
    // Reaching a post-organize status means the merge pipeline (and thus ffprobe on the hostile
    // paths) has already executed - that is when a shell, if used, would have fired.
    const done = await waitFor(
      'request organized (downloaded/available/failed)',
      async () => {
        const r = await findMine();
        return r && ['downloaded', 'available', 'failed', 'error'].includes(r.status) ? r : null;
      },
      { timeoutMs: 300_000, intervalMs: 3_000 }
    );
    writeEvidence('sec-shell-exec/request-after-organize.json', done);
    await page.goto('/requests');
    await shot(page, '03-requests-after-organize');
  });

  await test.step('the hostile download folder was really created on disk', async () => {
    const listing = stackExec('rmab', ['sh', '-c', 'ls -la /downloads 2>/dev/null; true']);
    writeEvidence('sec-shell-exec/downloads-listing.txt', listing);
    // The literal payload folder name must be present verbatim (proves the path reached the merge).
    expect(listing, 'payload folder not found under /downloads').toContain('$(touch');
  });

  await test.step('SECURITY: no shell executed - the metacharacter sentinel must not exist', async () => {
    const after = findSentinels();
    writeEvidence('sec-shell-exec/sentinels-after.txt', after.join('\n') || '(none)');
    // Fails on vulnerable (shell) code where the sentinel was dropped; passes on the fixed argv code.
    expect(after, `shell command substitution executed; sentinels created: ${JSON.stringify(after)}`).toEqual([]);
  });
});
