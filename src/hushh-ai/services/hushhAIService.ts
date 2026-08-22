/**
 * Hushh AI Service
 * All database operations for Hushh AI
 */

import config from '../../resources/config/config';
import type { HushhAIUser, HushhChat, HushhMessage, MediaLimits, MessageMetadata } from '../core/types';
import { LIMITS } from '../core/constants';

const gcpBackend = config.gcpBackendClient;

// ============================================
// User Operations
// ============================================

/**
 * Get or create Hushh AI user
 */
export async function getOrCreateUser(): Promise<HushhAIUser | null> {
  if (!gcpBackend) return null;

  const { data: { user: authUser } } = await gcpBackend.auth.getUser();
  if (!authUser) return null;

  // Check if exists
  const { data: existing } = await gcpBackend
    .from('hushh_ai_users')
    .select('*')
    .eq('supabase_user_id', authUser.id)
    .single();

  if (existing) {
    // Update last login
    await gcpBackend
      .from('hushh_ai_users')
      .update({ last_login_at: new Date().toISOString() })
      .eq('id', existing.id);

    return mapUser(existing);
  }

  // Create new
  const { data: newUser, error } = await gcpBackend
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
    console.error('Error creating user:', error);
    return null;
  }

  // Create media limits record
  await gcpBackend
    .from('hushh_ai_media_limits')
    .insert({ user_id: newUser.id });

  return mapUser(newUser);
}

/**
 * Get current user
 */
export async function getCurrentUser(): Promise<HushhAIUser | null> {
  if (!gcpBackend) return null;

  const { data: { user: authUser } } = await gcpBackend.auth.getUser();
  if (!authUser) return null;

  const { data } = await gcpBackend
    .from('hushh_ai_users')
    .select('*')
    .eq('supabase_user_id', authUser.id)
    .single();

  if (!data) return null;
  return mapUser(data);
}

// ============================================
// Chat Operations
// ============================================

/**
 * Get all chats for current user
 */
export async function getChats(): Promise<HushhChat[]> {
  if (!gcpBackend) return [];

  const user = await getCurrentUser();
  if (!user) return [];

  const { data } = await gcpBackend
    .from('hushh_ai_chats')
    .select('*')
    .eq('user_id', user.id)
    .order('updated_at', { ascending: false })
    .limit(LIMITS.sidebar.maxChatsToShow);

  if (!data) return [];
  return data.map(mapChat);
}

/**
 * Get single chat by ID
 */
export async function getChatById(chatId: string): Promise<HushhChat | null> {
  if (!gcpBackend) return null;

  const { data } = await gcpBackend
    .from('hushh_ai_chats')
    .select('*')
    .eq('id', chatId)
    .single();

  if (!data) return null;
  return mapChat(data);
}

/**
 * Create new chat
 */
export async function createChat(title?: string): Promise<HushhChat | null> {
  if (!gcpBackend) return null;

  const user = await getCurrentUser();
  if (!user) return null;

  const { data, error } = await gcpBackend
    .from('hushh_ai_chats')
    .insert({
      user_id: user.id,
      title: title || 'New Chat',
    })
    .select()
    .single();

  if (error) {
    console.error('Error creating chat:', error);
    return null;
  }

  // Update user chat count
  await gcpBackend
    .from('hushh_ai_users')
    .update({ total_chats: user.totalChats + 1 })
    .eq('id', user.id);

  return mapChat(data);
}

/**
 * Update chat title
 */
export async function updateChatTitle(chatId: string, title: string): Promise<boolean> {
  if (!gcpBackend) return false;

  const { error } = await gcpBackend
    .from('hushh_ai_chats')
    .update({ title })
    .eq('id', chatId);

  return !error;
}

/**
 * Delete chat
 */
export async function deleteChat(chatId: string): Promise<boolean> {
  if (!gcpBackend) return false;

  const { error } = await gcpBackend
    .from('hushh_ai_chats')
    .delete()
    .eq('id', chatId);

  return !error;
}

// ============================================
// Message Operations
// ============================================

/**
 * Get messages for a chat
 */
export async function getMessages(chatId: string): Promise<HushhMessage[]> {
  if (!gcpBackend) return [];

  const { data } = await gcpBackend
    .from('hushh_ai_messages')
    .select('*')
    .eq('chat_id', chatId)
    .order('created_at', { ascending: true })
    .limit(LIMITS.chat.maxHistoryMessages);

  if (!data) return [];
  return data.map(mapMessage);
}

/**
 * Add message to chat
 */
export async function addMessage(
  chatId: string,
  role: 'user' | 'assistant',
  content: string,
  mediaUrls: string[] = [],
  metadata?: MessageMetadata
): Promise<HushhMessage | null> {
  if (!gcpBackend) return null;

  const insertData: {
    chat_id: string;
    role: 'user' | 'assistant';
    content: string;
    media_urls: string[];
    metadata?: Record<string, unknown>;
  } = {
    chat_id: chatId,
    role,
    content,
    media_urls: mediaUrls,
  };

  // Only include metadata if it exists and has values
  if (metadata && Object.keys(metadata).length > 0) {
    insertData.metadata = metadata as Record<string, unknown>;
  }

  const { data, error } = await gcpBackend
    .from('hushh_ai_messages')
    .insert(insertData)
    .select()
    .single();

  if (error) {
    console.error('Error adding message:', error);
    return null;
  }

  return mapMessage(data);
}

// ============================================
// Media Limit Operations
// ============================================

/**
 * Get media limits for current user
 */
export async function getMediaLimits(): Promise<MediaLimits | null> {
  if (!gcpBackend) return null;

  const user = await getCurrentUser();
  if (!user) return null;

  const { data } = await gcpBackend
    .from('hushh_ai_media_limits')
    .select('*')
    .eq('user_id', user.id)
    .single();

  if (!data) {
    // Create if not exists
    const { data: newLimits } = await gcpBackend
      .from('hushh_ai_media_limits')
      .insert({ user_id: user.id })
      .select()
      .single();

    if (newLimits) return mapMediaLimits(newLimits);
    return null;
  }

  return mapMediaLimits(data);
}

/**
 * Check if user can upload more media
 */
export async function canUploadMedia(): Promise<boolean> {
  const limits = await getMediaLimits();
  if (!limits) return false;
  return limits.remainingUploads > 0;
}

/**
 * Increment upload count
 */
export async function incrementUploadCount(): Promise<boolean> {
  if (!gcpBackend) return false;

  const user = await getCurrentUser();
  if (!user) return false;

  const { data, error } = await gcpBackend.rpc('increment_hushh_ai_uploads', {
    p_user_id: user.id,
  });

  return !error && data === true;
}

// ============================================
// Media Upload
// ============================================

/**
 * Upload media file
 */
export async function uploadMedia(file: File): Promise<string | null> {
  if (!gcpBackend) return null;

  const { data: { user } } = await gcpBackend.auth.getUser();
  if (!user) return null;

  // Check limits first
  const canUpload = await canUploadMedia();
  if (!canUpload) {
    console.error('Daily upload limit reached');
    return null;
  }

  // Generate unique filename
  const ext = file.name.split('.').pop();
  const fileName = `${user.id}/${Date.now()}-${Math.random().toString(36).substring(7)}.${ext}`;

  // Upload
  const { error } = await gcpBackend.storage
    .from('hushh-ai-media')
    .upload(fileName, file, {
      cacheControl: '3600',
      upsert: false,
    });

  if (error) {
    console.error('Error uploading file:', error);
    return null;
  }

  // Increment counter
  await incrementUploadCount();

  // Get public URL
  const { data: urlData } = gcpBackend.storage
    .from('hushh-ai-media')
    .getPublicUrl(fileName);

  return urlData.publicUrl;
}

// ============================================
// Auth Helpers
// ============================================

/**
 * Check if user is authenticated
 */
export async function isAuthenticated(): Promise<boolean> {
  if (!gcpBackend) return false;
  const { data: { session } } = await gcpBackend.auth.getSession();
  return !!session;
}

/**
 * Subscribe to auth changes
 */
export function onAuthChange(callback: (isLoggedIn: boolean) => void): () => void {
  if (!gcpBackend) return () => {};

  const { data: { subscription } } = gcpBackend.auth.onAuthStateChange(
    (_event, session) => {
      callback(!!session);
    }
  );

  return () => subscription.unsubscribe();
}

/**
 * Sign out current user
 */
export async function signOut(): Promise<boolean> {
  if (!gcpBackend) return false;

  // Clear profile cache
  try {
    sessionStorage.removeItem('hushh_ai_profile');
  } catch (e) {
    console.warn('Failed to clear profile cache:', e);
  }

  const { error } = await gcpBackend.auth.signOut();
  return !error;
}

const PROFILE_CACHE_KEY = 'hushh_ai_profile';
const PROFILE_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Get user email and avatar
 */
export async function getUserProfile(): Promise<{ email: string; displayName: string | null; avatarUrl: string | null } | null> {
  if (!gcpBackend) {
    console.error('getUserProfile: GcpBackend client not initialized');
    return null;
  }

  // Check cache first
  try {
    const cached = sessionStorage.getItem(PROFILE_CACHE_KEY);
    if (cached) {
      const parsed = JSON.parse(cached);
      const age = Date.now() - parsed.timestamp;
      if (age < PROFILE_CACHE_TTL) {
        console.log('getUserProfile: Returning cached profile');
        return parsed.data;
      }
    }
  } catch (cacheError) {
    console.warn('getUserProfile: Cache read error:', cacheError);
  }

  try {
    const { data: { user }, error } = await gcpBackend.auth.getUser();

    if (error) {
      console.error('getUserProfile: Failed to get user from GcpBackend Auth:', error);
      return null;
    }

    if (!user) {
      console.error('getUserProfile: No authenticated user found');
      return null;
    }

    // Validate email exists
    if (!user.email) {
      console.warn('getUserProfile: User missing email field');
    }

    const profile = {
      email: user.email || 'Unknown',
      displayName: user.user_metadata?.full_name || user.user_metadata?.name || null,
      avatarUrl: user.user_metadata?.avatar_url || user.user_metadata?.picture || null,
    };

    // Cache for next time
    try {
      sessionStorage.setItem(PROFILE_CACHE_KEY, JSON.stringify({
        data: profile,
        timestamp: Date.now(),
      }));
    } catch (cacheError) {
      console.warn('getUserProfile: Cache write error:', cacheError);
    }

    return profile;
  } catch (error) {
    console.error('getUserProfile: Unexpected error:', error);
    return null;
  }
}

// ============================================
// Mappers
// ============================================

interface DbUser {
  id: string;
  supabase_user_id: string;
  email: string;
  display_name: string | null;
  avatar_url: string | null;
  created_at: string;
  last_login_at: string;
  total_messages: number;
  total_chats: number;
  is_active: boolean;
}

interface DbChat {
  id: string;
  user_id: string;
  title: string;
  created_at: string;
  updated_at: string;
  message_count: number;
}

interface DbMessage {
  id: string;
  chat_id: string;
  role: 'user' | 'assistant';
  content: string;
  media_urls: string[];
  created_at: string;
  metadata?: Record<string, unknown>;
}

interface DbMediaLimits {
  user_id: string;
  daily_uploads: number;
  last_reset: string;
}

function mapUser(db: DbUser): HushhAIUser {
  return {
    id: db.id,
    supabaseUserId: db.supabase_user_id,
    email: db.email,
    displayName: db.display_name,
    avatarUrl: db.avatar_url,
    createdAt: new Date(db.created_at),
    lastLoginAt: new Date(db.last_login_at),
    totalMessages: db.total_messages,
    totalChats: db.total_chats,
    isActive: db.is_active,
  };
}

function mapChat(db: DbChat): HushhChat {
  return {
    id: db.id,
    userId: db.user_id,
    title: db.title,
    createdAt: new Date(db.created_at),
    updatedAt: new Date(db.updated_at),
    messageCount: db.message_count,
  };
}

function mapMessage(db: DbMessage): HushhMessage {
  return {
    id: db.id,
    chatId: db.chat_id,
    role: db.role,
    content: db.content,
    mediaUrls: db.media_urls || [],
    createdAt: new Date(db.created_at),
    metadata: db.metadata as MessageMetadata | undefined,
  };
}

function mapMediaLimits(db: DbMediaLimits): MediaLimits {
  const max = LIMITS.media.maxDailyUploads;
  return {
    dailyUploads: db.daily_uploads,
    maxDailyUploads: max,
    remainingUploads: Math.max(0, max - db.daily_uploads),
    lastReset: new Date(db.last_reset),
  };
}
