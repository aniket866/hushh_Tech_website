/**
 * User Repository Implementation
 * Implements IUserRepository using GcpBackend data source
 */
import { IUserRepository } from '../../domain/repositories';
import { User } from '../../domain/entities';
import { GcpBackendUserDataSource } from '../datasources';
import { userMapper } from '../models/mappers';
import { retryWithBackoff } from '../../core/utils';

export class UserRepositoryImpl implements IUserRepository {
  constructor(private dataSource: GcpBackendUserDataSource) {}

  async getCurrent(): Promise<User | null> {
    const dto = await retryWithBackoff(() =>
      this.dataSource.getCurrent()
    );
    return dto ? userMapper.toDomain(dto) : null;
  }

  async getOrCreate(): Promise<User | null> {
    const dto = await retryWithBackoff(() =>
      this.dataSource.getOrCreate()
    );
    return dto ? userMapper.toDomain(dto) : null;
  }

  async updateProfile(
    userId: string,
    displayName?: string,
    avatarUrl?: string
  ): Promise<User | null> {
    const dto = await retryWithBackoff(() =>
      this.dataSource.updateProfile(userId, displayName, avatarUrl)
    );
    return dto ? userMapper.toDomain(dto) : null;
  }

  async updateLastLogin(userId: string): Promise<void> {
    await retryWithBackoff(() =>
      this.dataSource.updateLastLogin(userId)
    );
  }

  async isAuthenticated(): Promise<boolean> {
    return this.dataSource.isAuthenticated();
  }
}
