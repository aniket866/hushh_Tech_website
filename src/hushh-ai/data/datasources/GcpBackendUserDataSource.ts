/**
 * GcpBackend User Data Source
 * Handles all GcpBackend operations for users
 */
import { GcpBackendClient } from '@/services/gcpBackend/types';
import { UserDTO } from '../models/UserDTO';
import { NetworkError } from '../../core/errors';
import { logger } from '../../core/utils';

export class GcpBackendUserDataSource {
  constructor(private gcpBackend: GcpBackendClient) {}

  async getCurrent(): Promise<UserDTO | null> {
    try {
      const { data: { user: authUser } } = await this.gcpBackend.auth.getUser();
      if (!authUser) return null;

      const { data, error } = await this.gcpBackend
        .from('hushh_ai_users')
        .select('*')
        .eq('supabase_user_id', authUser.id)
        .single();

      if (error) {
        if (error.code === 'PGRST116') return null; // Not found
        logger.error('Error fetching current user', error);
        throw new NetworkError(`Failed to fetch user: ${error.message}`);
      }

      return data;
    } catch (error) {
      if (error instanceof NetworkError) throw error;
      logger.error('Unexpected error fetching current user', error as Error);
      throw new NetworkError('Failed to fetch user');
    }
  }

  async getOrCreate(): Promise<UserDTO | null> {
    try {
      const { data: { user: authUser } } = await this.gcpBackend.auth.getUser();
      if (!authUser) return null;

      // Check if exists
      const { data: existing } = await this.gcpBackend
        .from('hushh_ai_users')
        .select('*')
        .eq('supabase_user_id', authUser.id)
        .single();

      if (existing) {
        // Update last login
        await this.gcpBackend
          .from('hushh_ai_users')
          .update({ last_login_at: new Date().toISOString() })
          .eq('id', existing.id);

        return { ...existing, last_login_at: new Date().toISOString() };
      }

      // Create new user
      const { data: newUser, error } = await this.gcpBackend
        .from('hushh_ai_users')
        .insert({
          supabase_user_id: authUser.id,
          email: authUser.email || '',
          display_name: authUser.user_metadata?.full_name || authUser.user_metadata?.name || null,
          avatar_url: authUser.user_metadata?.avatar_url || authUser.user_metadata?.picture || null,
        })
        .select()
        .single();

      if (error) {
        logger.error('Error creating user', error);
        throw new NetworkError(`Failed to create user: ${error.message}`);
      }

      // Create media limits record
      await this.gcpBackend
        .from('hushh_ai_media_limits')
        .insert({ user_id: newUser.id });

      return newUser;
    } catch (error) {
      if (error instanceof NetworkError) throw error;
      logger.error('Unexpected error in getOrCreate', error as Error);
      throw new NetworkError('Failed to get or create user');
    }
  }

  async updateProfile(
    userId: string,
    displayName?: string,
    avatarUrl?: string
  ): Promise<UserDTO | null> {
    try {
      const updates: Partial<UserDTO> = {};
      if (displayName !== undefined) updates.display_name = displayName;
      if (avatarUrl !== undefined) updates.avatar_url = avatarUrl;

      const { data, error } = await this.gcpBackend
        .from('hushh_ai_users')
        .update(updates)
        .eq('id', userId)
        .select()
        .single();

      if (error) {
        logger.error('Error updating user profile', error);
        throw new NetworkError(`Failed to update profile: ${error.message}`);
      }

      return data;
    } catch (error) {
      if (error instanceof NetworkError) throw error;
      logger.error('Unexpected error updating profile', error as Error);
      throw new NetworkError('Failed to update profile');
    }
  }

  async updateLastLogin(userId: string): Promise<void> {
    try {
      const { error } = await this.gcpBackend
        .from('hushh_ai_users')
        .update({ last_login_at: new Date().toISOString() })
        .eq('id', userId);

      if (error) {
        logger.error('Error updating last login', error);
        throw new NetworkError(`Failed to update last login: ${error.message}`);
      }
    } catch (error) {
      if (error instanceof NetworkError) throw error;
      logger.error('Unexpected error updating last login', error as Error);
      throw new NetworkError('Failed to update last login');
    }
  }

  async isAuthenticated(): Promise<boolean> {
    try {
      const { data: { session } } = await this.gcpBackend.auth.getSession();
      return !!session;
    } catch (error) {
      logger.error('Error checking authentication', error as Error);
      return false;
    }
  }
}
