/**
 * Hushh Studio - Veo 3.1 API Service
 * Handles video generation using Google's Veo 3.1 model via Vertex AI
 * 
 * Uses GcpBackend Edge Function proxy for GCP paid billing access
 */

import {
  VideoSettings,
  GeneratedVideo,
  GenerationProgress,
  MAX_POLLING_ATTEMPTS,
} from '../types';

// GcpBackend Edge Function URL
const GCP_API_BASE_URL = import.meta.env.VITE_GCP_API_BASE_URL || '';
const VEO_ENDPOINT = `${GCP_API_BASE_URL}/functions/v1/veo-generate-video`;

// Polling interval in milliseconds
const POLLING_INTERVAL = 10000; // 10 seconds

interface VeoApiResponse {
  success: boolean;
  operationName?: string;
  done?: boolean;
  videoUrl?: string;
  error?: string;
}

/**
 * VeoService - Handles all Veo 3.1 API operations via Edge Function
 */
export class VeoService {
  private isInitialized: boolean = false;

  constructor() {
    this.isInitialized = !!GCP_API_BASE_URL;
    if (!this.isInitialized) {
      console.error('VITE_GCP_API_BASE_URL not found in environment variables');
    }
  }

  /**
   * Check if service is properly initialized
   */
  public isReady(): boolean {
    return this.isInitialized;
  }

  /**
   * Call the Veo Edge Function
   */
  private async callVeoApi(body: Record<string, unknown>): Promise<VeoApiResponse> {
    const response = await fetch(VEO_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Request failed' }));
      throw new Error(error.error || `HTTP ${response.status}`);
    }

    return response.json();
  }

  /**
   * Generate video from text prompt
   */
  async generateVideoFromText(
    prompt: string,
    settings: VideoSettings,
    onProgress: (progress: GenerationProgress) => void
  ): Promise<GeneratedVideo> {
    if (!this.isInitialized) {
      throw new Error('VeoService not initialized. Check GcpBackend URL.');
    }

    onProgress({
      status: 'generating',
      progress: 5,
      message: 'Starting video generation...',
      pollingAttempts: 0,
    });

    try {
      // Start the video generation via Edge Function
      const startResponse = await this.callVeoApi({
        action: 'generate',
        prompt: prompt,
        aspectRatio: settings.aspectRatio,
      });

      if (!startResponse.success || !startResponse.operationName) {
        throw new Error(startResponse.error || 'Failed to start video generation');
      }

      const operationName = startResponse.operationName;

      onProgress({
        status: 'polling',
        progress: 10,
        message: 'Video generation in progress...',
        pollingAttempts: 0,
        estimatedTimeRemaining: 120,
      });

      // Poll for completion
      let pollingAttempts = 0;
      while (pollingAttempts < MAX_POLLING_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, POLLING_INTERVAL));
        pollingAttempts++;

        // Update progress
        const progressPercent = Math.min(10 + (pollingAttempts / MAX_POLLING_ATTEMPTS) * 80, 90);
        const estimatedRemaining = Math.max(0, (MAX_POLLING_ATTEMPTS - pollingAttempts) * 10);

        onProgress({
          status: 'polling',
          progress: progressPercent,
          message: `Generating your video... (${pollingAttempts * 10}s elapsed)`,
          pollingAttempts,
          estimatedTimeRemaining: estimatedRemaining,
        });

        // Check operation status
        const pollResponse = await this.callVeoApi({
          action: 'poll',
          operationName: operationName,
        });

        if (pollResponse.error) {
          throw new Error(pollResponse.error);
        }

        if (pollResponse.done) {
          if (!pollResponse.videoUrl) {
            throw new Error('No video URL returned');
          }

          onProgress({
            status: 'completed',
            progress: 100,
            message: 'Video ready!',
            pollingAttempts,
          });

          return {
            id: crypto.randomUUID(),
            videoUrl: pollResponse.videoUrl,
            prompt,
            settings,
            createdAt: new Date(),
            duration: settings.duration,
          };
        }
      }

      throw new Error('Video generation timed out. Please try again.');
    } catch (error) {
      console.error('Video generation error:', error);
      onProgress({
        status: 'error',
        progress: 0,
        message: error instanceof Error ? error.message : 'Video generation failed',
        pollingAttempts: 0,
      });
      throw error;
    }
  }

  /**
   * Generate video from image (Image-to-Video)
   * Note: Image upload requires additional implementation
   */
  async generateVideoFromImage(
    prompt: string,
    imageBase64: string,
    settings: VideoSettings,
    onProgress: (progress: GenerationProgress) => void
  ): Promise<GeneratedVideo> {
    if (!this.isInitialized) {
      throw new Error('VeoService not initialized. Check GcpBackend URL.');
    }

    onProgress({
      status: 'generating',
      progress: 5,
      message: 'Analyzing image and starting animation...',
      pollingAttempts: 0,
    });

    try {
      // Start video generation with image
      const startResponse = await this.callVeoApi({
        action: 'generate',
        prompt: prompt,
        aspectRatio: settings.aspectRatio,
        imageBase64: imageBase64, // Edge function will handle image upload
      });

      if (!startResponse.success || !startResponse.operationName) {
        throw new Error(startResponse.error || 'Failed to start image-to-video generation');
      }

      const operationName = startResponse.operationName;

      onProgress({
        status: 'polling',
        progress: 15,
        message: 'Animating your image...',
        pollingAttempts: 0,
        estimatedTimeRemaining: 120,
      });

      // Poll for completion
      let pollingAttempts = 0;
      while (pollingAttempts < MAX_POLLING_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, POLLING_INTERVAL));
        pollingAttempts++;

        const progressPercent = Math.min(15 + (pollingAttempts / MAX_POLLING_ATTEMPTS) * 75, 90);

        onProgress({
          status: 'polling',
          progress: progressPercent,
          message: `Creating animation... (${pollingAttempts * 10}s elapsed)`,
          pollingAttempts,
          estimatedTimeRemaining: Math.max(0, (MAX_POLLING_ATTEMPTS - pollingAttempts) * 10),
        });

        const pollResponse = await this.callVeoApi({
          action: 'poll',
          operationName: operationName,
        });

        if (pollResponse.error) {
          throw new Error(pollResponse.error);
        }

        if (pollResponse.done) {
          if (!pollResponse.videoUrl) {
            throw new Error('No video URL returned');
          }

          onProgress({
            status: 'completed',
            progress: 100,
            message: 'Animation complete!',
            pollingAttempts,
          });

          return {
            id: crypto.randomUUID(),
            videoUrl: pollResponse.videoUrl,
            prompt,
            settings,
            createdAt: new Date(),
            duration: settings.duration,
          };
        }
      }

      throw new Error('Image-to-video generation timed out.');
    } catch (error) {
      console.error('Image-to-video error:', error);
      onProgress({
        status: 'error',
        progress: 0,
        message: error instanceof Error ? error.message : 'Image animation failed',
        pollingAttempts: 0,
      });
      throw error;
    }
  }

  /**
   * Extend an existing video by 7 seconds
   */
  async extendVideo(
    videoUrl: string,
    prompt: string,
    settings: VideoSettings,
    onProgress: (progress: GenerationProgress) => void
  ): Promise<GeneratedVideo> {
    if (!this.isInitialized) {
      throw new Error('VeoService not initialized. Check GcpBackend URL.');
    }

    onProgress({
      status: 'generating',
      progress: 5,
      message: 'Preparing video extension...',
      pollingAttempts: 0,
    });

    try {
      // Start video extension
      const startResponse = await this.callVeoApi({
        action: 'generate',
        prompt: prompt,
        aspectRatio: settings.aspectRatio,
        videoUrl: videoUrl, // Edge function will handle video download/upload
      });

      if (!startResponse.success || !startResponse.operationName) {
        throw new Error(startResponse.error || 'Failed to start video extension');
      }

      const operationName = startResponse.operationName;

      onProgress({
        status: 'polling',
        progress: 15,
        message: 'Extending video...',
        pollingAttempts: 0,
        estimatedTimeRemaining: 120,
      });

      // Poll for completion
      let pollingAttempts = 0;
      while (pollingAttempts < MAX_POLLING_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, POLLING_INTERVAL));
        pollingAttempts++;

        const progressPercent = Math.min(15 + (pollingAttempts / MAX_POLLING_ATTEMPTS) * 75, 90);

        onProgress({
          status: 'polling',
          progress: progressPercent,
          message: `Extending video... (${pollingAttempts * 10}s elapsed)`,
          pollingAttempts,
        });

        const pollResponse = await this.callVeoApi({
          action: 'poll',
          operationName: operationName,
        });

        if (pollResponse.error) {
          throw new Error(pollResponse.error);
        }

        if (pollResponse.done) {
          if (!pollResponse.videoUrl) {
            throw new Error('No video URL returned');
          }

          onProgress({
            status: 'completed',
            progress: 100,
            message: 'Video extended!',
            pollingAttempts,
          });

          return {
            id: crypto.randomUUID(),
            videoUrl: pollResponse.videoUrl,
            prompt,
            settings,
            createdAt: new Date(),
            duration: settings.duration + 7, // Extended by 7 seconds
          };
        }
      }

      throw new Error('Video extension timed out.');
    } catch (error) {
      console.error('Video extension error:', error);
      onProgress({
        status: 'error',
        progress: 0,
        message: error instanceof Error ? error.message : 'Video extension failed',
        pollingAttempts: 0,
      });
      throw error;
    }
  }

  /**
   * Cancel an ongoing operation (if supported)
   */
  async cancelOperation(operationName: string): Promise<void> {
    try {
      console.log('Attempting to cancel operation:', operationName);
      // Note: Cancellation support depends on API implementation
    } catch (error) {
      console.error('Failed to cancel operation:', error);
    }
  }
}

// Singleton instance
let veoServiceInstance: VeoService | null = null;

export const getVeoService = (): VeoService => {
  if (!veoServiceInstance) {
    veoServiceInstance = new VeoService();
  }
  return veoServiceInstance;
};

export default VeoService;
