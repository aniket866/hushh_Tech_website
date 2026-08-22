/**
 * Media Repository Implementation
 * Implements IMediaRepository using GcpBackend data source
 */
import { IMediaRepository, MediaLimits } from '../../domain/repositories';
import { GcpBackendMediaDataSource } from '../datasources';
import { retryWithBackoff } from '../../core/utils';
import { LIMITS } from '../../core/constants';

export class MediaRepositoryImpl implements IMediaRepository {
  constructor(private dataSource: GcpBackendMediaDataSource) {}

  async upload(file: File, userId: string): Promise<string> {
    // Check if user can upload
    const canUpload = await this.canUpload(userId);
    if (!canUpload) {
      throw new Error('Daily upload limit reached');
    }

    // Upload file
    const url = await retryWithBackoff(() =>
      this.dataSource.upload(file, userId)
    );

    // Increment counter
    await this.incrementUploadCount(userId);

    return url;
  }

  async getLimits(userId: string): Promise<MediaLimits | null> {
    const dto = await retryWithBackoff(() =>
      this.dataSource.getLimits(userId)
    );

    if (!dto) return null;

    const max = LIMITS.media.maxDailyUploads;
    return {
      dailyUploads: dto.daily_uploads,
      maxDailyUploads: max,
      remainingUploads: Math.max(0, max - dto.daily_uploads),
      lastReset: new Date(dto.last_reset),
    };
  }

  async canUpload(userId: string): Promise<boolean> {
    const limits = await this.getLimits(userId);
    if (!limits) return false;
    return limits.remainingUploads > 0;
  }

  async incrementUploadCount(userId: string): Promise<boolean> {
    return this.dataSource.incrementUploadCount(userId);
  }

  async compressImage(file: File, maxSizeMB: number = 1): Promise<File> {
    return this.dataSource.compressImage(file, maxSizeMB);
  }
}
