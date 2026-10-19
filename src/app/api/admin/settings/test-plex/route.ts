/**
 * Component: Admin Settings Test Plex API
 * Documentation: documentation/settings-pages.md
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireAdmin, AuthenticatedRequest } from '@/lib/middleware/auth';
import { getConfigService } from '@/lib/services/config.service';
import { getPlexService } from '@/lib/integrations/plex.service';
import { RMABLogger } from '@/lib/utils/logger';
import { isMaskedSecret, isSameServiceUrl, savedCredentialUrlMismatch } from '@/lib/utils/saved-credential';

const logger = RMABLogger.create('API.Admin.Settings.TestPlex');

export async function POST(request: NextRequest) {
  return requireAuth(request, async (req: AuthenticatedRequest) => {
    return requireAdmin(req, async () => {
      try {
        const { url, token } = await request.json();

        if (!url || !token) {
          return NextResponse.json(
            { success: false, error: 'URL and token are required' },
            { status: 400 }
          );
        }

        // If token is masked, fetch the actual value from database (decrypted)
        let actualToken = token;
        if (isMaskedSecret(token)) {
          const configService = getConfigService();
          const storedToken = await configService.get('plex_token');

          if (!storedToken) {
            return NextResponse.json(
              { success: false, error: 'No stored token found. Please re-enter your Plex token.' },
              { status: 400 }
            );
          }

          // Saved token is only reused for the saved server URL
          if (!isSameServiceUrl(url, await configService.get('plex_url'))) {
            return NextResponse.json(
              { success: false, error: savedCredentialUrlMismatch('plex') },
              { status: 400 }
            );
          }

          actualToken = storedToken;
        }

        const plexService = getPlexService();

        // Test connection and get server info
        const connectionResult = await plexService.testConnection(url, actualToken);

        if (!connectionResult.success || !connectionResult.info) {
          return NextResponse.json(
            { success: false, error: connectionResult.message },
            { status: 400 }
          );
        }

        // Get libraries
        const libraries = await plexService.getLibraries(url, actualToken);

        // Format server name safely
        const serverName = connectionResult.info
          ? `${connectionResult.info.platform || 'Plex Server'} v${connectionResult.info.version || 'Unknown'}`
          : 'Plex Server';

        return NextResponse.json({
          success: true,
          serverName,
          version: connectionResult.info?.version || 'Unknown',
          machineIdentifier: connectionResult.info?.machineIdentifier || 'unknown',
          libraries: libraries.map((lib) => ({
            id: lib.id,
            title: lib.title,
            type: lib.type,
          })),
        });
      } catch (error) {
        logger.error('Plex test failed', { error: error instanceof Error ? error.message : String(error) });
        return NextResponse.json(
          {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to connect to Plex',
          },
          { status: 500 }
        );
      }
    });
  });
}
