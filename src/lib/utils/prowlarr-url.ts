/**
 * Component: Prowlarr Download URL Rules (key scoping, validation, redaction)
 * Documentation: documentation/phase3/download-clients.md
 *
 * Pure helpers. The Prowlarr API key may only travel to the configured
 * Prowlarr origin, and only on its proxy-download path (`/{indexerId}/download`).
 */

import { REDACTED_QUERY_PARAMS, REDACTED_VALUE } from '@/lib/constants/download-source';

export interface ProwlarrBase {
  origin: string;
  /** Configured URL base path without trailing slash ('' when none) */
  basePath: string;
}

const DOWNLOAD_PATH_PATTERN = /^\/\d+\/download$/i;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseHttpUrl(value: string): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.origin === 'null') return null;
  return parsed;
}

/** Parse the configured Prowlarr URL. Returns null for anything but a plain http(s) URL. */
export function parseProwlarrBase(baseUrl: string | undefined | null): ProwlarrBase | null {
  if (!baseUrl) return null;
  const parsed = parseHttpUrl(baseUrl.trim());
  if (!parsed || parsed.username || parsed.password) return null;
  return { origin: parsed.origin, basePath: parsed.pathname.replace(/\/+$/, '') };
}

/** True when `url` is a Prowlarr proxy-download URL on the configured origin. */
export function isProwlarrDownloadUrl(url: string, base: ProwlarrBase | null): boolean {
  if (!base) return false;
  const parsed = parseHttpUrl(url);
  if (!parsed || parsed.username || parsed.password) return false;
  if (parsed.origin !== base.origin) return false;
  if (!parsed.pathname.startsWith(`${base.basePath}/`)) return false;
  return DOWNLOAD_PATH_PATTERN.test(parsed.pathname.slice(base.basePath.length));
}

/** True for a `magnet:?` URI. */
export function isMagnetUri(url: string): boolean {
  return /^magnet:\?/i.test(url.trim());
}

/**
 * Remove every `apikey` query parameter whose value equals the configured key,
 * on any origin, then mask any other occurrence of the key in the string.
 * Other query bytes are left untouched.
 */
export function stripApiKey(value: string, apiKey: string | undefined | null): string {
  if (!apiKey || !value.includes(apiKey)) return value;
  const param = new RegExp(`([?&])apikey=${escapeRegExp(apiKey)}(?=[&#]|$)&?`, 'gi');
  let result = value.replace(param, '$1').replace(/[?&](?=#|$)/, '');
  if (result.includes(apiKey)) {
    result = result.split(apiKey).join(REDACTED_VALUE);
  }
  return result;
}

/** Return `url` with `apikey=<key>` present (appended before any fragment when missing). */
export function withApiKeyParam(url: string, apiKey: string): string {
  const parsed = new URL(url);
  if (parsed.searchParams.has('apikey')) return url;
  const hashIndex = url.indexOf('#');
  const head = hashIndex === -1 ? url : url.slice(0, hashIndex);
  const tail = hashIndex === -1 ? '' : url.slice(hashIndex);
  const separator = head.includes('?') ? (head.endsWith('?') || head.endsWith('&') ? '' : '&') : '?';
  return `${head}${separator}apikey=${encodeURIComponent(apiKey)}${tail}`;
}

const SECRET_PARAM_PATTERN = new RegExp(
  `([?&](?:${REDACTED_QUERY_PARAMS.map(escapeRegExp).join('|')})=)[^&#]*`,
  'gi'
);

/** Mask secret-looking query values and URL credentials for logs and error messages. */
export function redactUrl(url: string | undefined | null): string {
  if (!url) return '';
  return url
    .replace(SECRET_PARAM_PATTERN, `$1${REDACTED_VALUE}`)
    .replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/i, `$1${REDACTED_VALUE}@`);
}
