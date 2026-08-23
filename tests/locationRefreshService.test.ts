import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildLocationSignature } from '../src/services/location/cache';
import type { LocationCacheRecord, LocationData } from '../src/services/location/types';

const maybeSingleMock = vi.fn();
const fromMock = vi.fn(() => ({
  select: vi.fn(() => ({
    eq: vi.fn(() => ({
      maybeSingle: maybeSingleMock,
    })),
  })),
}));
const upsertOnboardingDataMock = vi.fn();

vi.mock('../src/resources/config/config', () => ({
  default: {
    GCP_API_BASE_URL: '/api/gcp',
    gcpBackendClient: {
      from: (...args: unknown[]) => fromMock(...args),
    },
  },
}));

vi.mock('../src/services/onboarding/upsertOnboardingData', () => ({
  upsertOnboardingData: (...args: unknown[]) => upsertOnboardingDataMock(...args),
}));

import { LocationService } from '../src/services/location/locationService';

const sanFrancisco = {
  country: 'United States',
  countryCode: 'US',
  state: 'California',
  stateCode: 'CA',
  city: 'San Francisco',
  postalCode: '94105',
  phoneDialCode: '+1',
  timezone: 'America/Los_Angeles',
  formattedAddress: '1 Market St, San Francisco, CA 94105, United States',
  latitude: 37.7749,
  longitude: -122.4194,
} satisfies LocationData;

const cachedRecord = {
  data: sanFrancisco,
  source: 'gps',
  detectedAt: '2026-03-30T10:00:00.000Z',
  lastCheckedAt: '2026-03-30T10:05:00.000Z',
  signature: buildLocationSignature(sanFrancisco),
} satisfies LocationCacheRecord;

describe('LocationService shared refresh flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    upsertOnboardingDataMock.mockResolvedValue({ error: null });
  });

  it('prefers the shared cache before reading the Cloud SQL mirror', async () => {
    const service = new LocationService();
    vi.spyOn(service, 'readSharedLocationCache').mockResolvedValue(cachedRecord);

    const result = await service.getCachedLocation('user-123');

    expect(result?.city).toBe('San Francisco');
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('hydrates cached location from normalized gps_* columns when the legacy blob is absent', async () => {
    const service = new LocationService();
    vi.spyOn(service, 'readSharedLocationCache').mockResolvedValue(null);
    vi.spyOn(service, 'writeSharedLocationCache').mockResolvedValue();
    maybeSingleMock.mockResolvedValueOnce({
      data: {
        gps_latitude: 18.5943,
        gps_longitude: 73.7537,
        gps_city: 'Pune',
        gps_state: 'Maharashtra',
        gps_country: 'India',
        gps_zip_code: '411045',
        gps_full_address: '1, Tower-3, Godrej Hillside, Mahalunge, Pune, Maharashtra 411045, India',
        gps_detected_at: '2026-04-08T08:00:00.000Z',
      },
      error: null,
    });

    const result = await service.getCachedLocation('user-456');

    expect(result).toMatchObject({
      city: 'Pune',
      state: 'Maharashtra',
      country: 'India',
      postalCode: '411045',
      phoneDialCode: '+91',
      formattedAddress: '1, Tower-3, Godrej Hillside, Mahalunge, Pune, Maharashtra 411045, India',
    });
  });

  it('mirrors only normalized gps columns when saving location to onboarding', async () => {
    const service = new LocationService();
    vi.spyOn(service, 'readSharedLocationCache').mockResolvedValue(null);
    vi.spyOn(service, 'writeSharedLocationCache').mockResolvedValue();

    await service.saveLocationToOnboarding('user-789', sanFrancisco, 'gps');

    expect(upsertOnboardingDataMock).toHaveBeenCalledTimes(1);
    expect(upsertOnboardingDataMock).toHaveBeenCalledWith(
      'user-789',
      expect.objectContaining({
        gps_latitude: sanFrancisco.latitude,
        gps_longitude: sanFrancisco.longitude,
        gps_city: 'San Francisco',
        gps_state: 'California',
        gps_country: 'United States',
        gps_zip_code: '94105',
        gps_full_address: '1 Market St, San Francisco, CA 94105, United States',
      })
    );

    const savedPayload = upsertOnboardingDataMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(savedPayload).not.toHaveProperty('gps_location_data');
    expect(savedPayload).not.toHaveProperty('gps_detected_country');
    expect(savedPayload).not.toHaveProperty('gps_detected_state');
    expect(savedPayload).not.toHaveProperty('gps_detected_city');
    expect(savedPayload).not.toHaveProperty('gps_detected_postal_code');
    expect(savedPayload).not.toHaveProperty('gps_detected_phone_dial_code');
    expect(savedPayload).not.toHaveProperty('gps_detected_timezone');
  });

  it('refreshes timestamps without flagging a location change when the signature is unchanged', async () => {
    const service = new LocationService();
    const samePlace = {
      ...sanFrancisco,
      latitude: 37.77491,
      longitude: -122.41939,
    };
    const freshRecord = {
      ...cachedRecord,
      data: samePlace,
      lastCheckedAt: '2026-03-30T10:10:00.000Z',
      signature: buildLocationSignature(samePlace),
    } satisfies LocationCacheRecord;

    vi.spyOn(service, 'readSharedLocationCache').mockResolvedValue(cachedRecord);
    vi.spyOn(service, 'detectLocation').mockResolvedValue({
      source: 'detected',
      data: samePlace,
    });
    vi.spyOn(service, 'saveLocationToOnboarding').mockResolvedValue(freshRecord);

    const result = await service.refreshStep4Location('user-123');

    expect(result.changed).toBe(false);
    expect(result.cached?.signature).toBe(cachedRecord.signature);
    expect(result.fresh?.lastCheckedAt).toBe('2026-03-30T10:10:00.000Z');
    expect(service.saveLocationToOnboarding).toHaveBeenCalledWith(
      'user-123',
      samePlace,
      'gps'
    );
  });

  it('marks the refresh as changed when the new location is materially different', async () => {
    const service = new LocationService();
    const losAngeles = {
      ...sanFrancisco,
      city: 'Los Angeles',
      postalCode: '90012',
      latitude: 34.0522,
      longitude: -118.2437,
    };
    const freshRecord = {
      ...cachedRecord,
      data: losAngeles,
      source: 'ip',
      lastCheckedAt: '2026-03-30T11:10:00.000Z',
      signature: buildLocationSignature(losAngeles),
    } satisfies LocationCacheRecord;

    vi.spyOn(service, 'readSharedLocationCache').mockResolvedValue(cachedRecord);
    vi.spyOn(service, 'detectLocation').mockResolvedValue({
      source: 'ip-detected',
      data: losAngeles,
    });
    vi.spyOn(service, 'saveLocationToOnboarding').mockResolvedValue(freshRecord);

    const result = await service.refreshStep4Location('user-123');

    expect(result.changed).toBe(true);
    expect(result.fresh?.source).toBe('ip');
    expect(service.saveLocationToOnboarding).toHaveBeenCalledWith(
      'user-123',
      losAngeles,
      'ip'
    );
  });
});
