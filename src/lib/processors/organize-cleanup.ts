/**
 * Component: Post-Organize Cleanup (download + manual-import source)
 * Documentation: documentation/phase3/file-organization.md
 */

import { prisma } from '../db';
import { RMABLogger } from '../utils/logger';
import { getDownloadClientManager } from '../services/download-client-manager.service';
import { CLIENT_PROTOCOL_MAP, DownloadClientType } from '../interfaces/download-client.interface';
import { removeEmptyParentDirectories } from '../utils/cleanup-helpers';

// =========================================================================
// DOWNLOAD CLEANUP
// =========================================================================

/**
 * Cleanup download files and archive from download client after successful organization.
 * Uses the IDownloadClient.postProcess() method for client-specific cleanup (e.g., SABnzbd archive).
 * Shared between audiobook and ebook organization flows.
 */
export async function cleanupDownloadAfterOrganize(
  requestId: string,
  downloadPath: string,
  configService: any,
  jobId: string | undefined,
  logger: RMABLogger
): Promise<void> {
  try {
    logger.info('Checking if cleanup is needed for this download');

    // Get download history to find client ID and indexer
    const downloadHistory = await prisma.downloadHistory.findFirst({
      where: { requestId },
      orderBy: { createdAt: 'desc' },
    });

    logger.info(`Download history found: ${downloadHistory ? 'yes' : 'no'}`, {
      hasDownloadClientId: !!downloadHistory?.downloadClientId,
      hasIndexerId: !!downloadHistory?.indexerId,
      downloadClient: downloadHistory?.downloadClient || 'none',
    });

    if (!downloadHistory?.indexerId || !downloadHistory?.downloadClientId) {
      return;
    }

    // Get indexer configuration
    const indexersConfig = await configService.get('prowlarr_indexers');
    if (!indexersConfig) {
      return;
    }

    const indexers: Array<{ id: number; protocol: string; removeAfterProcessing?: boolean }> = JSON.parse(indexersConfig);
    const indexer = indexers.find(idx => idx.id === downloadHistory.indexerId);

    logger.info(`Indexer found in config: ${indexer ? 'yes' : 'no'}`, {
      indexerId: downloadHistory.indexerId,
      protocol: indexer?.protocol || 'none',
      removeAfterProcessing: indexer?.removeAfterProcessing ?? 'undefined',
    });

    // Check if this is a non-torrent indexer with cleanup enabled.
    const isTorrentProtocol = indexer?.protocol?.toLowerCase() === 'torrent';

    if (!indexer || isTorrentProtocol || !indexer.removeAfterProcessing) {
      return;
    }

    logger.info(`Cleaning up download ${downloadHistory.downloadClientId} (cleanup enabled for indexer ${indexer.id})`);

    // First, manually delete files from filesystem
    if (downloadPath) {
      logger.info(`Removing download files from filesystem: ${downloadPath}`);

      const fs = await import('fs/promises');

      try {
        const stats = await fs.stat(downloadPath);

        if (stats.isDirectory()) {
          await fs.rm(downloadPath, { recursive: true, force: true });
          logger.info(`Removed directory: ${downloadPath}`);
        } else {
          await fs.unlink(downloadPath);
          logger.info(`Removed file: ${downloadPath}`);
        }

        // Clean up empty parent directories
        const downloadDir = await configService.get('download_dir') || '/downloads';
        const cleanupResult = await removeEmptyParentDirectories(downloadPath, {
          boundaryPath: downloadDir,
          logContext: jobId ? { jobId, context: 'CleanupParents' } : undefined,
        });

        if (cleanupResult.removedDirectories.length > 0) {
          logger.info(`Cleaned up ${cleanupResult.removedDirectories.length} empty parent directories`);
        }
      } catch (fsError) {
        if ((fsError as NodeJS.ErrnoException).code === 'ENOENT') {
          logger.info(`Download path already deleted: ${downloadPath}`);
        } else {
          throw fsError;
        }
      }
    } else {
      logger.warn(`No download path available, skipping filesystem deletion`);
    }

    // Then use the download client interface for client-specific post-processing
    // (e.g., usenet clients archive from history, torrent clients are a no-op)
    const clientType = downloadHistory.downloadClient;
    if (clientType && clientType !== 'direct') {
      const manager = getDownloadClientManager(configService);
      const protocol = CLIENT_PROTOCOL_MAP[clientType as DownloadClientType];
      if (!protocol) {
        logger.warn(`Unknown download client type: ${clientType}, skipping post-processing`);
        return;
      }
      const client = await manager.getClientServiceForProtocol(protocol as 'torrent' | 'usenet');

      if (client) {
        await client.postProcess(downloadHistory.downloadClientId);
        logger.info(`Successfully post-processed download ${downloadHistory.downloadClientId} via ${client.clientType}`);
      }
    }
  } catch (error) {
    // Log error but don't fail the job - cleanup is optional
    logger.warn(
      `Failed to cleanup download: ${error instanceof Error ? error.message : 'Unknown error'}`,
      {
        error: error instanceof Error ? error.stack : undefined,
      }
    );
  }
}

// =========================================================================
// SOURCE FILE CLEANUP (MANUAL IMPORT)
// =========================================================================

/**
 * Delete source files after successful manual import.
 * Non-fatal: logs a warning on failure but does not fail the job.
 * Files are already safely copied to the media library at this point.
 */
export async function cleanupSourceAfterOrganize(
  downloadPath: string,
  configService: any,
  jobId: string | undefined,
  logger: RMABLogger,
  selectedFiles?: string[]
): Promise<void> {
  try {
    const fs = await import('fs/promises');
    const pathModule = await import('path');

    logger.info(`Cleaning up source files: ${downloadPath}`);

    if (selectedFiles && selectedFiles.length > 0) {
      // Only delete the specific files that were imported, not the entire directory
      for (const fileName of selectedFiles) {
        const filePath = pathModule.join(downloadPath, fileName);
        try {
          await fs.unlink(filePath);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            logger.warn(`Failed to delete source file: ${filePath}`);
          }
        }
      }
      logger.info(`Removed ${selectedFiles.length} selected source files from ${downloadPath}`);
    } else {
      // No file filter — delete entire source path (original behavior)
      const stats = await fs.stat(downloadPath);
      if (stats.isDirectory()) {
        await fs.rm(downloadPath, { recursive: true, force: true });
        logger.info(`Removed source directory: ${downloadPath}`);
      } else {
        await fs.unlink(downloadPath);
        logger.info(`Removed source file: ${downloadPath}`);
      }
    }

    // Determine boundary path based on download path prefix
    const BOOKDROP_PATH = '/bookdrop';
    const downloadDir = await configService.get('download_dir') || '/downloads';
    const mediaDir = await configService.get('media_dir') || '/media';

    let boundaryPath = downloadDir;
    if (downloadPath.startsWith(BOOKDROP_PATH)) {
      boundaryPath = BOOKDROP_PATH;
    } else if (downloadPath.startsWith(mediaDir)) {
      boundaryPath = mediaDir;
    }

    const cleanupResult = await removeEmptyParentDirectories(downloadPath, {
      boundaryPath,
      logContext: jobId ? { jobId, context: 'CleanupSourceParents' } : undefined,
    });

    if (cleanupResult.removedDirectories.length > 0) {
      logger.info(`Cleaned up ${cleanupResult.removedDirectories.length} empty parent directories`);
    }
  } catch (error) {
    // Non-fatal - files are already safely in the media library
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      logger.info(`Source path already deleted: ${downloadPath}`);
    } else {
      logger.warn(
        `Failed to cleanup source files: ${error instanceof Error ? error.message : 'Unknown error'}`,
        { error: error instanceof Error ? error.stack : undefined }
      );
    }
  }
}

