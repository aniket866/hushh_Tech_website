/**
 * Product Usage Tracking Service
 * Tracks when authenticated users access different products (hushh-ai, kyc, etc.)
 */
import config from '../../resources/config/config';

export interface ProductUsageMetadata {
  device?: 'mobile' | 'tablet' | 'desktop';
  platform?: 'web' | 'ios' | 'android';
  referrer?: string;
  userAgent?: string;
  screenSize?: string;
}

export interface ProductUsageRecord {
  id: string;
  user_id: string;
  product_name: string;
  first_access_at: string;
  last_access_at: string;
  access_count: number;
  metadata: ProductUsageMetadata;
  created_at: string;
  updated_at: string;
}

export interface ProductUsageRpcResult {
  success: boolean;
  error?: string;
}

/**
 * Detect device type from user agent
 */
function detectDevice(): 'mobile' | 'tablet' | 'desktop' {
  const userAgent = navigator.userAgent.toLowerCase();
  if (/mobile|iphone|android.*mobile|windows phone/i.test(userAgent)) {
    return 'mobile';
  }
  if (/tablet|ipad|android(?!.*mobile)/i.test(userAgent)) {
    return 'tablet';
  }
  return 'desktop';
}

/**
 * Detect platform
 */
function detectPlatform(): 'web' | 'ios' | 'android' {
  const userAgent = typeof navigator !== 'undefined' ? navigator.userAgent.toLowerCase() : '';
  if (/iphone|ipad|ipod/.test(userAgent)) return 'ios';
  if (/android/.test(userAgent)) return 'android';
  return 'web';
}

/**
 * Build metadata object for tracking
 */
function buildMetadata(): ProductUsageMetadata {
  return {
    device: detectDevice(),
    platform: detectPlatform(),
    referrer: typeof document !== 'undefined' ? document.referrer || undefined : undefined,
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
    screenSize: typeof window !== 'undefined' ? `${window.innerWidth}x${window.innerHeight}` : undefined,
  };
}

/**
 * Track product usage for the authenticated user
 * Uses GcpBackend RPC function for upsert with access_count increment
 * 
 * @param productName - The product identifier (e.g., 'hushh-ai', 'kyc', 'investor-profile')
 * @param additionalMetadata - Optional additional metadata to store
 * @returns The RPC result, or null if not authenticated
 */
export async function trackProductUsage(
  productName: string,
  additionalMetadata?: Partial<ProductUsageMetadata>
): Promise<ProductUsageRpcResult | null> {
  try {
    const gcpBackend = config.gcpBackendClient;
    if (!gcpBackend) {
      console.warn('[ProductUsage] GcpBackend client not initialized');
      return null;
    }

    // Get current user
    const { data: { user }, error: userError } = await gcpBackend.auth.getUser();
    
    if (userError || !user) {
      // User not authenticated - skip tracking silently
      console.info('[ProductUsage] User not authenticated, skipping tracking');
      return null;
    }

    // Build metadata
    const metadata: ProductUsageMetadata = {
      ...buildMetadata(),
      ...additionalMetadata,
    };

    // Call the RPC function to upsert product usage
    const { data, error } = await gcpBackend.rpc('track_product_usage', {
      p_product_name: productName,
      p_metadata: metadata,
    });

    if (error) {
      console.error('[ProductUsage] Error tracking usage:', error.message);
      return null;
    }

    console.info(`[ProductUsage] Tracked access to "${productName}" for user ${user.id}`);
    return data as ProductUsageRpcResult;
  } catch (err) {
    console.error('[ProductUsage] Unexpected error:', err);
    return null;
  }
}

/**
 * Get all product usage records for the current user
 */
export async function getUserProductUsage(): Promise<ProductUsageRecord[]> {
  try {
    const gcpBackend = config.gcpBackendClient;
    if (!gcpBackend) {
      console.warn('[ProductUsage] GcpBackend client not initialized');
      return [];
    }

    const { data: { user }, error: userError } = await gcpBackend.auth.getUser();
    
    if (userError || !user) {
      return [];
    }

    const { data, error } = await gcpBackend
      .from('user_product_usage')
      .select('*')
      .eq('user_id', user.id)
      .order('last_access_at', { ascending: false });

    if (error) {
      console.error('[ProductUsage] Error fetching usage:', error.message);
      return [];
    }

    return data as ProductUsageRecord[];
  } catch (err) {
    console.error('[ProductUsage] Unexpected error:', err);
    return [];
  }
}

/**
 * Get product usage for a specific product
 */
export async function getProductUsage(productName: string): Promise<ProductUsageRecord | null> {
  try {
    const gcpBackend = config.gcpBackendClient;
    if (!gcpBackend) {
      return null;
    }

    const { data: { user }, error: userError } = await gcpBackend.auth.getUser();
    
    if (userError || !user) {
      return null;
    }

    const { data, error } = await gcpBackend
      .from('user_product_usage')
      .select('*')
      .eq('user_id', user.id)
      .eq('product_name', productName)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        // No record found
        return null;
      }
      console.error('[ProductUsage] Error fetching usage:', error.message);
      return null;
    }

    return data as ProductUsageRecord;
  } catch (err) {
    console.error('[ProductUsage] Unexpected error:', err);
    return null;
  }
}

// Product name constants for type safety
export const PRODUCTS = {
  HUSHH_AI: 'hushh-ai',
  KYC: 'kyc',
  INVESTOR_PROFILE: 'investor-profile',
  ONBOARDING: 'onboarding',
  COMMUNITY: 'community',
  RECEIPT_GENERATOR: 'receipt-generator',
} as const;

export type ProductName = typeof PRODUCTS[keyof typeof PRODUCTS];
