/**
 * Component: Admin Settings Test Prowlarr API
 * Documentation: documentation/settings-pages.md
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireAdmin, AuthenticatedRequest } from '@/lib/middleware/auth';
import { getConfigService } from '@/lib/services/config.service';
import { ProwlarrService } from '@/lib/integrations/prowlarr.service';
import { RMABLogger } from '@/lib/utils/logger';
import { isMaskedSecret, isSameServiceUrl, savedCredentialUrlMismatch } from '@/lib/utils/saved-credential';

const logger = RMABLogger.create('API.Admin.Settings.TestProwlarr');

export async function POST(request: NextRequest) {
  return requireAuth(request, async (req: AuthenticatedRequest) => {
    return requireAdmin(req, async () => {
      try {
        const { url, apiKey } = await request.json();

        if (!url || !apiKey) {
          return NextResponse.json(
            { success: false, error: 'URL and API key are required' },
            { status: 400 }
          );
        }

        // If API key is masked, fetch the actual value from database (decrypted)
        let actualApiKey = apiKey;
        if (isMaskedSecret(apiKey)) {
          const configService = getConfigService();
          const storedApiKey = await configService.get('prowlarr_api_key');

          if (!storedApiKey) {
            return NextResponse.json(
              { success: false, error: 'No stored API key found. Please re-enter your Prowlarr API key.' },
              { status: 400 }
            );
          }

          // Saved key is only reused for the saved Prowlarr URL
          const savedUrl = (await configService.get('prowlarr_url')) || process.env.PROWLARR_URL;
          if (!isSameServiceUrl(url, savedUrl)) {
            return NextResponse.json(
              { success: false, error: savedCredentialUrlMismatch('prowlarr') },
              { status: 400 }
            );
          }

          actualApiKey = storedApiKey;
        }

        // Create a new ProwlarrService instance with test credentials
        const prowlarrService = new ProwlarrService(url, actualApiKey);

        // Test connection and get indexers
        const indexers = await prowlarrService.getIndexers();

        // Only return enabled indexers
        const enabledIndexers = indexers.filter((indexer) => indexer.enable);

        return NextResponse.json({
          success: true,
          indexerCount: enabledIndexers.length,
          totalIndexers: indexers.length,
          indexers: enabledIndexers.map((indexer) => ({
            id: indexer.id,
            name: indexer.name,
            protocol: indexer.protocol,
            supportsRss: indexer.capabilities?.supportsRss !== false,
          })),
        });
      } catch (error) {
        logger.error('Prowlarr test failed', { error: error instanceof Error ? error.message : String(error) });
        return NextResponse.json(
          {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to connect to Prowlarr',
          },
          { status: 500 }
        );
      }
    });
  });
}
