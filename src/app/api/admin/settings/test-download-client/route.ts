/**
 * Component: Admin Settings Test Download Client API (DEPRECATED)
 * Documentation: documentation/settings-pages.md
 *
 * DEPRECATED: Use /api/admin/settings/download-clients/test instead.
 * Maintained for backward compatibility.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireAdmin, AuthenticatedRequest } from '@/lib/middleware/auth';
import { getConfigService } from '@/lib/services/config.service';
import { getDownloadClientManager, DownloadClientConfig } from '@/lib/services/download-client-manager.service';
import { SUPPORTED_CLIENT_TYPES } from '@/lib/interfaces/download-client.interface';
import { RMABLogger } from '@/lib/utils/logger';
import { isMaskedSecret, isSameServiceUrl, savedCredentialUrlMismatch } from '@/lib/utils/saved-credential';

const logger = RMABLogger.create('API.TestDownloadClient');

export async function POST(request: NextRequest) {
  return requireAuth(request, async (req: AuthenticatedRequest) => {
    return requireAdmin(req, async () => {
      try {
        const {
          type,
          name: clientName,
          url,
          username,
          password,
          disableSSLVerify,
          remotePathMappingEnabled,
          remotePath,
          localPath,
        } = await request.json();

        logger.debug('Received request', { type, url, hasUsername: !!username, hasPassword: !!password });

        if (!type || !url) {
          return NextResponse.json(
            { success: false, error: 'Type and URL are required' },
            { status: 400 }
          );
        }

        if (!SUPPORTED_CLIENT_TYPES.includes(type)) {
          return NextResponse.json(
            { success: false, error: `Invalid client type. Must be one of: ${SUPPORTED_CLIENT_TYPES.join(', ')}` },
            { status: 400 }
          );
        }

        // If password is masked, fetch the actual value from download client manager (decrypted)
        let actualPassword = password;
        if (isMaskedSecret(password) || password === '********') {
          const configService = getConfigService();
          const manager = getDownloadClientManager(configService);
          const clients = await manager.getAllClients();

          // Find the first client of matching type to get its password
          const matchingClient = clients.find(c => c.type === type);

          if (!matchingClient?.password) {
            return NextResponse.json(
              { success: false, error: 'No stored password/API key found. Please re-enter it.' },
              { status: 400 }
            );
          }

          // Saved secret is only reused for that client's saved URL
          if (!isSameServiceUrl(url, matchingClient.url)) {
            return NextResponse.json(
              { success: false, error: savedCredentialUrlMismatch('downloadClient') },
              { status: 400 }
            );
          }

          actualPassword = matchingClient.password;
        }

        // Build a temporary config for testing
        const testConfig: DownloadClientConfig = {
          id: 'legacy-test',
          type,
          name: clientName || type,
          enabled: true,
          url,
          username: username || '',
          password: actualPassword || '',
          disableSSLVerify: disableSSLVerify || false,
          remotePathMappingEnabled: remotePathMappingEnabled || false,
          remotePath: remotePath || undefined,
          localPath: localPath || undefined,
          category: 'readmeabook',
        };

        const configService = getConfigService();
        const manager = getDownloadClientManager(configService);
        const result = await manager.testConnection(testConfig);

        // If path mapping enabled, validate local path exists
        if (result.success && remotePathMappingEnabled) {
          if (!remotePath || !localPath) {
            return NextResponse.json(
              {
                success: false,
                error: 'Remote path and local path are required when path mapping is enabled',
              },
              { status: 400 }
            );
          }

          // Check if local path is accessible
          const fs = await import('fs/promises');
          try {
            await fs.access(localPath, fs.constants.R_OK);
          } catch (accessError) {
            return NextResponse.json(
              {
                success: false,
                error: `Local path "${localPath}" is not accessible. Please verify the path exists and has correct permissions.`,
              },
              { status: 400 }
            );
          }
        }

        if (result.success) {
          return NextResponse.json({ success: true, message: result.message });
        }

        return NextResponse.json(
          { success: false, error: result.message },
          { status: 400 }
        );
      } catch (error) {
        logger.error('Download client test failed', { error: error instanceof Error ? error.message : String(error) });
        return NextResponse.json(
          {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to connect to download client',
          },
          { status: 500 }
        );
      }
    });
  });
}
