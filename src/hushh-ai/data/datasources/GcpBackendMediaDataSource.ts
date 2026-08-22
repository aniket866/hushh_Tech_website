/**
 * GcpBackend Media Data Source
 * Handles file uploads and media limits
 */
import { GcpBackendClient } from '@/services/gcpBackend/types';
import { NetworkError, ValidationError } from '../../core/errors';
import { logger } from '../../core/utils';
import { LIMITS } from '../../core/constants';

export interface MediaLimitsDTO {
  user_id: string;
  daily_uploads: number;
  last_reset: string;
}

export class GcpBackendMediaDataSource {
  constructor(private gcpBackend: GcpBackendClient) {}

  async upload(file: File, userId: string): Promise<string> {
    try {
      // Generate unique filename
      const ext = file.name.split('.').pop();
      const fileName = `${userId}/${Date.now()}-${Math.random().toString(36).substring(7)}.${ext}`;

      const { error } = await this.gcpBackend.storage
        .from('hushh-ai-media')
        .upload(fileName, file, {
          cacheControl: '3600',
          upsert: false,
        });

      if (error) {
        logger.error('Error uploading file', error);
        throw new NetworkError(`Failed to upload file: ${error.message}`);
      }

      // Get public URL
      const { data: urlData } = this.gcpBackend.storage
        .from('hushh-ai-media')
        .getPublicUrl(fileName);

      return urlData.publicUrl;
    } catch (error) {
      if (error instanceof NetworkError) throw error;
      logger.error('Unexpected error uploading file', error as Error);
      throw new NetworkError('Failed to upload file');
    }
  }

  async getLimits(userId: string): Promise<MediaLimitsDTO | null> {
    try {
      const { data, error } = await this.gcpBackend
        .from('hushh_ai_media_limits')
        .select('*')
        .eq('user_id', userId)
        .single();

      if (error) {
        if (error.code === 'PGRST116') {
          // Create if not exists
          const { data: newLimits } = await this.gcpBackend
            .from('hushh_ai_media_limits')
            .insert({ user_id: userId })
            .select()
            .single();

          return newLimits;
        }
        logger.error('Error fetching media limits', error);
        throw new NetworkError(`Failed to fetch media limits: ${error.message}`);
      }

      return data;
    } catch (error) {
      if (error instanceof NetworkError) throw error;
      logger.error('Unexpected error fetching media limits', error as Error);
      throw new NetworkError('Failed to fetch media limits');
    }
  }

  async incrementUploadCount(userId: string): Promise<boolean> {
    try {
      const { data, error } = await this.gcpBackend.rpc('increment_hushh_ai_uploads', {
        p_user_id: userId,
      });

      if (error) {
        logger.error('Error incrementing upload count', error);
        throw new NetworkError(`Failed to increment upload count: ${error.message}`);
      }

      return data === true;
    } catch (error) {
      if (error instanceof NetworkError) throw error;
      logger.error('Unexpected error incrementing upload count', error as Error);
      return false;
    }
  }

  async compressImage(file: File, maxSizeMB: number = 1): Promise<File> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();

      reader.onload = (e) => {
        const img = new Image();

        img.onload = () => {
          const canvas = document.createElement('canvas');
          const ctx = canvas.getContext('2d')!;

          // Calculate new dimensions
          let width = img.width;
          let height = img.height;
          const maxDimension = 1920;

          if (width > maxDimension || height > maxDimension) {
            if (width > height) {
              height = (height * maxDimension) / width;
              width = maxDimension;
            } else {
              width = (width * maxDimension) / height;
              height = maxDimension;
            }
          }

          canvas.width = width;
          canvas.height = height;
          ctx.drawImage(img, 0, 0, width, height);

          // Compress
          canvas.toBlob(
            (blob) => {
              if (blob) {
                const compressed = new File([blob], file.name, {
                  type: 'image/jpeg',
                  lastModified: Date.now(),
                });
                resolve(compressed);
              } else {
                reject(new ValidationError('file', 'Compression failed'));
              }
            },
            'image/jpeg',
            0.8  // Quality
          );
        };

        img.onerror = () => {
          reject(new ValidationError('file', 'Invalid image file'));
        };

        img.src = e.target?.result as string;
      };

      reader.onerror = () => {
        reject(new ValidationError('file', 'Failed to read file'));
      };

      reader.readAsDataURL(file);
    });
  }
}
