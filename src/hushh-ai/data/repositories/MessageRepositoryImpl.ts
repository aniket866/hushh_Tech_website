/**
 * Message Repository Implementation
 * Implements IMessageRepository using GcpBackend data source
 */
import { IMessageRepository } from '../../domain/repositories';
import { Message, MessageRole, MessageMetadata } from '../../domain/entities';
import { GcpBackendMessageDataSource } from '../datasources';
import { messageMapper } from '../models/mappers';
import { retryWithBackoff } from '../../core/utils';

export class MessageRepositoryImpl implements IMessageRepository {
  constructor(private dataSource: GcpBackendMessageDataSource) {}

  async getAll(chatId: string, limit?: number): Promise<Message[]> {
    const dtos = await retryWithBackoff(() =>
      this.dataSource.getAll(chatId, limit)
    );
    return dtos.map(messageMapper.toDomain);
  }

  async getById(messageId: string): Promise<Message | null> {
    const dto = await retryWithBackoff(() =>
      this.dataSource.getById(messageId)
    );
    return dto ? messageMapper.toDomain(dto) : null;
  }

  async add(
    chatId: string,
    role: MessageRole,
    content: string,
    mediaUrls?: string[],
    metadata?: MessageMetadata
  ): Promise<Message> {
    const dto = await retryWithBackoff(() =>
      this.dataSource.add(chatId, role, content, mediaUrls || [], metadata)
    );
    return messageMapper.toDomain(dto);
  }

  async delete(messageId: string): Promise<boolean> {
    return this.dataSource.delete(messageId);
  }

  async search(chatId: string, query: string): Promise<Message[]> {
    // Get all messages and filter locally
    const messages = await this.getAll(chatId);
    const lowerQuery = query.toLowerCase();
    return messages.filter(msg =>
      msg.content.toLowerCase().includes(lowerQuery)
    );
  }
}
