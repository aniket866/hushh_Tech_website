// src/services/reportService.ts

import {
  HushhResearchCompatibilityError,
  readHushhResearchCompatibilityIfActive,
  type CompatibilityRequestOptions,
} from './hushhResearch/compatibility';

const REPORTS_SUPABASE_URL = import.meta.env.VITE_MARKET_SUPABASE_URL || "";
const REPORTS_SUPABASE_KEY = import.meta.env.VITE_MARKET_SUPABASE_KEY || "";

// Supabase storage buckets (public)
export const STORAGE_BUCKETS = {
  IMAGES: REPORTS_SUPABASE_URL
    ? `${REPORTS_SUPABASE_URL}/storage/v1/object/public/alohafundsreport-images`
    : '',
  VIDEOS: REPORTS_SUPABASE_URL
    ? `${REPORTS_SUPABASE_URL}/storage/v1/object/public/alohafundsreport-videos`
    : '',
};

// Supabase REST API base URL & anon key
const API_BASE = REPORTS_SUPABASE_URL ? `${REPORTS_SUPABASE_URL}/rest/v1` : '';
const API_KEY = REPORTS_SUPABASE_KEY;

// Raw shape returned by Supabase
interface RawReport {
  id: string;
  title: string;
  subtitle?: string;
  date: string;           // e.g. "14/03/2025" or "2025-03-14"
  time?: string;
  description?: string;
  image_urls?: string[];  // e.g. ["1.png","2.jpg",…]
  video_urls?: string[];  // e.g. ["1.mp4",…]
  [k: string]: unknown;
}

// Enriched Report for your React code
export interface Report {
  id: string;
  title: string;
  subtitle?: string;
  date: string;
  time?: string;
  description?: string;
  image_urls: string[];
  video_urls: string[];
  public_image_urls: string[];
  public_video_urls: string[];
  storage_state?: 'available' | 'pending' | 'unavailable';
  [k: string]: unknown;
}

/**
 * Convert "14/03/2025" (or ISO) into your bucket folder name "dmu14mar"
 */
function dateToFolder(name: string): string {
  // if incoming is dd/mm/yyyy
  const m = name.match(/^(\d{1,2})\/(\d{1,2})\/\d{4}$/);
  if (m) {
    const day = parseInt(m[1], 10);
    const monthNames = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
    const mon = monthNames[ parseInt(m[2],10) - 1 ];
    return `dmu${day}${mon}`;
  }
  // otherwise assume it's already a folder string like "dmu14mar"
  return name;
}

function titleFromReportType(reportType: string): string {
  const title = reportType
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
  return title || reportType;
}

function dateFromTimestamp(timestampMs: number): string {
  const date = new Date(timestampMs);
  if (Number.isNaN(date.getTime())) {
    throw new HushhResearchCompatibilityError('UPSTREAM_UNAVAILABLE');
  }
  return date.toISOString().slice(0, 10);
}

export async function getHushhResearchReportById(
  id: string,
  options: Pick<CompatibilityRequestOptions, 'researchBoundary'> = {},
): Promise<Report | null | 'legacy'> {
  const result = await readHushhResearchCompatibilityIfActive(
    'report_asset',
    options,
  );
  if (result.mode === 'legacy') return 'legacy';

  const { payload } = result.response;
  if (payload.asset_id !== id) return null;

  return {
    id: payload.asset_id,
    title: titleFromReportType(payload.report_type),
    date: dateFromTimestamp(payload.generated_at_ms),
    report_type: payload.report_type,
    storage_state: payload.storage_state,
    generated_at_ms: payload.generated_at_ms,
    source_hash: result.response.source_hash,
    updated_at_ms: result.response.updated_at_ms,
    // Storage objects are deliberately outside the initial Research cohort.
    image_urls: [],
    video_urls: [],
    public_image_urls: [],
    public_video_urls: [],
  };
}

/**
 * Fetch a single report by ID, then prepend full bucket URLs
 */
export const getReportById = async (
  id: string,
  options: Pick<CompatibilityRequestOptions, 'researchBoundary'> = {},
): Promise<Report | null> => {
  const researchReport = await getHushhResearchReportById(id, options);
  if (researchReport !== 'legacy') return researchReport;

  if (!API_BASE || !API_KEY) {
    console.error('Missing VITE_MARKET_SUPABASE_URL or VITE_MARKET_SUPABASE_KEY');
    return null;
  }

  const res = await fetch(
    `${API_BASE}/reports?id=eq.${id}&select=*`,
    {
      headers: {
        apikey: API_KEY,
        Authorization: `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      cache: 'no-store',
    }
  );
  if (!res.ok) {
    console.error('Failed to fetch report', res.status, res.statusText);
    return null;
  }
  const [raw]: RawReport[] = await res.json();
  if (!raw) return null;

  const folder = dateToFolder(raw.date);
  const imgs  = raw.image_urls  || [];
  const vids  = raw.video_urls  || [];

  return {
    ...raw,
    image_urls: imgs,
    video_urls: vids,
    public_image_urls: imgs.map(fn => `${STORAGE_BUCKETS.IMAGES}/${folder}/${fn}`),
    public_video_urls: vids.map(fn => `${STORAGE_BUCKETS.VIDEOS}/${folder}/${fn}`),
  };
};
