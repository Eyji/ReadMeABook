/**
 * Component: Cover Art URL Rules
 * Documentation: documentation/phase3/file-organization.md
 *
 * Cover art is fetched or copied server-side when a book is organized, so only
 * two forms are accepted:
 * - a cached thumbnail path `/api/cache/thumbnails/<file>` (plain file name inside the cache dir)
 * - an https URL on a known Audible/Amazon image host
 */

import path from 'path';

export const THUMBNAIL_CACHE_DIR = '/app/cache/thumbnails';
export const THUMBNAIL_API_PREFIX = '/api/cache/thumbnails/';

/** Image hosts used by Audible and Audnexus cover art (exact host or subdomain) */
export const COVER_ART_HOSTS = ['media-amazon.com', 'ssl-images-amazon.com', 'images-amazon.com'];

/** Max size of a downloaded cover image (bytes) */
export const MAX_COVER_ART_BYTES = 20 * 1024 * 1024;

const CACHE_FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Absolute path of a cached thumbnail for `/api/cache/thumbnails/<file>`, or null if not that form. */
export function cachedThumbnailPath(url: string | null | undefined): string | null {
  if (!url || !url.startsWith(THUMBNAIL_API_PREFIX)) return null;
  const filename = url.slice(THUMBNAIL_API_PREFIX.length);
  if (!CACHE_FILE_PATTERN.test(filename) || filename.includes('..')) return null;
  return path.join(THUMBNAIL_CACHE_DIR, filename);
}

/** True for an https URL on a known cover image host (no credentials). */
export function isAllowedRemoteCoverUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return false;
  const host = parsed.hostname.toLowerCase();
  return COVER_ART_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

/** Keep a client-supplied cover URL only when it is one of the accepted forms. */
export function sanitizeCoverArtUrl(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  return cachedThumbnailPath(url) || isAllowedRemoteCoverUrl(url) ? url : undefined;
}
