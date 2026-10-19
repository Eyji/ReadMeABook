/**
 * Component: Select Ebook by ASIN API
 * Documentation: documentation/integrations/ebook-sidecar.md
 *
 * Creates an ebook request with a user-selected source (Anna's Archive or indexer)
 * Routes to appropriate download processor based on source type
 * Includes approval logic for non-admin users
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, AuthenticatedRequest } from '@/lib/middleware/auth';
import { prisma } from '@/lib/db';
import { getJobQueueService } from '@/lib/services/job-queue.service';
import { getConfigService } from '@/lib/services/config.service';
import { findPlexMatch } from '@/lib/utils/audiobook-matcher';
import { getAudibleService } from '@/lib/integrations/audible.service';
import { RMABLogger } from '@/lib/utils/logger';
import { denyWithoutInteractiveSearchAccess } from '@/lib/middleware/interactive-search-access';
import { guardEbookSelection, rejectedSelectionResponse } from '@/lib/services/download-selection-guard';

const logger = RMABLogger.create('API.Audiobooks.SelectEbook');

// Statuses that indicate an active/in-progress ebook request
const ACTIVE_EBOOK_STATUSES = [
  'pending',
  'awaiting_approval',
  'searching',
  'downloading',
  'processing',
  'downloaded',
  'available',
];

// Statuses that allow reuse
const REUSABLE_STATUSES = ['failed', 'awaiting_search', 'pending'];

interface SelectedEbook {
  guid: string;
  title: string;
  size: number;
  seeders: number;
  indexer: string;
  indexerId?: number;
  downloadUrl: string;
  infoUrl?: string;
  score: number;
  finalScore: number;
  source: 'annas_archive' | 'prowlarr';
  format?: string;
  md5?: string;
  downloadUrls?: string[];
  protocol?: string;
}

/**
 * POST /api/audiobooks/[asin]/select-ebook
 * Select and download an ebook from interactive search results
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ asin: string }> }
) {
  return requireAuth(request, async (req: AuthenticatedRequest) => {
    try {
      const { asin } = await params;
      const body = await request.json();
      let selectedEbook = body.ebook as SelectedEbook;

      if (!asin || asin.length !== 10) {
        return NextResponse.json(
          { error: 'Valid ASIN is required' },
          { status: 400 }
        );
      }

      if (!req.user) {
        return NextResponse.json(
          { error: 'Unauthorized' },
          { status: 401 }
        );
      }

      if (!selectedEbook) {
        return NextResponse.json({ error: 'No ebook selected' }, { status: 400 });
      }

      if (!selectedEbook.source) {
        return NextResponse.json({ error: 'Ebook source not specified' }, { status: 400 });
      }

      const accessDenied = await denyWithoutInteractiveSearchAccess(req.user.id);
      if (accessDenied) return accessDenied;

      // Indexer picks must be Prowlarr/magnet links; Anna's Archive links are rebuilt from the md5
      const ebookCheck = await guardEbookSelection(selectedEbook);
      if (!ebookCheck.ok) return rejectedSelectionResponse(ebookCheck.error);
      selectedEbook = ebookCheck.value;

      // First, fetch audiobook data from Audible (works for books imported outside RMAB)
      const audibleService = getAudibleService();
      let audibleData = null;
      try {
        audibleData = await audibleService.getAudiobookDetails(asin);
      } catch (error) {
        logger.warn(`Failed to fetch Audible data for ASIN ${asin}: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }

      if (!audibleData) {
        return NextResponse.json(
          { error: 'Audiobook not found on Audible' },
          { status: 404 }
        );
      }

      // Check Plex availability using Audible metadata
      const plexMatch = await findPlexMatch({
        asin,
        title: audibleData.title,
        author: audibleData.author,
      });

      // Find or create audiobook record
      let audiobook = await prisma.audiobook.findFirst({
        where: { audibleAsin: asin },
      });

      // Check for available request if audiobook exists in database
      let availableRequest = null;
      if (audiobook) {
        availableRequest = await prisma.request.findFirst({
          where: {
            audiobookId: audiobook.id,
            type: 'audiobook',
            status: { in: ['downloaded', 'available'] },
            deletedAt: null,
          },
        });
      }

      const isAvailable = !!availableRequest || !!plexMatch;

      if (!isAvailable) {
        return NextResponse.json(
          { error: 'Audiobook must be available in your library before requesting an ebook' },
          { status: 400 }
        );
      }

      // If audiobook doesn't exist in database but is in Plex, create it
      if (!audiobook) {
        logger.info(`Creating audiobook record for "${audibleData.title}" (imported outside RMAB)`);

        // Extract year from release date
        let year: number | undefined;
        if (audibleData.releaseDate) {
          try {
            const releaseYear = new Date(audibleData.releaseDate).getFullYear();
            if (!isNaN(releaseYear)) {
              year = releaseYear;
            }
          } catch {
            // Ignore parsing errors
          }
        }

        audiobook = await prisma.audiobook.create({
          data: {
            audibleAsin: asin,
            title: audibleData.title,
            author: audibleData.author,
            narrator: audibleData.narrator,
            description: audibleData.description,
            coverArtUrl: audibleData.coverArtUrl,
            year,
            series: audibleData.series,
            seriesPart: audibleData.seriesPart,
            status: 'available',
          },
        });
        logger.info(`Created audiobook ${audiobook.id} for "${audibleData.title}"`);
      }

      // Check for existing ebook request
      let ebookRequest = await prisma.request.findFirst({
        where: {
          audiobookId: audiobook.id,
          type: 'ebook',
          deletedAt: null,
        },
        orderBy: { createdAt: 'desc' },
      });

      // Handle existing ebook request
      if (ebookRequest) {
        if (ACTIVE_EBOOK_STATUSES.includes(ebookRequest.status) &&
            !REUSABLE_STATUSES.includes(ebookRequest.status)) {
          return NextResponse.json({
            error: `E-book request already exists (status: ${ebookRequest.status})`,
            existingRequestId: ebookRequest.id,
          }, { status: 400 });
        }
      }

      // Check if approval is needed for non-admin users
      const user = await prisma.user.findUnique({
        where: { id: req.user.id },
        select: {
          role: true,
          autoApproveRequests: true,
          plexUsername: true,
        },
      });

      if (!user) {
        return NextResponse.json(
          { error: 'User not found' },
          { status: 404 }
        );
      }

      let needsApproval = false;

      if (user.role === 'admin') {
        needsApproval = false;
      } else {
        if (user.autoApproveRequests === true) {
          needsApproval = false;
        } else if (user.autoApproveRequests === false) {
          needsApproval = true;
        } else {
          const globalConfig = await prisma.configuration.findUnique({
            where: { key: 'auto_approve_requests' },
          });
          const globalAutoApprove = globalConfig === null ? true : globalConfig.value === 'true';
          needsApproval = !globalAutoApprove;
        }
      }

      const jobQueue = getJobQueueService();

      if (needsApproval) {
        // Create or update ebook request with awaiting_approval status
        if (ebookRequest && REUSABLE_STATUSES.includes(ebookRequest.status)) {
          ebookRequest = await prisma.request.update({
            where: { id: ebookRequest.id },
            data: {
              status: 'awaiting_approval',
              progress: 0,
              errorMessage: null,
              selectedTorrent: selectedEbook as any, // Store selected ebook for later
              updatedAt: new Date(),
            },
          });
          logger.info(`Reusing ebook request ${ebookRequest.id}, awaiting approval`);
        } else {
          ebookRequest = await prisma.request.create({
            data: {
              userId: req.user.id,
              audiobookId: audiobook.id,
              type: 'ebook',
              parentRequestId: availableRequest?.id || null,
              status: 'awaiting_approval',
              progress: 0,
              selectedTorrent: selectedEbook as any,
              customSearchTerms: availableRequest?.customSearchTerms || null,
            },
          });
          logger.info(`Created ebook request ${ebookRequest.id}, awaiting approval`);
        }

        // Send pending approval notification
        await jobQueue.addNotificationJob(
          'request_pending_approval',
          ebookRequest.id,
          `${audiobook.title} (Ebook)`,
          audiobook.author,
          user.plexUsername || 'Unknown User'
        ).catch((error) => {
          logger.error('Failed to queue notification', { error: error instanceof Error ? error.message : String(error) });
        });

        return NextResponse.json({
          success: true,
          message: 'Ebook request submitted for admin approval',
          requestId: ebookRequest.id,
          needsApproval: true,
        }, { status: 201 });
      } else {
        // Auto-approved - create or update request and start download
        if (ebookRequest && REUSABLE_STATUSES.includes(ebookRequest.status)) {
          ebookRequest = await prisma.request.update({
            where: { id: ebookRequest.id },
            data: {
              status: 'searching',
              progress: 0,
              errorMessage: null,
              updatedAt: new Date(),
            },
          });
          logger.info(`Reusing existing ebook request ${ebookRequest.id}`);
        } else {
          ebookRequest = await prisma.request.create({
            data: {
              userId: req.user.id,
              audiobookId: audiobook.id,
              type: 'ebook',
              parentRequestId: availableRequest?.id || null,
              status: 'searching',
              progress: 0,
              customSearchTerms: availableRequest?.customSearchTerms || null,
            },
          });
          logger.info(`Created new ebook request ${ebookRequest.id}`);
        }

        // Route to appropriate download based on source
        if (selectedEbook.source === 'annas_archive') {
          await handleAnnasArchiveDownload(
            ebookRequest.id,
            audiobook,
            selectedEbook,
            jobQueue
          );
        } else {
          await handleIndexerDownload(
            ebookRequest.id,
            audiobook,
            selectedEbook,
            jobQueue
          );
        }

        // Send approved notification
        await jobQueue.addNotificationJob(
          'request_approved',
          ebookRequest.id,
          `${audiobook.title} (Ebook)`,
          audiobook.author,
          user.plexUsername || 'Unknown User'
        ).catch((error) => {
          logger.error('Failed to queue notification', { error: error instanceof Error ? error.message : String(error) });
        });

        return NextResponse.json({
          success: true,
          message: `E-book download started from ${selectedEbook.source === 'annas_archive' ? "Anna's Archive" : selectedEbook.indexer}`,
          requestId: ebookRequest.id,
          needsApproval: false,
        });
      }
    } catch (error) {
      logger.error('Unexpected error', { error: error instanceof Error ? error.message : String(error) });
      return NextResponse.json(
        { error: error instanceof Error ? error.message : 'Internal server error' },
        { status: 500 }
      );
    }
  });
}

/**
 * Handle Anna's Archive download (direct HTTP)
 */
async function handleAnnasArchiveDownload(
  requestId: string,
  audiobook: { id: string; title: string; author: string },
  selectedEbook: SelectedEbook,
  jobQueue: ReturnType<typeof getJobQueueService>
) {
  const configService = getConfigService();
  const preferredFormat = await configService.get('ebook_sidecar_preferred_format') || 'epub';

  logger.info(`Starting Anna's Archive download for "${audiobook.title}"`);
  logger.info(`MD5: ${selectedEbook.md5}, Format: ${selectedEbook.format || preferredFormat}`);

  // Create download history record
  const downloadHistory = await prisma.downloadHistory.create({
    data: {
      requestId,
      indexerName: "Anna's Archive",
      torrentName: `${audiobook.title} - ${audiobook.author}.${selectedEbook.format || preferredFormat}`,
      torrentSizeBytes: null,
      qualityScore: selectedEbook.score,
      selected: true,
      downloadClient: 'direct',
      downloadStatus: 'queued',
    },
  });

  // Store all download URLs for retry purposes
  if (selectedEbook.downloadUrls && selectedEbook.downloadUrls.length > 0) {
    await prisma.downloadHistory.update({
      where: { id: downloadHistory.id },
      data: {
        torrentUrl: JSON.stringify(selectedEbook.downloadUrls),
      },
    });
  }

  // Trigger direct download job
  await jobQueue.addStartDirectDownloadJob(
    requestId,
    downloadHistory.id,
    selectedEbook.downloadUrl,
    `${audiobook.title} - ${audiobook.author}.${selectedEbook.format || preferredFormat}`,
    undefined
  );

  logger.info(`Queued direct download job for request ${requestId}`);
}

/**
 * Handle indexer download (torrent/NZB)
 */
async function handleIndexerDownload(
  requestId: string,
  audiobook: { id: string; title: string; author: string },
  selectedEbook: SelectedEbook,
  jobQueue: ReturnType<typeof getJobQueueService>
) {
  logger.info(`Starting indexer download for "${audiobook.title}"`);
  logger.info(`Torrent: "${selectedEbook.title}", Indexer: ${selectedEbook.indexer}`);

  const torrentForJob = {
    guid: selectedEbook.guid,
    title: selectedEbook.title,
    size: selectedEbook.size,
    seeders: selectedEbook.seeders || 0,
    indexer: selectedEbook.indexer,
    indexerId: selectedEbook.indexerId,
    downloadUrl: selectedEbook.downloadUrl,
    infoUrl: selectedEbook.infoUrl,
    publishDate: new Date(),
    score: selectedEbook.score,
    finalScore: selectedEbook.finalScore,
    bonusPoints: 0,
    bonusModifiers: [],
    rank: 1,
    breakdown: {
      formatScore: 0,
      sizeScore: 0,
      seederScore: 0,
      matchScore: 0,
      totalScore: selectedEbook.score,
      notes: [],
    },
    protocol: selectedEbook.protocol,
  };

  await jobQueue.addDownloadJob(requestId, {
    id: audiobook.id,
    title: audiobook.title,
    author: audiobook.author,
  }, torrentForJob as any);

  logger.info(`Queued download job for request ${requestId}`);
}
