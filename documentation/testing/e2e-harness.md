# E2E Harness

**Status:** ⏳ In Progress | Disposable per-branch Docker stack + Playwright, fakes for every *arr/download client

## Overview
`e2e/` stands up an isolated stack for any branch (RMAB image under test, real Audiobookshelf, `fake-arr`), bootstraps setup over the API, drives Chromium and the API, saves evidence, and tears everything down.

## Commands (run from a TRUSTED checkout)
| Command | Does |
|---|---|
| `npm run e2e -- --slug <s> --port <3401-3499> --worktree <dir>` | Build `rmab-e2e/<s>:<sha>` from `<dir>`, run smoke, clean up |
| `npm run e2e -- --slug <s> --port <p> --image <ref> [--rm-image]` | Use an existing image (kept unless `--rm-image`) |
| `... --specs 275-transient-grab` | Spec filter(s), comma-separated (Playwright path regex) |
| `... --dockerfile <file>` | Override the Dockerfile (e.g. old commit + current `dockerfile.unified`) |
| `... --upgrade-from 1.2.3` | Upgrade test: `ghcr.io/kikootwo/readmeabook:1.2.3` (no `v`) → branch image, same volumes |
| `... --backend plex` | Plex-mode setup against fake Plex + local admin |
| `... --offline-fixtures` | Fixture metadata from `fixtures/test/offline-metadata.json` (no Audnexus) |
| `... --evidence <dir>` | Evidence root (default `$E2E_EVIDENCE_DIR` or `%TEMP%/rmab-e2e-evidence`); refused inside a build context |
| `npm run e2e:unit -- --slug <s> --worktree <dir>` | Containerized `npm test` (mandatory for untrusted worktrees) |
| `npm run e2e -- preview --image <ref> [--replace-image <old>]` | `rmab-e2e-preview` on 127.0.0.1:3400, seeded, no teardown |
| `npm run e2e -- down --slug <s>` | Cleanup only |
| `npm run e2e:selftest` | Host unit tests for fake-arr + fixture generator (needs ffmpeg/ffprobe) |

- Exit code: 0 pass, 1 spec failure, 2 harness error. Evidence: `summary.json`, `commands.log`, `compose.log`, `fake-arr-requests.json`, `docker-df.txt`, `results*.json`, `report*/`, `test-results*/` (traces), per-spec screenshots/JSON.
- Prereqs (host): Docker, Node ≥20, `npm ci`, `npx playwright install chromium` (Playwright `1.56.1`, Chromium only).

## Trust split
- Harness code (`run.mjs`, `compose.yml`, specs, `Dockerfile.test` + `.dockerignore`) always comes from the trusted checkout; `--worktree` is only a Docker build context. Nothing in it runs on the host.
- `e2e:unit`: `npm ci --ignore-scripts`, then only `npm rebuild @prisma/engines prisma bcrypt esbuild unrs-resolver`; `prisma generate` with `--network=none`; tests run `--network none --user node --cap-drop ALL`, no mounts.

## Stack (`e2e/compose.yml`, project `rmab-e2e-<slug>`)
| Service | Image | Host port |
|---|---|---|
| `rmab` | `${RMAB_IMAGE}` | `127.0.0.1:${RMAB_PORT}:3030` |
| `abs` | `docker.io/advplyr/audiobookshelf:2.37.1@sha256:581d68…` (same index digest as ghcr) | `127.0.0.1::80` (ephemeral) |
| `fake-arr` | `rmab-e2e/fake-arr:<slug>` (built, `node:20-alpine@sha256:fb4cd1…`) | `127.0.0.1::9999` (control, ephemeral) |
- Named volumes only: `rmab-config`, `rmab-cache`, `pgdata`, `redis`, `downloads` (rmab+fake-arr), `media` (rmab+abs+fake-arr), `abs-config`, `abs-metadata`.
- Ephemeral ports are read with `docker compose port`. fake-arr (root) chowns `/downloads`, `/media`, `/media/audiobooks` to `PUID:PGID` before RMAB starts (nothing in the RMAB image does).
- Fixed fake values: `e2e/.env.test` (committed; `.gitignore` exception). `PROWLARR_API_KEY` is a canary. Upgrade runs pass empty `RMAB_*` secrets so the image generates and persists its own.
- Never use a developer's local `docker-compose.yml`, never `up` the repo-root compose file.

## fake-arr (`e2e/fake-arr/`, zero dependencies)
| Listener | Fakes | Endpoints (source in `src/lib/integrations/`) |
|---|---|---|
| `fake-arr:9696` | Prowlarr | `/api/v1/search` (prowlarr.service.ts:151), `/indexer` :268, `/health` :281, `/indexerstats` :294, `/system/status`, RSS `/{id}/api` :312, grab `/{id}/download?apikey&link&file` |
| `tracker.e2e:9797` / `fake-arr:9797` | foreign origin | `/d/<release>` direct link, `/t/<release>/<hop>` redirect hops, `/announce` |
| `fake-arr:8081` | qBittorrent v2 | `auth/login`, `app/version`, `torrents/{categories,createCategory,editCategory,add,info,files,pause,resume,stop,start,setCategory,delete}` (qbittorrent.service.ts:194-:852) |
| `fake-arr:8085` | SABnzbd | `/api?mode=version,get_config,set_config,addfile,queue[,delete],history[,delete],pause,resume` (sabnzbd.service.ts:155-:753) |
| `fake-arr:32400` | Plex | `/identity`, `/library/sections`, `/sections/1/{all,search,refresh}`, `/library/metadata/<k>` (plex.service.ts:220-:794); plex.tv not faked |
| `:9999` | control | `GET /__control/{health,scenarios,books,requests?since=,state}`, `POST /__control/scenario {name}\|{definition}`, `POST /__control/reset` |
- Grab key: query `apikey` or `X-Api-Key`; wrong/missing → 401. Recorder keeps every request: `seq, service, listener, host, method, path, query, headers, status, location, added[]`.
- Downloads: progress from wall clock; non-zero `dlspeed` while moving; files copied into `<save_path>/<name>/` and chowned on the first poll at 100%, before reporting complete (`uploading` / SAB `Completed`).

## Scenarios (`e2e/scenarios/*.json`)
- Release fields: `id`, `book`, `title` (`{{title}}`, `{{author}}`, `{{asin}}`, `{{narrator}}`), `protocol` torrent\|usenet, `indexerId`, `sizeMB` (keep ≥20: ranking drops <20 MB), `seeders`, `fixture`, `link: "magnet"`.
- `grab`: `statuses` (per attempt, last repeats, e.g. `[503]`), `redirects` (`other-port`\|`tracker`\|`relative`\|`magnet`, one per hop), `direct: true`, `body: "magnet-text"`.
- `download`: `completeMs`, `stallAtPct` (0 B/s, `stalledDL`), `failAtPct` (`error` / SAB `Failed`), `dropFixture` (e.g. `wrong-files`).
- Scenario-level `search.statuses` for transient Prowlarr search failures. Search matches releases containing every query word (≥3 chars).
- Shipped: `smoke`, `transient-grab-503`, `usenet-smoke`, `stall`, `slow`, `wrong-files`, `failed-download`, `key-scope`, `preview`.

## Fixtures (`e2e/fixtures/`)
- `manifest.json` references books by ASIN only; title/author/narrator come from Audnexus at generation time (`--metadata` for offline).
- Generated at fake-arr image build (ffmpeg only in the builder stage): multi-file tagged mp3s (album/album_artist/composer/track), m4b with chapters, `Title [B0…]` folder, `wrong-files`. ~250 KB total.

## Bootstrap (`e2e/bootstrap.ts`, Playwright globalSetup, idempotent)
1. ABS: `/init` root user → `/login` → library `/media/audiobooks` → API key (`/api/api-keys`, legacy token fallback).
2. Wait RMAB `/api/health`; `GET /api/setup/status`.
3. `POST /api/setup/complete` (ABS mode + `authMethod: manual` + local admin; or Plex mode with fake Plex), both fake download clients, indexers 1 (torrent) and 2 (usenet). Already set up → admin login.
4. Writes `<evidence>/auth.json`, `<evidence>/storage-state.json`.

## Specs (`e2e/specs/`)
| Spec | Asserts |
|---|---|
| `smoke.spec.ts` | UI login → search → card Request → qBit add → downloaded → ABS item → `available` (recently-added job triggered) → "In Your Library"; canary never off the Prowlarr origin |
| `regressions/275-transient-grab.spec.ts` | A's grab answered 503, then B fetched after it (fails here on pre-fix code), qBit got only B, request completes |
| `upgrade.spec.ts` | Seed on release image; after upgrade: health, admin login, exact rows in users/audiobooks/requests/download_history/api_tokens/blocked_releases, no table shrinks, statuses kept, stored Prowlarr key decrypts |
| `preview-seed.spec.ts` | Preview has `available`, `downloading`, `failed` requests and one library book |
- Helpers: `e2e/lib/harness.ts` (`Rmab`, `Abs`, `fakeArr`, `keyLeaks`, `waitFor`, `tableRowCounts` via `docker compose exec rmab gosu postgres psql`).

## Cleanup (every stack/unit run, in `finally`, incl. failures and Ctrl-C)
- Before: disk ceiling (`docker system df` images+cache+volumes > 50 GB → prune `rmab-e2e-*` stacks except preview, `rmab-e2e/*` images, cache); `down -v` the project.
- After: `down -v --remove-orphans`; `image rm` images this run built or pulled (+ `--image` with `--rm-image`); `image prune -f --filter label=rmab-e2e=true`; `builder prune -f --keep-storage 15gb` (or `--max-used-space` on newer Docker).
- Kept between runs: only the preview stack and its image.

## Critical Issues
- `setup/complete` with `authMethod: manual` 500s without a `registration` object (after writing part of the config); bootstrap always sends `registration: { require_admin_approval: true }`.
- A daemon with broken ghcr.io credentials fails even public pulls (`denied: denied`). `--upgrade-from` then falls back to `e2e/lib/fetch-image.mjs`: anonymous registry API, every blob sha256-verified, OCI layout → `docker load`.
- Evidence screenshots: explicit 1280x720 JPEGs (`snap()` in `lib/harness.ts`); Playwright's own screenshots are off, traces on.
- `npx playwright install` garbage-collects other Playwright browser builds it considers unused in `%LOCALAPPDATA%\ms-playwright`; set `PLAYWRIGHT_BROWSERS_PATH` to isolate if other projects share the cache.
- Fixture generation needs Audnexus reachable at fake-arr build time unless `--offline-fixtures`.

## Related
- [../testing.md](../testing.md) (unit suite), [../deployment/docker.md](../deployment/docker.md), [../phase3/README.md](../phase3/README.md), [../phase3/qbittorrent.md](../phase3/qbittorrent.md), [../phase3/sabnzbd.md](../phase3/sabnzbd.md), [../backend/services/jobs.md](../backend/services/jobs.md)
