/**
 * Component: Download Source Fetcher (shared .torrent/.nzb fetch + redirect handling)
 * Documentation: documentation/phase3/download-clients.md
 *
 * Follows redirects one hop at a time (relative or absolute), resolves a magnet
 * at any hop, and attaches the Prowlarr API key only on hops that are a
 * Prowlarr proxy-download URL on the configured Prowlarr origin.
 * Hop-by-hop approach adapted from johannbre's Transmission fix (PR #300).
 */

import axios from 'axios';
import type { Agent as HttpsAgent } from 'https';
import { RMAB_USER_AGENT } from '@/lib/utils/user-agent';
import { RMABLogger } from '@/lib/utils/logger';
import { DownloadSourceError } from '@/lib/interfaces/download-client.interface';
import {
  MAX_MAGNET_BODY_BYTES,
  MAX_SOURCE_FILE_BYTES,
  MAX_SOURCE_REDIRECT_HOPS,
} from '@/lib/constants/download-source';
import {
  isMagnetUri,
  isProwlarrDownloadUrl,
  parseProwlarrBase,
  urlForLog,
  withApiKeyParam,
} from '@/lib/utils/prowlarr-url';

const logger = RMABLogger.create('DownloadSource');

/** Prowlarr credentials, scoped to the configured Prowlarr origin by the fetcher */
export interface SourceAuth {
  prowlarrBaseUrl: string;
  apiKey: string;
}

export interface FetchSourceOptions {
  /** Prowlarr key + configured URL; the key is only sent to Prowlarr download hops */
  sourceAuth?: SourceAuth;
  /** Torrent clients accept a magnet result; usenet clients do not */
  allowMagnet: boolean;
  /** Hard deadline for the whole fetch, all hops and body included (ms) */
  timeoutMs: number;
  /**
   * Agent for https hops on the starting URL's origin only (a usenet client's
   * "disable SSL verify" setting for e.g. a self-signed Prowlarr). Never used on other hosts.
   */
  httpsAgent?: HttpsAgent;
}

export type FetchedSource =
  | { kind: 'magnet'; magnetUrl: string }
  | { kind: 'file'; data: Buffer; headers: Record<string, unknown> };

function magnetResult(magnetUrl: string, allowMagnet: boolean): FetchedSource {
  if (!allowMagnet) {
    throw new Error('Download source resolved to a magnet link, but this client needs an .nzb file');
  }
  return { kind: 'magnet', magnetUrl };
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function isHttpUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Fetch a .torrent/.nzb source URL, following up to MAX_SOURCE_REDIRECT_HOPS redirects.
 * Throws DownloadSourceError for an HTTP error status from the source.
 */
export async function fetchDownloadSource(url: string, options: FetchSourceOptions): Promise<FetchedSource> {
  const auth = options.sourceAuth?.apiKey ? options.sourceAuth : undefined;
  const prowlarrBase = auth ? parseProwlarrBase(auth.prowlarrBaseUrl) : null;
  const deadline = Date.now() + options.timeoutMs;
  // Hard cap: axios `timeout` is an inactivity timer, so a slow-drip server could outlast it
  const deadlineSignal = AbortSignal.timeout(options.timeoutMs);
  let currentUrl = url.trim();
  const startOrigin = originOf(currentUrl);
  const startIsHttps = currentUrl.startsWith('https:');

  for (let hop = 0; hop <= MAX_SOURCE_REDIRECT_HOPS; hop++) {
    if (isMagnetUri(currentUrl)) {
      return magnetResult(currentUrl, options.allowMagnet);
    }
    if (!isHttpUrl(currentUrl)) {
      throw new Error(`Invalid redirect location: ${urlForLog(currentUrl)}`);
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(`Timed out resolving download source after ${hop} redirect(s)`);
    }

    const sendKey = !!auth && isProwlarrDownloadUrl(currentUrl, prowlarrBase);
    const requestUrl = sendKey ? withApiKeyParam(currentUrl, auth!.apiKey) : currentUrl;
    const headers: Record<string, string> = { 'User-Agent': RMAB_USER_AGENT };
    if (sendKey) headers['X-Api-Key'] = auth!.apiKey;

    let response;
    try {
      response = await axios.get(requestUrl, {
        responseType: 'arraybuffer',
        maxRedirects: 0,
        validateStatus: (status: number) => status >= 200 && status < 300,
        timeout: remaining,
        maxContentLength: MAX_SOURCE_FILE_BYTES,
        maxBodyLength: MAX_SOURCE_FILE_BYTES,
        headers,
        signal: deadlineSignal,
        httpsAgent: startIsHttps && originOf(requestUrl) === startOrigin ? options.httpsAgent : undefined,
      });
    } catch (error) {
      if (deadlineSignal.aborted) {
        throw new Error(`Timed out resolving download source after ${Math.round(options.timeoutMs / 1000)}s`);
      }
      if (!axios.isAxiosError(error) || !error.response) {
        throw error;
      }
      const status = error.response.status;
      if (status >= 300 && status < 400) {
        const location = error.response.headers?.['location'];
        if (typeof location !== 'string' || location.trim() === '') {
          throw new Error(`Invalid redirect location: (missing) from ${urlForLog(currentUrl)}`);
        }
        let nextUrl: string;
        try {
          // Magnets are checked strictly (no whitespace) at the top of the next hop
          const trimmed = location.trim();
          nextUrl = /^magnet:/i.test(trimmed) ? trimmed : new URL(trimmed, currentUrl).toString();
        } catch {
          throw new Error(`Invalid redirect location: ${urlForLog(location)}`);
        }
        logger.info(`Source redirect ${hop + 1} (HTTP ${status}) to ${urlForLog(nextUrl)}`);
        currentUrl = nextUrl;
        continue;
      }
      throw new DownloadSourceError(
        `Grab failed: source returned HTTP ${status}`,
        status,
        urlForLog(currentUrl),
        error
      );
    }

    const data = Buffer.from(response.data);
    if (data.length > 0 && data.length <= MAX_MAGNET_BODY_BYTES) {
      const text = data.toString().trim();
      if (/^magnet:\?[^\s]+$/.test(text)) {
        logger.info('Source response body is a magnet link');
        return magnetResult(text, options.allowMagnet);
      }
    }
    return { kind: 'file', data, headers: (response.headers ?? {}) as Record<string, unknown> };
  }

  throw new Error(`Too many redirects (>${MAX_SOURCE_REDIRECT_HOPS}) while resolving download source`);
}
