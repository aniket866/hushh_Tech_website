/**
 * Chat Repository Implementation
 * Implements IChatRepository using GcpBackend data source
 */
import { IChatRepository } from '../../domain/repositories';
import { Chat } from '../../domain/entities';
import { GcpBackendChatDataSource } from '../datasources';
import { chatMapper } from '../models/mappers';
import { retryWithBackoff } from '../../core/utils';

export class ChatRepositoryImpl implements IChatRepository {
  constructor(private dataSource: GcpBackendChatDataSource) {}

  async getAll(userId: string, limit?: number): Promise<Chat[]> {
    const dtos = await retryWithBackoff(() =>
      this.dataSource.getAll(userId, limit)
    );
    return dtos.map(chatMapper.toDomain);
  }

  async getById(chatId: string): Promise<Chat | null> {
    const dto = await retryWithBackoff(() =>
      this.dataSource.getById(chatId)
    );
    return dto ? chatMapper.toDomain(dto) : null;
  }

  async create(userId: string, title?: string): Promise<Chat> {
    const dto = await retryWithBackoff(() =>
      this.dataSource.create(userId, title)
    );
    return chatMapper.toDomain(dto);
  }

  async updateTitle(chatId: string, title: string): Promise<Chat | null> {
    const dto = await retryWithBackoff(() =>
      this.dataSource.updateTitle(chatId, title)
    );
    return dto ? chatMapper.toDomain(dto) : null;
  }

  async delete(chatId: string): Promise<boolean> {
    return this.dataSource.delete(chatId);
  }

  async search(userId: string, query: string): Promise<Chat[]> {
    // Get all chats and filter locally (simple search)
    const chats = await this.getAll(userId);
    const lowerQuery = query.toLowerCase();
    return chats.filter(chat =>
      chat.title.toLowerCase().includes(lowerQuery)
    );
  }
}
