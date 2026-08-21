const GOOGLE_GEOCODE_ENDPOINT =
  "https://maps.googleapis.com/maps/api/geocode/json";
const NOMINATIM_REVERSE_ENDPOINT =
  "https://nominatim.openstreetmap.org/reverse";
const FINNHUB_QUOTE_ENDPOINT = "https://finnhub.io/api/v1/quote";

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error("Request aborted.");
}

function requireFetch(fetchImpl) {
  if (typeof fetchImpl !== "function") {
    throw new Error("A fetch implementation is required.");
  }
  return fetchImpl;
}

function assertCoordinates(latitude, longitude) {
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  ) {
    throw new Error("Invalid latitude or longitude");
  }
}

function parseIsoSubdivisionCode(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return "";
  const finalPart = text.includes("-") ? text.split("-").pop() : text;
  return String(finalPart ?? "").toUpperCase();
}

const COUNTRY_DIAL_CODES = Object.freeze({
  US: "+1",
  CA: "+1",
  GB: "+44",
  UK: "+44",
  IN: "+91",
  CN: "+86",
  JP: "+81",
  AU: "+61",
  DE: "+49",
  FR: "+33",
  IT: "+39",
  ES: "+34",
  BR: "+55",
  MX: "+52",
  RU: "+7",
  KR: "+82",
  SA: "+966",
  AE: "+971",
  SG: "+65",
  HK: "+852",
  NZ: "+64",
  ZA: "+27",
  EG: "+20",
  NG: "+234",
  PK: "+92",
  BD: "+880",
  ID: "+62",
  MY: "+60",
  TH: "+66",
  VN: "+84",
  PH: "+63",
  TR: "+90",
  PL: "+48",
  NL: "+31",
  BE: "+32",
  SE: "+46",
  NO: "+47",
  DK: "+45",
  FI: "+358",
  CH: "+41",
  AT: "+43",
  PT: "+351",
  GR: "+30",
  IE: "+353",
  IL: "+972",
  AR: "+54",
  CL: "+56",
  CO: "+57",
  PE: "+51",
  VE: "+58",
});

const COUNTRY_TIMEZONES = Object.freeze({
  US: "America/New_York",
  CA: "America/Toronto",
  GB: "Europe/London",
  UK: "Europe/London",
  IN: "Asia/Kolkata",
  CN: "Asia/Shanghai",
  JP: "Asia/Tokyo",
  AU: "Australia/Sydney",
  DE: "Europe/Berlin",
  FR: "Europe/Paris",
  AE: "Asia/Dubai",
  SG: "Asia/Singapore",
  SA: "Asia/Riyadh",
});

function dialCode(countryCode) {
  return COUNTRY_DIAL_CODES[clean(countryCode).toUpperCase()] ?? "+1";
}

function timezone(countryCode) {
  return COUNTRY_TIMEZONES[clean(countryCode).toUpperCase()] ?? "UTC";
}

function googleLocation(data, latitude, longitude) {
  if (data?.status !== "OK" || !Array.isArray(data.results) || !data.results[0]) {
    throw new Error(
      `Google geocoding failed: ${clean(data?.status) || "Unknown status"}`,
    );
  }
  const result = data.results[0];
  const values = {
    country: "",
    countryCode: "",
    state: "",
    stateCode: "",
    city: "",
    postalCode: "",
  };
  for (const component of result.address_components ?? []) {
    const types = Array.isArray(component?.types) ? component.types : [];
    if (types.includes("country")) {
      values.country = clean(component.long_name);
      values.countryCode = clean(component.short_name);
    } else if (types.includes("administrative_area_level_1")) {
      values.state = clean(component.long_name);
      values.stateCode = clean(component.short_name);
    } else if (types.includes("locality")) {
      values.city = clean(component.long_name);
    } else if (types.includes("sublocality_level_1") && !values.city) {
      values.city = clean(component.long_name);
    } else if (types.includes("postal_code")) {
      values.postalCode = clean(component.long_name);
    }
  }
  return Object.freeze({
    ...values,
    phoneDialCode: dialCode(values.countryCode),
    timezone: timezone(values.countryCode),
    formattedAddress: clean(result.formatted_address),
    latitude,
    longitude,
  });
}

function nominatimLocation(data, latitude, longitude) {
  const address = data?.address ?? {};
  const countryCode = clean(address.country_code).toUpperCase();
  const stateIso =
    address["ISO3166-2-lvl4"] ||
    address["ISO3166-2-lvl6"] ||
    address["ISO3166-2-lvl3"] ||
    address["ISO3166-2-lvl5"] ||
    "";
  const city =
    address.city ||
    address.town ||
    address.village ||
    address.hamlet ||
    address.suburb ||
    address.county ||
    address.state_district ||
    "";
  return Object.freeze({
    country: clean(address.country),
    countryCode,
    state: clean(address.state || address.region),
    stateCode: parseIsoSubdivisionCode(stateIso || address.state_code),
    city: clean(city),
    postalCode: clean(address.postcode),
    phoneDialCode: dialCode(countryCode),
    timezone: timezone(countryCode),
    formattedAddress: clean(data?.display_name),
    latitude,
    longitude,
  });
}

export function createGeocodingAdapter({
  fetchImpl = globalThis.fetch,
  googleMapsApiKey = "",
  nominatimUserAgent =
    "hushh-location-geocode/1.0 (https://hushh.ai)",
} = {}) {
  const request = requireFetch(fetchImpl);
  const mapsKey = clean(googleMapsApiKey);
  const userAgent = clean(nominatimUserAgent);
  if (!userAgent || /[\r\n]/.test(userAgent)) {
    throw new Error("A valid Nominatim user agent is required.");
  }

  async function google(latitude, longitude, signal) {
    const url = new URL(GOOGLE_GEOCODE_ENDPOINT);
    url.searchParams.set("latlng", `${latitude},${longitude}`);
    url.searchParams.set("key", mapsKey);
    const response = await request(url, { signal, redirect: "error" });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(`Google geocoding failed: ${response.status}`);
    }
    return googleLocation(data, latitude, longitude);
  }

  async function nominatim(latitude, longitude, signal) {
    const url = new URL(NOMINATIM_REVERSE_ENDPOINT);
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("lat", String(latitude));
    url.searchParams.set("lon", String(longitude));
    url.searchParams.set("addressdetails", "1");
    const response = await request(url, {
      signal,
      redirect: "error",
      headers: {
        Accept: "application/json",
        "Accept-Language": "en",
        "User-Agent": userAgent,
      },
    });
    if (!response.ok) {
      throw new Error(`Nominatim geocoding failed: ${response.status}`);
    }
    return nominatimLocation(await response.json(), latitude, longitude);
  }

  return Object.freeze({
    async reverse({ latitude, longitude, signal }) {
      assertCoordinates(latitude, longitude);
      throwIfAborted(signal);
      if (mapsKey) {
        try {
          return await google(latitude, longitude, signal);
        } catch {
          throwIfAborted(signal);
        }
      }
      try {
        return await nominatim(latitude, longitude, signal);
      } catch (error) {
        throwIfAborted(signal);
        throw error instanceof Error ? error : new Error("Geocoding failed");
      }
    },
  });
}

export function createFinnhubQuoteAdapter({
  fetchImpl = globalThis.fetch,
  apiKey = "",
} = {}) {
  const request = requireFetch(fetchImpl);
  const key = clean(apiKey);
  return Object.freeze({
    configured: Boolean(key),
    async quote(symbol, { signal } = {}) {
      if (!key) throw new Error("Stock API not configured");
      const url = new URL(FINNHUB_QUOTE_ENDPOINT);
      url.searchParams.set("symbol", symbol);
      url.searchParams.set("token", key);
      try {
        const response = await request(url, { signal, redirect: "error" });
        if (!response.ok) return null;
        const data = await response.json();
        if (data?.c === 0 && data?.d === 0) return null;
        return Object.freeze({
          symbol,
          currentPrice: data?.c,
          change: data?.d,
          percentChange: data?.dp,
          high: data?.h,
          low: data?.l,
          open: data?.o,
          previousClose: data?.pc,
          timestamp: data?.t,
        });
      } catch {
        throwIfAborted(signal);
        return null;
      }
    },
  });
}
