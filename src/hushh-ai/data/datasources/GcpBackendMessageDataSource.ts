/**
 * GcpBackend Message Data Source
 * Handles all GcpBackend operations for messages
 */
import { GcpBackendClient } from '@/services/gcpBackend/types';
import { MessageDTO } from '../models/MessageDTO';
import { NetworkError } from '../../core/errors';
import { logger } from '../../core/utils';

export class GcpBackendMessageDataSource {
  constructor(private gcpBackend: GcpBackendClient) {}

  async getAll(chatId: string, limit: number = 50): Promise<MessageDTO[]> {
    try {
      const { data, error } = await this.gcpBackend
        .from('hushh_ai_messages')
        .select('*')
        .eq('chat_id', chatId)
        .order('created_at', { ascending: true })
        .limit(limit);

      if (error) {
        logger.error('Error fetching messages', error);
        throw new NetworkError(`Failed to fetch messages: ${error.message}`);
      }

      return data || [];
    } catch (error) {
      if (error instanceof NetworkError) throw error;
      logger.error('Unexpected error fetching messages', error as Error);
      throw new NetworkError('Failed to fetch messages');
    }
  }

  async getById(messageId: string): Promise<MessageDTO | null> {
    try {
      const { data, error } = await this.gcpBackend
        .from('hushh_ai_messages')
        .select('*')
        .eq('id', messageId)
        .single();

      if (error) {
        if (error.code === 'PGRST116') return null; // Not found
        logger.error('Error fetching message', error);
        throw new NetworkError(`Failed to fetch message: ${error.message}`);
      }

      return data;
    } catch (error) {
      if (error instanceof NetworkError) throw error;
      logger.error('Unexpected error fetching message', error as Error);
      throw new NetworkError('Failed to fetch message');
    }
  }

  async add(
    chatId: string,
    role: 'user' | 'assistant',
    content: string,
    mediaUrls: string[] = [],
    metadata?: Record<string, unknown>
  ): Promise<MessageDTO> {
    try {
      const { data, error } = await this.gcpBackend
        .from('hushh_ai_messages')
        .insert({
          chat_id: chatId,
          role,
          content,
          media_urls: mediaUrls,
          metadata: metadata || null,
        })
        .select()
        .single();

      if (error) {
        logger.error('Error adding message', error);
        throw new NetworkError(`Failed to add message: ${error.message}`);
      }

      return data;
    } catch (error) {
      if (error instanceof NetworkError) throw error;
      logger.error('Unexpected error adding message', error as Error);
      throw new NetworkError('Failed to add message');
    }
  }

  async delete(messageId: string): Promise<boolean> {
    try {
      const { error } = await this.gcpBackend
        .from('hushh_ai_messages')
        .delete()
        .eq('id', messageId);

      if (error) {
        logger.error('Error deleting message', error);
        throw new NetworkError(`Failed to delete message: ${error.message}`);
      }

      return true;
    } catch (error) {
      if (error instanceof NetworkError) throw error;
      logger.error('Unexpected error deleting message', error as Error);
      return false;
    }
  }
}
