/**
 * Unit & Integration Tests for locationData.ts
 *
 * Tests the server-side location data service that replaced
 * the client-side `country-state-city` library (which caused
 * iOS Safari RangeError: Maximum call stack size exceeded).
 *
 * Architecture under test:
 * - getAllCountries() → static array (no network)
 * - getStatesOfCountry() → same-origin GCP function → fallback to countriesnow.space
 * - getCitiesOfState() → same-origin GCP function → fallback to countriesnow.space
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const invokeFunctionMock = vi.hoisted(() => vi.fn(async (name: string, options: any = {}) => {
  const query = options.query || {};
  const params = new URLSearchParams();
  for (const key of ['type', 'country', 'state']) {
    if (query[key] !== undefined) params.set(key, String(query[key]));
  }
  const response = await globalThis.fetch(
    `/api/gcp/functions/v1/${name}?${params.toString()}`,
    {
      credentials: 'same-origin',
      headers: { Authorization: 'Bearer firebase-id-token' },
    },
  );
  const payload = await response.json();
  return response.ok
    ? { data: payload, error: null, status: response.status || 200 }
    : { data: null, error: { message: payload?.error || 'Function failed' }, status: response.status || 500 };
}));

// We mock the config module before importing locationData
vi.mock('../src/resources/config/config', () => ({
  default: {
    GCP_API_BASE_URL: '/api/gcp',
    gcpBackendClient: { functions: { invoke: invokeFunctionMock } },
  },
}));

import {
  getAllCountries,
  getCountryName,
  getStatesOfCountry,
  getCitiesOfState,
} from '../src/data/locationData';

// ─── Unit Tests ───────────────────────────────────────────────────────

describe('locationData - Unit Tests', () => {
  // Save original fetch
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  // ── getAllCountries ──────────────────────────────────────────────

  describe('getAllCountries()', () => {
    it('should return a non-empty array of countries', () => {
      const countries = getAllCountries();
      expect(countries).toBeDefined();
      expect(Array.isArray(countries)).toBe(true);
      expect(countries.length).toBeGreaterThan(100);
    });

    it('should include major countries', () => {
      const countries = getAllCountries();
      const isoCodes = countries.map(c => c.isoCode);

      expect(isoCodes).toContain('US');
      expect(isoCodes).toContain('IN');
      expect(isoCodes).toContain('GB');
      expect(isoCodes).toContain('CA');
      expect(isoCodes).toContain('AU');
      expect(isoCodes).toContain('DE');
      expect(isoCodes).toContain('JP');
      expect(isoCodes).toContain('BR');
    });

    it('each country should have isoCode and name', () => {
      const countries = getAllCountries();
      countries.forEach(c => {
        expect(c.isoCode).toBeDefined();
        expect(c.name).toBeDefined();
        expect(typeof c.isoCode).toBe('string');
        expect(typeof c.name).toBe('string');
        expect(c.isoCode.length).toBe(2);
        expect(c.name.length).toBeGreaterThan(0);
      });
    });

    it('should return instantly (no async, no network call)', () => {
      // This is synchronous — should complete in < 1ms
      const start = performance.now();
      const countries = getAllCountries();
      const elapsed = performance.now() - start;

      expect(countries.length).toBeGreaterThan(0);
      expect(elapsed).toBeLessThan(50); // generous threshold
    });

    it('should return the same reference each time (static)', () => {
      const a = getAllCountries();
      const b = getAllCountries();
      expect(a).toBe(b); // same array reference
    });
  });

  // ── getCountryName ──────────────────────────────────────────────

  describe('getCountryName()', () => {
    it('should return country name for valid ISO code', () => {
      expect(getCountryName('US')).toBe('United States');
      expect(getCountryName('IN')).toBe('India');
      expect(getCountryName('GB')).toBe('United Kingdom');
    });

    it('should return the ISO code itself for unknown codes', () => {
      expect(getCountryName('XX')).toBe('XX');
      expect(getCountryName('ZZ')).toBe('ZZ');
    });
  });

  // ── getStatesOfCountry ──────────────────────────────────────────

  describe('getStatesOfCountry()', () => {
    it('should return empty array for empty country code', async () => {
      const states = await getStatesOfCountry('');
      expect(states).toEqual([]);
    });

    it('should call the same-origin GCP function without provider credentials', async () => {
      const mockStates = [
        { isoCode: 'CA', name: 'California' },
        { isoCode: 'NY', name: 'New York' },
      ];

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: mockStates }),
      });

      const states = await getStatesOfCountry('US');

      expect(global.fetch).toHaveBeenCalledTimes(1);
      const [url, options] = (global.fetch as any).mock.calls[0];
      expect(url).toBe('/api/gcp/functions/v1/get-locations?type=states&country=US');
      expect(options).toEqual({
        credentials: 'same-origin',
        headers: { Authorization: 'Bearer firebase-id-token' },
      });
      expect(options.headers).not.toHaveProperty('apikey');
      expect(states).toEqual(mockStates);
    });

    it('should return states from edge function on success', async () => {
      const mockStates = [
        { isoCode: 'MH', name: 'Maharashtra' },
        { isoCode: 'DL', name: 'Delhi' },
        { isoCode: 'KA', name: 'Karnataka' },
      ];

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: mockStates }),
      });

      const states = await getStatesOfCountry('IN');
      expect(states).toHaveLength(3);
      expect(states[0].isoCode).toBe('MH');
      expect(states[0].name).toBe('Maharashtra');
    });

    it('should fallback to countriesnow.space when edge function fails', async () => {
      // First call: edge function fails
      // Second call: countriesnow.space succeeds
      global.fetch = vi.fn()
        .mockRejectedValueOnce(new Error('Edge function unavailable'))
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            error: false,
            data: {
              states: [
                { name: 'California', state_code: 'CA' },
                { name: 'Texas', state_code: 'TX' },
              ],
            },
          }),
        });

      const states = await getStatesOfCountry('US');

      expect(global.fetch).toHaveBeenCalledTimes(2);
      // Second call should be to countriesnow.space
      const [fallbackUrl] = (global.fetch as any).mock.calls[1];
      expect(fallbackUrl).toBe('https://countriesnow.space/api/v0.1/countries/states');
      expect(states).toHaveLength(2);
      expect(states[0]).toEqual({ isoCode: 'CA', name: 'California' });
    });

    it('should fallback when edge function returns non-ok response', async () => {
      global.fetch = vi.fn()
        .mockResolvedValueOnce({
          ok: false,
          json: () => Promise.resolve({ error: 'Server error' }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            error: false,
            data: {
              states: [{ name: 'Ontario', state_code: 'ON' }],
            },
          }),
        });

      const states = await getStatesOfCountry('CA');
      expect(states).toHaveLength(1);
      expect(states[0].name).toBe('Ontario');
    });

    it('should return empty array when both sources fail', async () => {
      global.fetch = vi.fn()
        .mockRejectedValueOnce(new Error('Edge function down'))
        .mockRejectedValueOnce(new Error('Fallback API down'));

      const states = await getStatesOfCountry('US');
      expect(states).toEqual([]);
    });

    it('should handle edge function returning empty data array', async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: [] }),
      });

      const states = await getStatesOfCountry('MC');
      expect(states).toEqual([]);
    });

    it('should handle edge function returning non-array data', async () => {
      // Edge function returns ok but data is not an array → fallback
      global.fetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ data: null }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            error: false,
            data: { states: [{ name: 'Berlin', state_code: 'BE' }] },
          }),
        });

      const states = await getStatesOfCountry('DE');
      expect(states).toHaveLength(1);
    });
  });

  // ── getCitiesOfState ────────────────────────────────────────────

  describe('getCitiesOfState()', () => {
    it('should return empty array for empty country code', async () => {
      const cities = await getCitiesOfState('', 'CA');
      expect(cities).toEqual([]);
    });

    it('should return empty array for empty state code', async () => {
      const cities = await getCitiesOfState('US', '');
      expect(cities).toEqual([]);
    });

    it('should call the same-origin GCP function with correct params', async () => {
      const mockCities = [
        { name: 'San Francisco' },
        { name: 'Los Angeles' },
      ];

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: mockCities }),
      });

      const cities = await getCitiesOfState('US', 'CA');

      expect(global.fetch).toHaveBeenCalledTimes(1);
      const [url] = (global.fetch as any).mock.calls[0];
      expect(url).toBe('/api/gcp/functions/v1/get-locations?type=cities&country=US&state=CA');
      expect(cities).toEqual(mockCities);
    });

    it('should return cities from edge function on success', async () => {
      const mockCities = [
        { name: 'Mumbai' },
        { name: 'Pune' },
        { name: 'Nagpur' },
      ];

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: mockCities }),
      });

      const cities = await getCitiesOfState('IN', 'MH');
      expect(cities).toHaveLength(3);
      expect(cities[0].name).toBe('Mumbai');
    });

    it('should fallback to countriesnow.space when edge function fails', async () => {
      // Flow: 1. edge cities fails → 2. getStatesOfCountry (edge states) → 3. fallback cities
      global.fetch = vi.fn()
        .mockRejectedValueOnce(new Error('Edge function down'))           // 1. edge cities
        .mockResolvedValueOnce({                                          // 2. edge states (for name lookup)
          ok: true,
          json: () => Promise.resolve({
            data: [{ isoCode: 'CA', name: 'California' }],
          }),
        })
        .mockResolvedValueOnce({                                          // 3. fallback cities
          ok: true,
          json: () => Promise.resolve({
            error: false,
            data: ['San Francisco', 'Los Angeles', 'San Diego'],
          }),
        });

      const cities = await getCitiesOfState('US', 'CA');

      expect(global.fetch).toHaveBeenCalledTimes(3);
      const [fallbackUrl] = (global.fetch as any).mock.calls[2];
      expect(fallbackUrl).toBe('https://countriesnow.space/api/v0.1/countries/state/cities');
      expect(cities).toHaveLength(3);
      expect(cities[0]).toEqual({ name: 'San Francisco' });
    });

    it('should return empty array when both sources fail', async () => {
      global.fetch = vi.fn()
        .mockRejectedValueOnce(new Error('Edge function down'))
        .mockRejectedValueOnce(new Error('Fallback down'));

      const cities = await getCitiesOfState('US', 'CA');
      expect(cities).toEqual([]);
    });

    it('should filter out empty city names from fallback', async () => {
      // Flow: 1. edge cities fails → 2. getStatesOfCountry (edge states) → 3. fallback cities
      global.fetch = vi.fn()
        .mockRejectedValueOnce(new Error('Edge down'))                   // 1. edge cities
        .mockResolvedValueOnce({                                         // 2. edge states (for name lookup)
          ok: true,
          json: () => Promise.resolve({
            data: [{ isoCode: 'MH', name: 'Maharashtra' }],
          }),
        })
        .mockResolvedValueOnce({                                         // 3. fallback cities
          ok: true,
          json: () => Promise.resolve({
            error: false,
            data: ['Mumbai', '', '  ', 'Pune', null],
          }),
        });

      const cities = await getCitiesOfState('IN', 'MH');
      // null and empty strings should be filtered
      expect(cities.length).toBeLessThanOrEqual(2);
      expect(cities.every(c => c.name.trim().length > 0)).toBe(true);
    });

    it('should handle edge function returning empty data array', async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: [] }),
      });

      const cities = await getCitiesOfState('MC', 'MC');
      expect(cities).toEqual([]);
    });
  });
});

// ─── Integration Tests ────────────────────────────────────────────────

describe('locationData - Integration Tests', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('Full flow: Country → States → Cities', () => {
    it('should complete US → California → San Francisco flow', async () => {
      // Step 1: Get countries (synchronous)
      const countries = getAllCountries();
      const us = countries.find(c => c.isoCode === 'US');
      expect(us).toBeDefined();
      expect(us!.name).toBe('United States');

      // Step 2: Get states for US (async via edge function)
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          data: [
            { isoCode: 'CA', name: 'California' },
            { isoCode: 'NY', name: 'New York' },
            { isoCode: 'TX', name: 'Texas' },
          ],
        }),
      });

      const states = await getStatesOfCountry('US');
      expect(states.length).toBeGreaterThan(0);
      const california = states.find(s => s.isoCode === 'CA');
      expect(california).toBeDefined();

      // Step 3: Get cities for California (async via edge function)
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          data: [
            { name: 'San Francisco' },
            { name: 'Los Angeles' },
            { name: 'San Diego' },
          ],
        }),
      });

      const cities = await getCitiesOfState('US', 'CA');
      expect(cities.length).toBeGreaterThan(0);
      const sf = cities.find(c => c.name === 'San Francisco');
      expect(sf).toBeDefined();
    });

    it('should complete IN → Maharashtra → Mumbai flow', async () => {
      const countries = getAllCountries();
      const india = countries.find(c => c.isoCode === 'IN');
      expect(india).toBeDefined();
      expect(india!.name).toBe('India');

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          data: [
            { isoCode: 'MH', name: 'Maharashtra' },
            { isoCode: 'DL', name: 'Delhi' },
          ],
        }),
      });

      const states = await getStatesOfCountry('IN');
      const mh = states.find(s => s.isoCode === 'MH');
      expect(mh).toBeDefined();

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          data: [
            { name: 'Mumbai' },
            { name: 'Pune' },
          ],
        }),
      });

      const cities = await getCitiesOfState('IN', 'MH');
      const mumbai = cities.find(c => c.name === 'Mumbai');
      expect(mumbai).toBeDefined();
    });
  });

  describe('Fallback resilience', () => {
    it('should still return data when edge function is completely down', async () => {
      // All edge function calls fail, but fallback works
      global.fetch = vi.fn()
        // getStatesOfCountry: edge fails
        .mockRejectedValueOnce(new Error('503 Service Unavailable'))
        // getStatesOfCountry: fallback succeeds
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            error: false,
            data: {
              states: [
                { name: 'California', state_code: 'CA' },
                { name: 'New York', state_code: 'NY' },
              ],
            },
          }),
        });

      const states = await getStatesOfCountry('US');
      expect(states.length).toBeGreaterThan(0);
      expect(states[0].name).toBe('California');
    });
  });

  describe('Non-blocking behavior', () => {
    it('getStatesOfCountry should be async and not block', async () => {
      global.fetch = vi.fn().mockImplementation(
        () => new Promise(resolve =>
          setTimeout(() => resolve({
            ok: true,
            json: () => Promise.resolve({ data: [{ isoCode: 'CA', name: 'California' }] }),
          }), 100)
        )
      );

      // Start the async call
      const promise = getStatesOfCountry('US');

      // This should not be blocked
      const countries = getAllCountries();
      expect(countries.length).toBeGreaterThan(0);

      // Now await the result
      const states = await promise;
      expect(states).toHaveLength(1);
    });

    it('getCitiesOfState should be async and not block', async () => {
      global.fetch = vi.fn().mockImplementation(
        () => new Promise(resolve =>
          setTimeout(() => resolve({
            ok: true,
            json: () => Promise.resolve({ data: [{ name: 'Mumbai' }] }),
          }), 100)
        )
      );

      const promise = getCitiesOfState('IN', 'MH');
      const countries = getAllCountries();
      expect(countries.length).toBeGreaterThan(0);

      const cities = await promise;
      expect(cities).toHaveLength(1);
    });
  });
});
