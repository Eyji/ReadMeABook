/**
 * Component: Saved Credential Reuse Rules (connection test routes)
 * Documentation: documentation/settings-pages.md
 *
 * Test routes accept a masked secret ("••••") meaning "use the saved one".
 * A saved secret is only reused when the URL being tested is the saved URL;
 * testing a different server requires re-entering the secret.
 */

/** Where to find each credential, shown when it must be re-entered */
export const CREDENTIAL_HELP = {
  audiobookshelf: 'Audiobookshelf API token (in Audiobookshelf: Settings → API Keys, or Settings → Users → your user → API Token on older versions)',
  plex: 'Plex token (X-Plex-Token: in Plex Web, open any item → ⋯ → Get Info → View XML; the token is at the end of the URL)',
  prowlarr: 'Prowlarr API key (in Prowlarr: Settings → General → Security → API Key)',
  downloadClient: 'download client password or API key (SABnzbd: Config → General → API Key; qBittorrent/Transmission/Deluge/NZBGet: the Web UI password)',
} as const;

export type CredentialKind = keyof typeof CREDENTIAL_HELP;

function normalize(url: string | null | undefined): string | null {
  if (!url || typeof url !== 'string') return null;
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

/** True when both URLs are valid http(s) URLs with the same origin and path (trailing slash ignored). */
export function isSameServiceUrl(supplied: string | null | undefined, saved: string | null | undefined): boolean {
  const a = normalize(supplied);
  const b = normalize(saved);
  return a !== null && a === b;
}

/** True for the placeholder ("••••…") the settings UI sends instead of a saved secret. */
export function isMaskedSecret(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith('••••');
}

/** Error text when a saved secret cannot be used for the URL being tested. */
export function savedCredentialUrlMismatch(kind: CredentialKind): string {
  return `The saved credential only works with the saved server URL. To test a different URL, re-enter the ${CREDENTIAL_HELP[kind]}.`;
}
