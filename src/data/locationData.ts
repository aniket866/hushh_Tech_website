/**
 * Location data service for country/state/city selection.
 *
 * Architecture:
 * - Countries: static list (no server call needed, instant)
 * - States & Cities: fetched from GcpBackend Edge Function `get-locations`
 *   which runs `country-state-city` server-side (safe from iOS stack overflow)
 * - All fetches are async → non-blocking, never on main thread
 * - Fallback to countriesnow.space API if edge function fails
 */

import config from '../resources/config/config';

// ─── Types ────────────────────────────────────────────────────────────

export interface CountryItem {
  isoCode: string;
  name: string;
}

export interface StateItem {
  isoCode: string;
  name: string;
}

export interface CityItem {
  name: string;
}

// ─── Static Countries List ────────────────────────────────────────────
// Lightweight: just ISO codes + names. No recursive data processing.
const COUNTRIES: CountryItem[] = [
  { isoCode: 'AF', name: 'Afghanistan' },
  { isoCode: 'AL', name: 'Albania' },
  { isoCode: 'DZ', name: 'Algeria' },
  { isoCode: 'AD', name: 'Andorra' },
  { isoCode: 'AO', name: 'Angola' },
  { isoCode: 'AG', name: 'Antigua and Barbuda' },
  { isoCode: 'AR', name: 'Argentina' },
  { isoCode: 'AM', name: 'Armenia' },
  { isoCode: 'AU', name: 'Australia' },
  { isoCode: 'AT', name: 'Austria' },
  { isoCode: 'AZ', name: 'Azerbaijan' },
  { isoCode: 'BS', name: 'Bahamas' },
  { isoCode: 'BH', name: 'Bahrain' },
  { isoCode: 'BD', name: 'Bangladesh' },
  { isoCode: 'BB', name: 'Barbados' },
  { isoCode: 'BY', name: 'Belarus' },
  { isoCode: 'BE', name: 'Belgium' },
  { isoCode: 'BZ', name: 'Belize' },
  { isoCode: 'BJ', name: 'Benin' },
  { isoCode: 'BT', name: 'Bhutan' },
  { isoCode: 'BO', name: 'Bolivia' },
  { isoCode: 'BA', name: 'Bosnia and Herzegovina' },
  { isoCode: 'BW', name: 'Botswana' },
  { isoCode: 'BR', name: 'Brazil' },
  { isoCode: 'BN', name: 'Brunei' },
  { isoCode: 'BG', name: 'Bulgaria' },
  { isoCode: 'BF', name: 'Burkina Faso' },
  { isoCode: 'BI', name: 'Burundi' },
  { isoCode: 'CV', name: 'Cabo Verde' },
  { isoCode: 'KH', name: 'Cambodia' },
  { isoCode: 'CM', name: 'Cameroon' },
  { isoCode: 'CA', name: 'Canada' },
  { isoCode: 'CF', name: 'Central African Republic' },
  { isoCode: 'TD', name: 'Chad' },
  { isoCode: 'CL', name: 'Chile' },
  { isoCode: 'CN', name: 'China' },
  { isoCode: 'CO', name: 'Colombia' },
  { isoCode: 'KM', name: 'Comoros' },
  { isoCode: 'CG', name: 'Congo' },
  { isoCode: 'CD', name: 'Congo (DRC)' },
  { isoCode: 'CR', name: 'Costa Rica' },
  { isoCode: 'CI', name: "Côte d'Ivoire" },
  { isoCode: 'HR', name: 'Croatia' },
  { isoCode: 'CU', name: 'Cuba' },
  { isoCode: 'CY', name: 'Cyprus' },
  { isoCode: 'CZ', name: 'Czech Republic' },
  { isoCode: 'DK', name: 'Denmark' },
  { isoCode: 'DJ', name: 'Djibouti' },
  { isoCode: 'DM', name: 'Dominica' },
  { isoCode: 'DO', name: 'Dominican Republic' },
  { isoCode: 'EC', name: 'Ecuador' },
  { isoCode: 'EG', name: 'Egypt' },
  { isoCode: 'SV', name: 'El Salvador' },
  { isoCode: 'GQ', name: 'Equatorial Guinea' },
  { isoCode: 'ER', name: 'Eritrea' },
  { isoCode: 'EE', name: 'Estonia' },
  { isoCode: 'SZ', name: 'Eswatini' },
  { isoCode: 'ET', name: 'Ethiopia' },
  { isoCode: 'FJ', name: 'Fiji' },
  { isoCode: 'FI', name: 'Finland' },
  { isoCode: 'FR', name: 'France' },
  { isoCode: 'GA', name: 'Gabon' },
  { isoCode: 'GM', name: 'Gambia' },
  { isoCode: 'GE', name: 'Georgia' },
  { isoCode: 'DE', name: 'Germany' },
  { isoCode: 'GH', name: 'Ghana' },
  { isoCode: 'GR', name: 'Greece' },
  { isoCode: 'GD', name: 'Grenada' },
  { isoCode: 'GT', name: 'Guatemala' },
  { isoCode: 'GN', name: 'Guinea' },
  { isoCode: 'GW', name: 'Guinea-Bissau' },
  { isoCode: 'GY', name: 'Guyana' },
  { isoCode: 'HT', name: 'Haiti' },
  { isoCode: 'HN', name: 'Honduras' },
  { isoCode: 'HK', name: 'Hong Kong' },
  { isoCode: 'HU', name: 'Hungary' },
  { isoCode: 'IS', name: 'Iceland' },
  { isoCode: 'IN', name: 'India' },
  { isoCode: 'ID', name: 'Indonesia' },
  { isoCode: 'IR', name: 'Iran' },
  { isoCode: 'IQ', name: 'Iraq' },
  { isoCode: 'IE', name: 'Ireland' },
  { isoCode: 'IL', name: 'Israel' },
  { isoCode: 'IT', name: 'Italy' },
  { isoCode: 'JM', name: 'Jamaica' },
  { isoCode: 'JP', name: 'Japan' },
  { isoCode: 'JO', name: 'Jordan' },
  { isoCode: 'KZ', name: 'Kazakhstan' },
  { isoCode: 'KE', name: 'Kenya' },
  { isoCode: 'KI', name: 'Kiribati' },
  { isoCode: 'KP', name: 'North Korea' },
  { isoCode: 'KR', name: 'South Korea' },
  { isoCode: 'KW', name: 'Kuwait' },
  { isoCode: 'KG', name: 'Kyrgyzstan' },
  { isoCode: 'LA', name: 'Laos' },
  { isoCode: 'LV', name: 'Latvia' },
  { isoCode: 'LB', name: 'Lebanon' },
  { isoCode: 'LS', name: 'Lesotho' },
  { isoCode: 'LR', name: 'Liberia' },
  { isoCode: 'LY', name: 'Libya' },
  { isoCode: 'LI', name: 'Liechtenstein' },
  { isoCode: 'LT', name: 'Lithuania' },
  { isoCode: 'LU', name: 'Luxembourg' },
  { isoCode: 'MO', name: 'Macau' },
  { isoCode: 'MG', name: 'Madagascar' },
  { isoCode: 'MW', name: 'Malawi' },
  { isoCode: 'MY', name: 'Malaysia' },
  { isoCode: 'MV', name: 'Maldives' },
  { isoCode: 'ML', name: 'Mali' },
  { isoCode: 'MT', name: 'Malta' },
  { isoCode: 'MH', name: 'Marshall Islands' },
  { isoCode: 'MR', name: 'Mauritania' },
  { isoCode: 'MU', name: 'Mauritius' },
  { isoCode: 'MX', name: 'Mexico' },
  { isoCode: 'FM', name: 'Micronesia' },
  { isoCode: 'MD', name: 'Moldova' },
  { isoCode: 'MC', name: 'Monaco' },
  { isoCode: 'MN', name: 'Mongolia' },
  { isoCode: 'ME', name: 'Montenegro' },
  { isoCode: 'MA', name: 'Morocco' },
  { isoCode: 'MZ', name: 'Mozambique' },
  { isoCode: 'MM', name: 'Myanmar' },
  { isoCode: 'NA', name: 'Namibia' },
  { isoCode: 'NR', name: 'Nauru' },
  { isoCode: 'NP', name: 'Nepal' },
  { isoCode: 'NL', name: 'Netherlands' },
  { isoCode: 'NZ', name: 'New Zealand' },
  { isoCode: 'NI', name: 'Nicaragua' },
  { isoCode: 'NE', name: 'Niger' },
  { isoCode: 'NG', name: 'Nigeria' },
  { isoCode: 'MK', name: 'North Macedonia' },
  { isoCode: 'NO', name: 'Norway' },
  { isoCode: 'OM', name: 'Oman' },
  { isoCode: 'PK', name: 'Pakistan' },
  { isoCode: 'PW', name: 'Palau' },
  { isoCode: 'PS', name: 'Palestine' },
  { isoCode: 'PA', name: 'Panama' },
  { isoCode: 'PG', name: 'Papua New Guinea' },
  { isoCode: 'PY', name: 'Paraguay' },
  { isoCode: 'PE', name: 'Peru' },
  { isoCode: 'PH', name: 'Philippines' },
  { isoCode: 'PL', name: 'Poland' },
  { isoCode: 'PT', name: 'Portugal' },
  { isoCode: 'QA', name: 'Qatar' },
  { isoCode: 'RO', name: 'Romania' },
  { isoCode: 'RU', name: 'Russia' },
  { isoCode: 'RW', name: 'Rwanda' },
  { isoCode: 'KN', name: 'Saint Kitts and Nevis' },
  { isoCode: 'LC', name: 'Saint Lucia' },
  { isoCode: 'VC', name: 'Saint Vincent and the Grenadines' },
  { isoCode: 'WS', name: 'Samoa' },
  { isoCode: 'SM', name: 'San Marino' },
  { isoCode: 'ST', name: 'São Tomé and Príncipe' },
  { isoCode: 'SA', name: 'Saudi Arabia' },
  { isoCode: 'SN', name: 'Senegal' },
  { isoCode: 'RS', name: 'Serbia' },
  { isoCode: 'SC', name: 'Seychelles' },
  { isoCode: 'SL', name: 'Sierra Leone' },
  { isoCode: 'SG', name: 'Singapore' },
  { isoCode: 'SK', name: 'Slovakia' },
  { isoCode: 'SI', name: 'Slovenia' },
  { isoCode: 'SB', name: 'Solomon Islands' },
  { isoCode: 'SO', name: 'Somalia' },
  { isoCode: 'ZA', name: 'South Africa' },
  { isoCode: 'SS', name: 'South Sudan' },
  { isoCode: 'ES', name: 'Spain' },
  { isoCode: 'LK', name: 'Sri Lanka' },
  { isoCode: 'SD', name: 'Sudan' },
  { isoCode: 'SR', name: 'Suriname' },
  { isoCode: 'SE', name: 'Sweden' },
  { isoCode: 'CH', name: 'Switzerland' },
  { isoCode: 'SY', name: 'Syria' },
  { isoCode: 'TW', name: 'Taiwan' },
  { isoCode: 'TJ', name: 'Tajikistan' },
  { isoCode: 'TZ', name: 'Tanzania' },
  { isoCode: 'TH', name: 'Thailand' },
  { isoCode: 'TL', name: 'Timor-Leste' },
  { isoCode: 'TG', name: 'Togo' },
  { isoCode: 'TO', name: 'Tonga' },
  { isoCode: 'TT', name: 'Trinidad and Tobago' },
  { isoCode: 'TN', name: 'Tunisia' },
  { isoCode: 'TR', name: 'Turkey' },
  { isoCode: 'TM', name: 'Turkmenistan' },
  { isoCode: 'TV', name: 'Tuvalu' },
  { isoCode: 'UG', name: 'Uganda' },
  { isoCode: 'UA', name: 'Ukraine' },
  { isoCode: 'AE', name: 'United Arab Emirates' },
  { isoCode: 'GB', name: 'United Kingdom' },
  { isoCode: 'US', name: 'United States' },
  { isoCode: 'UY', name: 'Uruguay' },
  { isoCode: 'UZ', name: 'Uzbekistan' },
  { isoCode: 'VU', name: 'Vanuatu' },
  { isoCode: 'VA', name: 'Vatican City' },
  { isoCode: 'VE', name: 'Venezuela' },
  { isoCode: 'VN', name: 'Vietnam' },
  { isoCode: 'YE', name: 'Yemen' },
  { isoCode: 'ZM', name: 'Zambia' },
  { isoCode: 'ZW', name: 'Zimbabwe' },
];

// ─── Helpers ──────────────────────────────────────────────────────────

const COUNTRY_NAME_MAP: Record<string, string> = {};
COUNTRIES.forEach(c => { COUNTRY_NAME_MAP[c.isoCode] = c.name; });

/** Build the edge function URL from GcpBackend config. */
const getEdgeFunctionUrl = (): string => {
  const base = config.GCP_API_BASE_URL;
  return `${base}/functions/v1/get-locations`;
};

// ─── Public API ───────────────────────────────────────────────────────

/** Get all countries (static, instant, no network call). */
export const getAllCountries = (): CountryItem[] => COUNTRIES;

/** Get country name by ISO code. */
export const getCountryName = (isoCode: string): string =>
  COUNTRY_NAME_MAP[isoCode] || isoCode;

/**
 * Fetch states for a country from the GcpBackend Edge Function.
 * The edge function uses `country-state-city` server-side (safe from iOS issues).
 * Falls back to countriesnow.space API on failure.
 */
export const getStatesOfCountry = async (
  countryIsoCode: string
): Promise<StateItem[]> => {
  if (!countryIsoCode) return [];

  // Primary: GcpBackend Edge Function (uses country-state-city server-side)
  try {
    const url = `${getEdgeFunctionUrl()}?type=states&country=${encodeURIComponent(countryIsoCode)}`;
    const res = await fetch(url, {
      headers: {
        'apikey': config.FIREBASE_API_KEY,
        'Authorization': `Bearer ${config.FIREBASE_API_KEY}`,
      },
    });

    if (res.ok) {
      const json = await res.json();
      if (json.data && Array.isArray(json.data)) {
        return json.data as StateItem[];
      }
    }
  } catch (err) {
    console.warn('[locationData] Edge function failed, trying fallback:', err);
  }

  // Fallback: countriesnow.space API
  return fetchStatesFromFallback(countryIsoCode);
};

/**
 * Fetch cities for a state from the GcpBackend Edge Function.
 * Falls back to countriesnow.space API on failure.
 */
export const getCitiesOfState = async (
  countryIsoCode: string,
  stateCode: string
): Promise<CityItem[]> => {
  if (!countryIsoCode || !stateCode) return [];

  // Primary: GcpBackend Edge Function
  try {
    const url = `${getEdgeFunctionUrl()}?type=cities&country=${encodeURIComponent(countryIsoCode)}&state=${encodeURIComponent(stateCode)}`;
    const res = await fetch(url, {
      headers: {
        'apikey': config.FIREBASE_API_KEY,
        'Authorization': `Bearer ${config.FIREBASE_API_KEY}`,
      },
    });

    if (res.ok) {
      const json = await res.json();
      if (json.data && Array.isArray(json.data)) {
        return json.data as CityItem[];
      }
    }
  } catch (err) {
    console.warn('[locationData] Edge function failed for cities, trying fallback:', err);
  }

  // Fallback: countriesnow.space API needs state NAME, not ISO code.
  // Try to resolve the code to a name first using the states list.
  const statesForLookup = await getStatesOfCountry(countryIsoCode).catch(() => []);
  const stateMatch = statesForLookup.find(
    s => s && (s.isoCode === stateCode || s.name === stateCode)
  );
  const stateName = stateMatch?.name || stateCode;
  return fetchCitiesFromFallback(countryIsoCode, stateName);
};

// ─── Fallback Functions ───────────────────────────────────────────────

const fetchStatesFromFallback = async (
  countryIsoCode: string
): Promise<StateItem[]> => {
  const countryName = getCountryName(countryIsoCode);
  if (!countryName) return [];

  try {
    const res = await fetch(
      'https://countriesnow.space/api/v0.1/countries/states',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ country: countryName }),
      }
    );
    const json = await res.json();

    if (!json.error && json.data?.states) {
      return json.data.states.map((s: { name: string; state_code: string }) => ({
        isoCode: s.state_code || s.name,
        name: s.name,
      }));
    }
    return [];
  } catch (err) {
    console.warn('[locationData] Fallback states fetch failed:', err);
    return [];
  }
};

const fetchCitiesFromFallback = async (
  countryIsoCode: string,
  stateName: string
): Promise<CityItem[]> => {
  const countryName = getCountryName(countryIsoCode);
  if (!countryName || !stateName) return [];

  try {
    const res = await fetch(
      'https://countriesnow.space/api/v0.1/countries/state/cities',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ country: countryName, state: stateName }),
      }
    );
    const json = await res.json();

    if (!json.error && json.data) {
      const cityNames: string[] = Array.isArray(json.data) ? json.data : [];
      return cityNames
        .filter((name: string) => name && name.trim())
        .map((name: string) => ({ name: name.trim() }));
    }
    return [];
  } catch (err) {
    console.warn('[locationData] Fallback cities fetch failed:', err);
    return [];
  }
};
