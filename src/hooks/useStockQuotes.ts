import { useState, useEffect, useCallback } from 'react';

const STOCK_QUOTES_API_URL = '/api/stock-quotes';

// Exact 27 stocks as specified by user
const STOCK_SYMBOLS = [
  '2222.SR',    // Saudi Aramco
  'GOOG',       // Alphabet
  'AAPL',       // Apple
  'MSFT',       // Microsoft
  'NVDA',       // NVIDIA
  'AMZN',       // Amazon
  // BRK-B, not BRK.B. Yahoo's chart endpoint answers 404 to the dotted form and 200 to the
  // hyphenated one, so the cornerstone holding was the one symbol the strip never showed.
  // hushh-research's registry uses the same hyphenated form (it answers "BRK" with BRK-A).
  'BRK-B',      // Berkshire Hathaway
  'META',       // Meta Platforms
  'JPM',        // JPMorgan Chase
  '1398.HK',    // ICBC
  '601939.SS',  // China Construction Bank
  'XOM',        // Exxon Mobil
  '601288.SS',  // Agricultural Bank of China
  'TSM',        // TSMC
  '601988.SS',  // Bank of China
  'TM',         // Toyota
  '0857.HK',    // PetroChina
  'WMT',        // Walmart
  'TCEHY',      // Tencent
  'BAC',        // Bank of America
  'EQNR',       // Equinor
  'JNJ',        // Johnson & Johnson
  'DTE.DE',     // Deutsche Telekom
  'CMCSA',      // Comcast
  'UNH',        // UnitedHealth Group
  'HSBC',       // HSBC
  'SHEL',       // Shell
];

// Display names for stocks
const STOCK_NAMES: Record<string, string> = {
  '2222.SR': 'Saudi Aramco',
  'GOOG': 'Alphabet',
  'AAPL': 'Apple',
  'MSFT': 'Microsoft',
  'NVDA': 'NVIDIA',
  'AMZN': 'Amazon',
  'BRK-B': 'Berkshire',
  'META': 'Meta',
  'JPM': 'JPMorgan',
  '1398.HK': 'ICBC',
  '601939.SS': 'CCB',
  'XOM': 'Exxon',
  '601288.SS': 'ABC',
  'TSM': 'TSMC',
  '601988.SS': 'BOC',
  'TM': 'Toyota',
  '0857.HK': 'PetroChina',
  'WMT': 'Walmart',
  'TCEHY': 'Tencent',
  'BAC': 'BofA',
  'EQNR': 'Equinor',
  'JNJ': 'J&J',
  'DTE.DE': 'DT Telekom',
  'CMCSA': 'Comcast',
  'UNH': 'UnitedHealth',
  'HSBC': 'HSBC',
  'SHEL': 'Shell',
};

// Short display symbols (for UI)
const STOCK_SHORT_SYMBOLS: Record<string, string> = {
  '2222.SR': 'ARAMCO',
  'GOOG': 'GOOG',
  'AAPL': 'AAPL',
  'MSFT': 'MSFT',
  'NVDA': 'NVDA',
  'AMZN': 'AMZN',
  'BRK-B': 'BRK.B',
  'META': 'META',
  'JPM': 'JPM',
  '1398.HK': 'ICBC',
  '601939.SS': 'CCB',
  'XOM': 'XOM',
  '601288.SS': 'ABC',
  'TSM': 'TSM',
  '601988.SS': 'BOC',
  'TM': 'TM',
  '0857.HK': 'PTRCN',
  'WMT': 'WMT',
  'TCEHY': 'TCEHY',
  'BAC': 'BAC',
  'EQNR': 'EQNR',
  'JNJ': 'JNJ',
  'DTE.DE': 'DTE',
  'CMCSA': 'CMCSA',
  'UNH': 'UNH',
  'HSBC': 'HSBC',
  'SHEL': 'SHEL',
};

// Logo URLs for each stock
const STOCK_LOGOS: Record<string, string> = {
  '2222.SR': 'https://upload.wikimedia.org/wikipedia/en/thumb/9/9c/Saudi_Aramco_logo.svg/1200px-Saudi_Aramco_logo.svg.png',
  'GOOG': 'https://thumbs.dreamstime.com/b/google-logo-vector-format-white-background-illustration-407571048.jpg',
  'AAPL': 'https://fabrikbrands.com/wp-content/uploads/Apple-Logo-History-1-1155x770.png',
  'MSFT': 'https://static.vecteezy.com/system/resources/previews/027/127/473/non_2x/microsoft-logo-microsoft-icon-transparent-free-png.png',
  'NVDA': 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcSVEu8tfOJpA-vMjPqyI2gEyaDjTaI7tSJFzQ&s',
  'AMZN': 'https://static.vecteezy.com/system/resources/previews/014/018/561/non_2x/amazon-logo-on-transparent-background-free-vector.jpg',
  'BRK-B': 'https://www.shutterstock.com/shutterstock/photos/2378735305/display_1500/stock-vector-brk-letter-logo-design-on-a-white-background-or-monogram-logo-design-for-entrepreneur-and-business-2378735305.jpg',
  'META': 'https://img.freepik.com/premium-vector/meta-company-logo_265339-667.jpg',
  'JPM': 'https://e7.pngegg.com/pngimages/225/668/png-clipart-jpmorgan-chase-logo-bank-business-morgan-stanley-bank-text-logo.png',
  '1398.HK': 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/4d/Industrial_and_Commercial_Bank_of_China_logo.svg/2560px-Industrial_and_Commercial_Bank_of_China_logo.svg.png',
  '601939.SS': 'https://upload.wikimedia.org/wikipedia/en/thumb/e/e1/China_Construction_Bank_logo.svg/1200px-China_Construction_Bank_logo.svg.png',
  'XOM': 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/44/ExxonMobil.svg/2560px-ExxonMobil.svg.png',
  '601288.SS': 'https://upload.wikimedia.org/wikipedia/en/thumb/5/5a/Agricultural_Bank_of_China_logo.svg/1200px-Agricultural_Bank_of_China_logo.svg.png',
  'TSM': 'https://upload.wikimedia.org/wikipedia/en/thumb/6/63/Tsmc.svg/1200px-Tsmc.svg.png',
  '601988.SS': 'https://upload.wikimedia.org/wikipedia/en/thumb/d/d5/Bank_of_China_%28logo%29.svg/1200px-Bank_of_China_%28logo%29.svg.png',
  'TM': 'https://global.toyota/pages/global_toyota/mobility/toyota-brand/emblem_001.jpg',
  '0857.HK': 'https://upload.wikimedia.org/wikipedia/en/thumb/f/fc/PetroChina_logo.svg/1200px-PetroChina_logo.svg.png',
  'WMT': 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcRxwPUD4NGc7WTQVqDstT5ZPRQXm6ka0KTsmTsKfiY&usqp=CAE&s',
  'TCEHY': 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/22/Tencent_Logo.svg/2560px-Tencent_Logo.svg.png',
  'BAC': 'https://www.bankofamerica.com/content/images/ContextualSiteGraphics/Logos/en_US/logos/bac-logo-v2.png',
  'EQNR': 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/14/Equinor_Logo.svg/2560px-Equinor_Logo.svg.png',
  'JNJ': 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/48/JohnsonandJohnsonLogo.svg/2560px-JohnsonandJohnsonLogo.svg.png',
  'DTE.DE': 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Deutsche_Telekom-Logo.svg/2560px-Deutsche_Telekom-Logo.svg.png',
  'CMCSA': 'https://upload.wikimedia.org/wikipedia/commons/thumb/f/ff/Comcast_Logo.svg/2560px-Comcast_Logo.svg.png',
  'UNH': 'https://upload.wikimedia.org/wikipedia/commons/thumb/f/f0/UnitedHealth_Group_logo.svg/2560px-UnitedHealth_Group_logo.svg.png',
  'HSBC': 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/aa/HSBC_logo_%282018%29.svg/2560px-HSBC_logo_%282018%29.svg.png',
  'SHEL': 'https://upload.wikimedia.org/wikipedia/en/thumb/e/e8/Shell_logo.svg/1200px-Shell_logo.svg.png',
};

export interface StockQuote {
  symbol: string;
  displaySymbol: string;
  name: string;
  currentPrice: number;
  change: number;
  percentChange: number;
  isUp: boolean;
  logo: string;
  /**
   * Whether this row carries a real quote from the provider. False means the symbol is a
   * placeholder and nothing about its price or movement is known. Anything rendering a number for
   * this row must check it first.
   */
  hasQuote: boolean;
}

interface EdgeFunctionQuote {
  symbol: string;
  currentPrice: number;
  change: number;
  percentChange: number;
  high: number;
  low: number;
  open: number;
  previousClose: number;
  timestamp: number;
}

interface EdgeFunctionResponse {
  success: boolean;
  quotes: EdgeFunctionQuote[];
  fetchedAt: string;
  count: number;
  error?: string;
}

/**
 * The symbols with no market data attached.
 *
 * This used to invent the numbers -- `percentChange: (Math.random() - 0.5) * 4` and
 * `isUp: Math.random() > 0.4` -- as the INITIAL state, and the error path never cleared it. With
 * the quotes endpoint returning 404 the ticker therefore showed randomly generated percentages,
 * under a green dot reading "Markets Live" and a timestamp, on every page load. For a firm that
 * publishes investment research that is not a placeholder, it is fabricated market data.
 *
 * A row with `hasQuote: false` renders as a symbol and nothing else. An empty strip is a visible
 * problem someone fixes; a plausible wrong number is one nobody ever notices.
 */
function placeholderQuotes(): StockQuote[] {
  return STOCK_SYMBOLS.map(symbol => ({
    symbol,
    displaySymbol: STOCK_SHORT_SYMBOLS[symbol] || symbol,
    name: STOCK_NAMES[symbol] || symbol,
    currentPrice: 0,
    change: 0,
    percentChange: 0,
    isUp: false,
    logo: STOCK_LOGOS[symbol] || '',
    hasQuote: false,
  }));
}

// Hook for fetching stock quotes via GcpBackend edge function
export function useStockQuotes(refreshInterval = 120000, enabled = true) {
  /*
   * `requestEnabled` is `enabled`, and origin/main's ` && !isUatWebsite()` is deliberately gone.
   *
   * That guard was added by f779d42e because "UAT's stock gateway ... is not enabled" -- at the
   * time `/api/stock-quotes` answered 404 FEATURE_DISABLED there, so every request was waste and
   * every rendered row was `generateFallbackData()`'s invented number. Both halves of that premise
   * are now false: the gateway is enabled on the UAT service and returns live prices, and the
   * fabricated fallback it was protecting readers from no longer exists -- `placeholderQuotes()`
   * invents nothing and `hasQuote` marks which rows are real.
   *
   * The protection is kept, by a stronger rule: the ticker hides itself whenever no row carries a
   * real quote, on any host. The host check could only ever protect one of them.
   *
   * isUatWebsite still guards the analytics collector and the deck covers, which remain off there.
   */
  const requestEnabled = enabled;
  const [quotes, setQuotes] = useState<StockQuote[]>(placeholderQuotes());
  const [loading, setLoading] = useState(requestEnabled);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const fetchAllQuotes = useCallback(async () => {
    if (!requestEnabled) {
      setError(null);
      setLoading(false);
      return;
    }

    try {
      setError(null);

      // Call the same-origin GCP gateway. Provider credentials stay server-side.
      const response = await fetch(STOCK_QUOTES_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'same-origin',
        body: JSON.stringify({ symbols: STOCK_SYMBOLS }),
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch quotes: ${response.status}`);
      }

      const data: EdgeFunctionResponse = await response.json();

      if (data.success && data.quotes.length > 0) {
        // Map edge function response to our StockQuote format
        const mappedQuotes: StockQuote[] = data.quotes.map(q => ({
          symbol: q.symbol,
          displaySymbol: STOCK_SHORT_SYMBOLS[q.symbol] || q.symbol,
          name: STOCK_NAMES[q.symbol] || q.symbol,
          currentPrice: q.currentPrice,
          change: q.change || 0,
          percentChange: q.percentChange || 0,
          isUp: (q.percentChange || 0) >= 0,
          logo: STOCK_LOGOS[q.symbol] || '',
          hasQuote: true,
        }));
        
        setQuotes(mappedQuotes);
        setLastUpdated(new Date());
      }
      setLoading(false);
    } catch (err) {
      console.error('Error fetching stock quotes:', err);
      setError('Failed to fetch stock quotes');
      // Drop back to symbols without numbers rather than leaving the last successful values on
      // screen under a "live" label. A stale quote presented as current is the same defect as an
      // invented one, just slower.
      setQuotes(placeholderQuotes());
      setLastUpdated(null);
      setLoading(false);
    }
  }, [requestEnabled]);

  // Initial fetch
  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (active) {
        void fetchAllQuotes();
      }
    });
    return () => {
      active = false;
    };
  }, [fetchAllQuotes]);

  // Auto-refresh at specified interval (default 2 minutes for 27 stocks)
  useEffect(() => {
    if (requestEnabled && refreshInterval > 0) {
      const interval = setInterval(fetchAllQuotes, refreshInterval);
      return () => clearInterval(interval);
    }
  }, [requestEnabled, refreshInterval, fetchAllQuotes]);

  return {
    quotes,
    loading,
    error,
    lastUpdated,
    refetch: fetchAllQuotes,
  };
}

// Export stock data for use elsewhere
export { STOCK_SYMBOLS, STOCK_LOGOS, STOCK_NAMES, STOCK_SHORT_SYMBOLS };
