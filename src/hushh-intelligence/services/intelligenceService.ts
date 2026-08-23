/**
 * Hushh Intelligence Service
 * Handles all GcpBackend operations for Intelligence product
 */

import config from '../../resources/config/config';
import type {
  HushhUser,
  HushhConversation,
  HushhMessage,
  MediaLimits,
  HUSHH_LIMITS,
} from '../core/types';

const gcpBackend = config.gcpBackendClient;

// ============================================
// User Operations
// ============================================

/**
 * Get or create Intelligence user from GcpBackend auth user
 */
export async function getOrCreateIntelligenceUser(): Promise<HushhUser | null> {
  if (!gcpBackend) return null;

  const { data: { user: authUser } } = await gcpBackend.auth.getUser();
  if (!authUser) return null;

  // Check if user exists in intelligence_users
  const { data: existingUser, error: fetchError } = await gcpBackend
    .from('intelligence_users')
    .select('*')
    .eq('supabase_user_id', authUser.id)
    .single();

  if (existingUser && !fetchError) {
    // Update last login
    await gcpBackend
      .from('intelligence_users')
      .update({ last_login_at: new Date().toISOString() })
      .eq('id', existingUser.id);

    return mapDbUserToHushhUser(existingUser);
  }

  // Create new intelligence user
  const { data: newUser, error: createError } = await gcpBackend
    .from('intelligence_users')
    .insert({
      supabase_user_id: authUser.id,
      email: authUser.email || '',
      display_name: authUser.user_metadata?.full_name || authUser.user_metadata?.name || null,
      avatar_url: authUser.user_metadata?.avatar_url || authUser.user_metadata?.picture || null,
    })
    .select()
    .single();

  if (createError) {
    console.error('Error creating intelligence user:', createError);
    return null;
  }

  // Create media limits record
  await gcpBackend
    .from('intelligence_media_limits')
    .insert({ user_id: newUser.id });

  return mapDbUserToHushhUser(newUser);
}

/**
 * Get current Intelligence user
 */
export async function getCurrentIntelligenceUser(): Promise<HushhUser | null> {
  if (!gcpBackend) return null;

  const { data: { user: authUser } } = await gcpBackend.auth.getUser();
  if (!authUser) return null;

  const { data, error } = await gcpBackend
    .from('intelligence_users')
    .select('*')
    .eq('supabase_user_id', authUser.id)
    .single();

  if (error || !data) return null;
  return mapDbUserToHushhUser(data);
}

// ============================================
// Conversation Operations
// ============================================

/**
 * Get all conversations for current user
 */
export async function getConversations(): Promise<HushhConversation[]> {
  if (!gcpBackend) return [];

  const user = await getCurrentIntelligenceUser();
  if (!user) return [];

  const { data, error } = await gcpBackend
    .from('intelligence_conversations')
    .select('*')
    .eq('user_id', user.id)
    .order('updated_at', { ascending: false });

  if (error || !data) return [];
  return data.map(mapDbConversationToHushh);
}

/**
 * Create a new conversation
 */
export async function createConversation(title?: string): Promise<HushhConversation | null> {
  if (!gcpBackend) return null;

  const user = await getCurrentIntelligenceUser();
  if (!user) return null;

  const { data, error } = await gcpBackend
    .from('intelligence_conversations')
    .insert({
      user_id: user.id,
      title: title || 'New Chat',
    })
    .select()
    .single();

  if (error || !data) {
    console.error('Error creating conversation:', error);
    return null;
  }

  // Increment conversation count
  await gcpBackend
    .from('intelligence_users')
    .update({ total_conversations: user.totalConversations + 1 })
    .eq('id', user.id);

  return mapDbConversationToHushh(data);
}

/**
 * Update conversation title
 */
export async function updateConversationTitle(
  conversationId: string,
  title: string
): Promise<boolean> {
  if (!gcpBackend) return false;

  const { error } = await gcpBackend
    .from('intelligence_conversations')
    .update({ title })
    .eq('id', conversationId);

  return !error;
}

/**
 * Delete a conversation
 */
export async function deleteConversation(conversationId: string): Promise<boolean> {
  if (!gcpBackend) return false;

  const { error } = await gcpBackend
    .from('intelligence_conversations')
    .delete()
    .eq('id', conversationId);

  return !error;
}

// ============================================
// Message Operations
// ============================================

/**
 * Get messages for a conversation
 */
export async function getMessages(conversationId: string): Promise<HushhMessage[]> {
  if (!gcpBackend) return [];

  const { data, error } = await gcpBackend
    .from('intelligence_messages')
    .select('*')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true });

  if (error || !data) return [];
  return data.map(mapDbMessageToHushh);
}

/**
 * Add a message to conversation
 */
export async function addMessage(
  conversationId: string,
  role: 'user' | 'assistant',
  content: string,
  mediaUrls?: string[]
): Promise<HushhMessage | null> {
  if (!gcpBackend) return null;

  const { data, error } = await gcpBackend
    .from('intelligence_messages')
    .insert({
      conversation_id: conversationId,
      role,
      content,
      media_urls: mediaUrls || [],
    })
    .select()
    .single();

  if (error || !data) {
    console.error('Error adding message:', error);
    return null;
  }

  return mapDbMessageToHushh(data);
}

// ============================================
// Media Limits Operations
// ============================================

/**
 * Get current media limits for user
 */
export async function getMediaLimits(): Promise<MediaLimits | null> {
  if (!gcpBackend) return null;

  const user = await getCurrentIntelligenceUser();
  if (!user) return null;

  const { data, error } = await gcpBackend
    .from('intelligence_media_limits')
    .select('*')
    .eq('user_id', user.id)
    .single();

  if (error || !data) {
    // Create limits if not exists
    const { data: newLimits } = await gcpBackend
      .from('intelligence_media_limits')
      .insert({ user_id: user.id })
      .select()
      .single();

    if (newLimits) {
      return mapDbMediaLimits(newLimits);
    }
    return null;
  }

  return mapDbMediaLimits(data);
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
 * Increment upload count after successful upload
 */
export async function incrementUploadCount(): Promise<boolean> {
  if (!gcpBackend) return false;

  const user = await getCurrentIntelligenceUser();
  if (!user) return false;

  // Use RPC for atomic increment
  const { error: rpcError } = await gcpBackend.rpc('increment_intelligence_uploads', {
    p_user_id: user.id,
  });

  return !rpcError;
}

// ============================================
// Mapper Functions
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
  total_conversations: number;
  is_active: boolean;
}

interface DbConversation {
  id: string;
  user_id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

interface DbMessage {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant';
  content: string;
  media_urls: string[];
  created_at: string;
}

interface DbMediaLimits {
  user_id: string;
  daily_uploads: number;
  last_reset: string;
}

function mapDbUserToHushhUser(db: DbUser): HushhUser {
  return {
    id: db.id,
    supabaseUserId: db.supabase_user_id,
    email: db.email,
    displayName: db.display_name,
    avatarUrl: db.avatar_url,
    createdAt: new Date(db.created_at),
    lastLoginAt: new Date(db.last_login_at),
    totalMessages: db.total_messages,
    totalConversations: db.total_conversations,
    isActive: db.is_active,
  };
}

function mapDbConversationToHushh(db: DbConversation): HushhConversation {
  return {
    id: db.id,
    userId: db.user_id,
    title: db.title,
    createdAt: new Date(db.created_at),
    updatedAt: new Date(db.updated_at),
  };
}

function mapDbMessageToHushh(db: DbMessage): HushhMessage {
  return {
    id: db.id,
    conversationId: db.conversation_id,
    role: db.role,
    content: db.content,
    mediaUrls: db.media_urls || [],
    createdAt: new Date(db.created_at),
  };
}

function mapDbMediaLimits(db: DbMediaLimits): MediaLimits {
  const maxDaily = 20; // From HUSHH_LIMITS
  return {
    dailyUploads: db.daily_uploads,
    maxDailyUploads: maxDaily,
    remainingUploads: Math.max(0, maxDaily - db.daily_uploads),
    lastReset: new Date(db.last_reset),
  };
}

// ============================================
// Auth Subscription
// ============================================

/**
 * Subscribe to auth state changes
 */
export function onAuthStateChange(
  callback: (isAuthenticated: boolean) => void
): () => void {
  if (!gcpBackend) {
    return () => {};
  }

  const { data: { subscription } } = gcpBackend.auth.onAuthStateChange(
    (_event, session) => {
      callback(!!session);
    }
  );

  return () => subscription.unsubscribe();
}
