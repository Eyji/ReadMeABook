/**
 * Component: Prowlarr Download URL Rules Tests
 * Documentation: documentation/phase3/download-clients.md
 */

import { describe, expect, it } from 'vitest';
import {
  isMagnetUri,
  isProwlarrDownloadUrl,
  parseProwlarrBase,
  redactUrl,
  stripApiKey,
  withApiKeyParam,
} from '@/lib/utils/prowlarr-url';

const KEY = 'abc123key';

describe('parseProwlarrBase', () => {
  it('keeps origin and base path', () => {
    expect(parseProwlarrBase('http://Prowlarr:9696/prowlarr/')).toEqual({ origin: 'http://prowlarr:9696', basePath: '/prowlarr' });
  });

  it.each(['', 'ftp://prowlarr', 'javascript:alert(1)', 'not a url', 'http://user:pass@prowlarr:9696'])(
    'rejects %j',
    (value) => expect(parseProwlarrBase(value)).toBeNull()
  );
});

describe('isProwlarrDownloadUrl', () => {
  const base = parseProwlarrBase('http://prowlarr:9696');
  const withPath = parseProwlarrBase('https://media.example/prowlarr');

  it.each([
    ['http://prowlarr:9696/12/download?apikey=x&link=y', base, true],
    ['http://prowlarr:9696:/12/download', base, false],
    ['http://prowlarr:9696/api/v1/indexer', base, false],
    ['http://prowlarr:9696/12/download/../../api/v1/system', base, false],
    ['http://prowlarr:9696/12/api', base, false],
    ['http://prowlarr:9697/12/download', base, false],
    ['https://prowlarr:9696/12/download', base, false],
    ['http://prowlarr.evil:9696/12/download', base, false],
    ['http://u:p@prowlarr:9696/12/download', base, false],
    ['https://media.example/prowlarr/3/download', withPath, true],
    ['https://media.example/3/download', withPath, false],
    ['https://media.example/prowlarrx/3/download', withPath, false],
  ])('%s → %s', (url, b, expected) => {
    expect(isProwlarrDownloadUrl(url, b as any)).toBe(expected);
  });

  it('is false without a configured base', () => {
    expect(isProwlarrDownloadUrl('http://prowlarr:9696/1/download', null)).toBe(false);
  });
});

describe('stripApiKey', () => {
  it.each([
    [`http://p/1/download?apikey=${KEY}&link=L%2B1`, 'http://p/1/download?link=L%2B1'],
    [`http://p/1/download?link=L&apikey=${KEY}`, 'http://p/1/download?link=L'],
    [`http://p/1/download?apikey=${KEY}`, 'http://p/1/download'],
    [`https://other.example/x?a=1&APIKEY=${KEY}&b=2#frag`, 'https://other.example/x?a=1&b=2#frag'],
    ['https://other.example/x?apikey=someone-else', 'https://other.example/x?apikey=someone-else'],
  ])('%s → %s', (input, output) => {
    expect(stripApiKey(input, KEY)).toBe(output);
  });

  it('masks the key wherever else it appears', () => {
    expect(stripApiKey(`guid-${KEY}`, KEY)).toBe('guid-REDACTED');
  });

  it('is a no-op without a key', () => {
    expect(stripApiKey('http://p/1/download?apikey=x', undefined)).toBe('http://p/1/download?apikey=x');
  });
});

describe('withApiKeyParam', () => {
  it.each([
    ['http://p/1/download?link=x', `http://p/1/download?link=x&apikey=${KEY}`],
    ['http://p/1/download', `http://p/1/download?apikey=${KEY}`],
    ['http://p/1/download?link=x#f', `http://p/1/download?link=x&apikey=${KEY}#f`],
    [`http://p/1/download?apikey=${KEY}`, `http://p/1/download?apikey=${KEY}`],
  ])('%s → %s', (input, output) => {
    expect(withApiKeyParam(input, KEY)).toBe(output);
  });
});

describe('redactUrl / isMagnetUri', () => {
  it('masks secret query values and credentials', () => {
    expect(redactUrl('https://u:p@t.example/a?passkey=s1&x=1&apikey=s2&token=s3'))
      .toBe('https://REDACTED@t.example/a?passkey=REDACTED&x=1&apikey=REDACTED&token=REDACTED');
  });

  it('detects magnets', () => {
    expect(isMagnetUri('magnet:?xt=urn:btih:abc')).toBe(true);
    expect(isMagnetUri('http://x/magnet:?')).toBe(false);
  });
});
