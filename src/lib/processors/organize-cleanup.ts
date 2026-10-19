/**
 * Component: Post-Organize Cleanup (download + manual-import source)
 * Documentation: documentation/phase3/file-organization.md
 */

import * as path from 'path';
import { prisma } from '../db';
import { RMABLogger } from '../utils/logger';
import type { ConfigurationService } from '../services/config.service';
import { getDownloadClientManager } from '../services/download-client-manager.service';
import { CLIENT_PROTOCOL_MAP, DownloadClientType } from '../interfaces/download-client.interface';
import { isPathBelowBoundary, normalizePath, removeEmptyParentDirectories } from '../utils/cleanup-helpers';
import { assertSafeToDelete, DeleteGuardContext, UnsafeDeleteError } from '../utils/delete-guard';
import { getMediaDir } from '../utils/media-dir';

const BOOKDROP_PATH = '/bookdrop';

// =========================================================================
// PROTECTED ROOTS
// =========================================================================

/**
 * Collect the roots the delete guard protects: media dir, global download_dir,
 * each client's download_dir/customPath, each client's mapped localPath, and
 * the bookdrop mount.
 */
export async function collectGuardRoots(
  configService: ConfigurationService,
  logger: RMABLogger
): Promise<Omit<DeleteGuardContext, 'targetPath' | 'allowMediaSources'>> {
  const downloadDir = (await configService.get('download_dir')) || '/downloads';
  const mediaDir = await getMediaDir();
  const downloadRoots = new Set<string>([downloadDir]);

  try {
    const clients = await getDownloadClientManager(configService).getAllClients();
    for (const client of clients) {
      if (client.customPath) {
        downloadRoots.add(path.join(downloadDir, client.customPath));
      }
      if (client.remotePathMappingEnabled && client.localPath) {
        downloadRoots.add(client.localPath);
      }
    }
  } catch (error) {
    logger.warn(`Could not read download client paths for the delete guard: ${error instanceof Error ? error.message : String(error)}`);
  }

  return { mediaDir, downloadRoots: [...downloadRoots], otherRoots: [BOOKDROP_PATH] };
}

// =========================================================================
// DOWNLOAD CLEANUP
// =========================================================================

export interface DownloadCleanupParams {
  requestId: string;
  /** Path the organize job read from. */
  downloadPath: string;
  /** DownloadHistory row that produced this job. Absent for manual and bulk imports. */
  downloadHistoryId?: string;
  /** Folder the files were organized into. */
  targetPath: string;
  configService: ConfigurationService;
  jobId: string | undefined;
  logger: RMABLogger;
}

/**
 * Cleanup download files and archive from download client after successful organization.
 * Uses the IDownloadClient.postProcess() method for client-specific cleanup (e.g., SABnzbd archive).
 * Shared between audiobook and ebook organization flows.
 *
 * Runs only for downloads RMAB itself completed: the job must carry the
 * DownloadHistory id, that row must be completed, and its stored (mapped)
 * download path must equal the job's path. Every delete then passes the guard.
 */
export async function cleanupDownloadAfterOrganize(params: DownloadCleanupParams): Promise<void> {
  const { requestId, downloadPath, downloadHistoryId, targetPath, configService, jobId, logger } = params;
  try {
    logger.info('Checking if cleanup is needed for this download');

    if (!downloadHistoryId) {
      logger.info('Not a download RMAB completed (manual or bulk import), skipping download cleanup');
      return;
    }

    const downloadHistory = await prisma.downloadHistory.findUnique({
      where: { id: downloadHistoryId },
    });

    logger.info(`Download history found: ${downloadHistory ? 'yes' : 'no'}`, {
      hasDownloadClientId: !!downloadHistory?.downloadClientId,
      hasIndexerId: !!downloadHistory?.indexerId,
      downloadClient: downloadHistory?.downloadClient || 'none',
    });

    if (!downloadHistory || downloadHistory.requestId !== requestId) {
      return;
    }

    if (
      downloadHistory.downloadStatus !== 'completed' ||
      !downloadHistory.downloadPath ||
      !downloadPath ||
      normalizePath(path.resolve(downloadHistory.downloadPath)) !== normalizePath(path.resolve(downloadPath))
    ) {
      logger.info('Job path does not match the completed download path, skipping download cleanup', {
        status: downloadHistory.downloadStatus || 'none',
        storedPath: downloadHistory.downloadPath || 'none',
        jobPath: downloadPath,
      });
      return;
    }

    if (!downloadHistory.indexerId || !downloadHistory.downloadClientId) {
      return;
    }

    // Get indexer configuration
    const indexersConfig = await configService.get('prowlarr_indexers');
    if (!indexersConfig) {
      return;
    }

    const indexers: Array<{ id: number; protocol?: string; removeAfterProcessing?: boolean }> = JSON.parse(indexersConfig);
    const indexer = indexers.find(idx => idx.id === downloadHistory.indexerId);

    // Indexer protocol, falling back to the protocol of the client that downloaded it
    const protocol = (
      indexer?.protocol ||
      CLIENT_PROTOCOL_MAP[downloadHistory.downloadClient as DownloadClientType] ||
      ''
    ).toLowerCase();

    logger.info(`Indexer found in config: ${indexer ? 'yes' : 'no'}`, {
      indexerId: downloadHistory.indexerId,
      protocol: protocol || 'none',
      removeAfterProcessing: indexer?.removeAfterProcessing ?? 'undefined',
    });

    // Only non-torrent downloads with cleanup enabled (torrents keep seeding)
    if (!indexer || !indexer.removeAfterProcessing || !protocol || protocol === 'torrent') {
      return;
    }

    const roots = await collectGuardRoots(configService, logger);
    try {
      await assertSafeToDelete(downloadPath, { ...roots, targetPath });
    } catch (guardError) {
      if (guardError instanceof UnsafeDeleteError) {
        logger.warn(`Download cleanup skipped: ${guardError.message}`);
        return;
      }
      throw guardError;
    }

    logger.info(`Cleaning up download ${downloadHistory.downloadClientId} (cleanup enabled for indexer ${indexer.id})`);
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

    // Then use the download client interface for client-specific post-processing
    // (e.g., usenet clients archive from history, torrent clients are a no-op)
    const clientType = downloadHistory.downloadClient;
    if (clientType && clientType !== 'direct') {
      const manager = getDownloadClientManager(configService);
      const clientProtocol = CLIENT_PROTOCOL_MAP[clientType as DownloadClientType];
      if (!clientProtocol) {
        logger.warn(`Unknown download client type: ${clientType}, skipping post-processing`);
        return;
      }
      const client = await manager.getClientServiceForProtocol(clientProtocol as 'torrent' | 'usenet');

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
 * Every path passes the delete guard first: sources inside another media
 * folder may be removed, but never the organize target or anything in it.
 */
export async function cleanupSourceAfterOrganize(
  downloadPath: string,
  targetPath: string,
  configService: ConfigurationService,
  jobId: string | undefined,
  logger: RMABLogger,
  selectedFiles?: string[]
): Promise<void> {
  try {
    const fs = await import('fs/promises');

    logger.info(`Cleaning up source files: ${downloadPath}`);

    const roots = await collectGuardRoots(configService, logger);
    const guardContext: DeleteGuardContext = { ...roots, targetPath, allowMediaSources: true };
    let removedAny = false;

    if (selectedFiles && selectedFiles.length > 0) {
      // Only delete the specific files that were imported, not the entire directory
      const kept: string[] = [];
      let removed = 0;
      for (const fileName of selectedFiles) {
        const filePath = path.join(downloadPath, fileName);
        try {
          await assertSafeToDelete(filePath, guardContext);
        } catch (guardError) {
          if (guardError instanceof UnsafeDeleteError) {
            kept.push(fileName);
            continue;
          }
          throw guardError;
        }
        try {
          await fs.unlink(filePath);
          removed++;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            logger.warn(`Failed to delete source file: ${filePath}`);
          }
        }
      }
      if (kept.length > 0) {
        logger.warn(
          `Kept ${kept.length} source file(s) that are part of the import target ${targetPath}: ${kept.join(', ')}`
        );
      }
      removedAny = removed > 0;
      logger.info(`Removed ${removed} selected source files from ${downloadPath}`);
    } else {
      // No file filter — delete entire source path (original behavior)
      try {
        await assertSafeToDelete(downloadPath, guardContext);
      } catch (guardError) {
        if (guardError instanceof UnsafeDeleteError) {
          logger.warn(`Source cleanup skipped: ${guardError.message}`);
          return;
        }
        throw guardError;
      }
      const stats = await fs.stat(downloadPath);
      if (stats.isDirectory()) {
        await fs.rm(downloadPath, { recursive: true, force: true });
        logger.info(`Removed source directory: ${downloadPath}`);
      } else {
        await fs.unlink(downloadPath);
        logger.info(`Removed source file: ${downloadPath}`);
      }
      removedAny = true;
    }

    if (!removedAny) {
      return;
    }

    // Determine boundary path based on which root the source lives under
    const normalizedSource = normalizePath(path.resolve(downloadPath));
    const downloadDir = (await configService.get('download_dir')) || '/downloads';
    let boundaryPath = downloadDir;
    if (isPathBelowBoundary(normalizedSource, normalizePath(path.resolve(BOOKDROP_PATH)))) {
      boundaryPath = BOOKDROP_PATH;
    } else if (isPathBelowBoundary(normalizedSource, normalizePath(path.resolve(roots.mediaDir)))) {
      boundaryPath = roots.mediaDir;
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
