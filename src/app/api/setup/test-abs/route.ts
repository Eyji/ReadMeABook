/**
 * Component: Test Audiobookshelf Connection
 * Documentation: documentation/features/audiobookshelf-integration.md
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireSetupIncompleteOrAdmin } from '@/lib/middleware/auth';
import { isMaskedSecret, isSameServiceUrl, savedCredentialUrlMismatch } from '@/lib/utils/saved-credential';

export async function POST(request: NextRequest) {
  return requireSetupIncompleteOrAdmin(request, async (req) => {
  try {
    const { serverUrl, apiToken } = await req.json();

    if (!serverUrl) {
      return NextResponse.json(
        { error: 'Server URL is required' },
        { status: 400 }
      );
    }

    // If API token is masked, reuse the saved token — but only for the saved server URL
    let effectiveApiToken = apiToken;
    if (!apiToken || isMaskedSecret(apiToken)) {
      const { getConfigService } = await import('@/lib/services/config.service');
      const configService = getConfigService();
      const savedToken = await configService.get('audiobookshelf.api_token');

      if (!savedToken) {
        return NextResponse.json(
          { error: 'API token is required' },
          { status: 400 }
        );
      }

      const savedUrl = await configService.get('audiobookshelf.server_url');
      if (!isSameServiceUrl(serverUrl, savedUrl)) {
        return NextResponse.json(
          { error: savedCredentialUrlMismatch('audiobookshelf') },
          { status: 400 }
        );
      }

      effectiveApiToken = savedToken;
    }

    // Test connection by fetching libraries (which also validates auth)
    const libResponse = await fetch(`${serverUrl.replace(/\/$/, '')}/api/libraries`, {
      headers: {
        'Authorization': `Bearer ${effectiveApiToken}`,
      },
    });

    if (!libResponse.ok) {
      return NextResponse.json(
        { error: `Connection failed: ${libResponse.status} ${libResponse.statusText}` },
        { status: 400 }
      );
    }

    const libData = await libResponse.json();

    // Check if response has libraries array
    if (!libData.libraries || !Array.isArray(libData.libraries)) {
      return NextResponse.json(
        { error: 'Invalid response from Audiobookshelf server' },
        { status: 400 }
      );
    }

    const libraries = libData.libraries
      .filter((lib: any) => lib.mediaType === 'book')
      .map((lib: any) => ({
        id: lib.id,
        name: lib.name,
        itemCount: lib.stats?.totalItems || 0,
      }));

    return NextResponse.json({
      success: true,
      serverInfo: {
        name: 'Audiobookshelf',
        version: 'Connected',
      },
      libraries,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Connection failed' },
      { status: 500 }
    );
  }
  });
}
