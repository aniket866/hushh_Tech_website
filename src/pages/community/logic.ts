/**
 * Community List — Logic / ViewModel
 * All state, API calls, filtering, search, NDA workflow.
 * UI stays in ui.tsx — zero rendering here.
 */
import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useToast } from "@chakra-ui/react";
import { getPosts, PostData } from "../../data/posts";
import { formatShortDate, parseDate } from "../../utils/dateFormatter";
// Same module the Cloud Run API uses, so client and server agree on both
// ordering and which edition of a document is current.
import {
  comparePublishedAtDesc,
  selectLatestVersions,
} from "../../../api/community/postVersions.js";
import { useAuthSession } from "../../auth/AuthSessionProvider";
import {
  checkAccessStatus,
  NDA_REQUIRED_STATUS,
} from "../../services/access/accessControlApi";
import {
  trackSearchEvent,
  trackSiteEvent,
} from "../../services/analytics/siteAnalytics";
import {
  fetchCommunityPosts,
  type CommunityPostSummary,
} from "../../services/communityContent";

/* ── Constants ── */
export const NDA_OPTION = "Sensitive Documents (NDA approval Req.)";
export const MARKET_UPDATES_OPTION = "Market Updates";
export const NEWS_OPTION = "News";
export const TECHNICAL_OPTION = "Technical";
export const GENERAL_OPTION = "General";
export const INVESTMENT_OPTION = "Investment";
export const FUND_DOCUMENTS_OPTION = "Fund Documents";
export const FUND_UPDATES_OPTION = "Fund Updates";
export const INVESTOR_RELATIONS_OPTION = "Investor Relations";
export const PRODUCT_OPTION = "Product";
export const PINNED_SLUGS = [
  "general/ai-powered-berkshire-hathaway",
  "general/sell-the-wall-featured",
];

const CATEGORY_VARIANT_ORDER = [
  MARKET_UPDATES_OPTION,
  NEWS_OPTION,
  TECHNICAL_OPTION,
  INVESTMENT_OPTION,
  INVESTOR_RELATIONS_OPTION,
  FUND_UPDATES_OPTION,
  FUND_DOCUMENTS_OPTION,
  PRODUCT_OPTION,
  GENERAL_OPTION,
];

/* ── Types ── */
export interface UnifiedPost {
  id: string;
  title: string;
  date: string;
  slug: string;
  description?: string;
  category?: string;
  /** Version identity; selection lives in api/community/postVersions.js. */
  docFamily?: string;
  docVersion?: number;
  publishedAt?: string;
  /** "deck" | "document" | "article" | "legacy" — what kind of thing a card is describing. */
  sourceKind?: string;
  accessLevel?: string;
  /** Cards in a deck, and minutes to read, both precomputed at snapshot time. */
  cardCount?: number;
  readingMinutes?: number;
}

/* ── Helpers ── */
export const toTitleCase = (s: string) =>
  s.replace(/\w\S*/g, (t) => t[0].toUpperCase() + t.substr(1).toLowerCase());

export const getPostDescription = (post: UnifiedPost): string => {
  if (post.description) return post.description;

  if (
    post.title.toLowerCase().includes("ai") ||
    post.title.toLowerCase().includes("artificial intelligence")
  ) {
    return "Exploring how artificial intelligence is revolutionizing portfolio management and risk assessment in modern financial markets.";
  } else if (post.title.toLowerCase().includes("market")) {
    return "Our latest analysis of market trends and investment opportunities in the current economic climate.";
  } else if (
    post.title.toLowerCase().includes("review") ||
    post.title.toLowerCase().includes("performance")
  ) {
    return "Comprehensive review of performance metrics and strategic adjustments for optimal results.";
  }
  return "Stay informed with our latest market insights, research findings, and company updates.";
};

export const formatDisplayDate = (dateStr: string): string =>
  formatShortDate(dateStr).toUpperCase();

export const getPostUrl = (post: UnifiedPost): string => {
  return `/community/${post.slug}`;
};

/**
 * Content-aware category classifier.
 *
 * Routes a post into exactly one display category using its full content
 * (title + description + tags + slug), NOT just the messy free-text
 * `category` field. Runs on every post in the frontend, so it must work for
 * both local posts and GCP/Firestore posts.
 *
 * Rules are applied in strict priority order (first match wins). The
 * `category` field is only a weak fallback at the very end.
 */
interface ClassifiablePost {
  title?: string;
  description?: string;
  tags?: string[];
  slug?: string;
  category?: string;
}

/* Explicit overrides — checked BEFORE the keyword rules to guarantee the
 * maintainer's known examples land in the right bucket. */
const CATEGORY_OVERRIDES: { test: (haystack: string) => boolean; variant: string }[] = [
  {
    test: (h) =>
      h.includes("connect to openai") ||
      h.includes("openai's large language models") ||
      h.includes("openais large language models"),
    variant: TECHNICAL_OPTION,
  },
  { test: (h) => h.includes("minimalist api design"), variant: TECHNICAL_OPTION },
  { test: (h) => h.includes("the perpetual alpha engine"), variant: TECHNICAL_OPTION },
  { test: (h) => h.includes("alphaagents"), variant: TECHNICAL_OPTION },
  {
    test: (h) =>
      h.includes("minister of foreign trade") || h.includes("thani bin ahmed"),
    variant: NEWS_OPTION,
  },
  { test: (h) => h.includes("wise in the uae"), variant: NEWS_OPTION },
  { test: (h) => h.includes("former openai researcher"), variant: NEWS_OPTION },
  { test: (h) => h.includes("market wrap"), variant: NEWS_OPTION },
];

const buildHaystack = (post: ClassifiablePost): string => {
  const { title = "", description = "", tags = [], slug = "" } = post;
  return `${title} ${description} ${(tags || []).join(" ")} ${slug}`.toLowerCase();
};

const includesAny = (haystack: string, needles: string[]): boolean =>
  needles.some((n) => haystack.includes(n));

export const getCategoryVariant = (post: ClassifiablePost = {}): string => {
  const haystack = buildHaystack(post);
  const slug = (post.slug || "").toLowerCase();
  const title = (post.title || "").toLowerCase();

  if (!haystack.trim()) {
    // Nothing to classify on — fall back to the weak category field.
    return weakCategoryFallback(post.category);
  }

  /* Explicit overrides win over everything. */
  for (const ov of CATEGORY_OVERRIDES) {
    if (ov.test(haystack)) return ov.variant;
  }

  /* 1) Fund Documents */
  const hasCompanyProspectus =
    haystack.includes("hushhtech-prospectus") ||
    haystack.includes("company prospectus");
  if (
    slug.startsWith("fund-documents/") ||
    (haystack.includes("prospectus") && !hasCompanyProspectus) ||
    includesAny(haystack, [
      "private placement",
      "ppm",
      "master lpa",
      "feeder lpa",
      " lpa",
      "memorandum",
      "suitability questionnaire",
      "aml",
      "kyc",
      "limited partnership",
    ])
  ) {
    return FUND_DOCUMENTS_OPTION;
  }

  /* 2) Technical */
  if (
    includesAny(haystack, [
      "openai",
      "large language model",
      " llm",
      "api gateway",
      "api design",
      "minimalist api",
      "architecture",
      "technical blueprint",
      "multi-agent system",
      "system design",
      "developer",
      "integration guide",
      "perpetual alpha engine",
      "alphaagents",
    ])
  ) {
    return TECHNICAL_OPTION;
  }

  /* 3) News */
  if (
    includesAny(haystack, [
      "market wrap",
      "minister",
      "profile of",
      "tariff",
      "former openai",
      "wise in the uae",
      "reportedly",
      " appoints",
      "regulation",
      "trade hub",
      "news:",
    ])
  ) {
    return NEWS_OPTION;
  }

  /* 4) Investor Relations */
  const titleIsFaqForInvestors =
    title.includes("faq") &&
    includesAny(haystack, ["investor", "lp ", "fund partner"]);
  if (
    includesAny(haystack, [
      "investor faq",
      "investor relations",
      "investment perspectives",
      "investor suitability",
      "fund investor faq",
      "lp –",
      "lp -",
      "munger",
    ]) ||
    (haystack.includes("letter to") && haystack.includes("partner")) ||
    titleIsFaqForInvestors
  ) {
    return INVESTOR_RELATIONS_OPTION;
  }

  /* 5) Product */
  if (
    includesAny(haystack, [
      "product update",
      "hushh wallet",
      "new features",
      "hushhpda",
      "hushh-pda",
      "personal data assistant",
      "personal data management",
    ])
  ) {
    return PRODUCT_OPTION;
  }

  /* 6) Fund Updates */
  const fundWithMetric =
    haystack.includes("fund") &&
    includesAny(haystack, ["nav", "overview", "executive summary"]);
  const isDailyMarketUpdate =
    haystack.includes("daily market") || haystack.includes("market update");
  if (
    includesAny(haystack, [
      "nav update",
      "earnings report",
      "fund l.p.",
      "technology fund",
      "renaissance ai first fund",
      "ai-native medallion",
      "fund a hushh",
    ]) ||
    (fundWithMetric && !isDailyMarketUpdate)
  ) {
    return FUND_UPDATES_OPTION;
  }

  /* 7) Market Updates */
  if (
    includesAny(haystack, [
      "daily market",
      "market update",
      "market snapshot",
      "weekly report",
      "weekly market",
      "closing day",
      "performance recap",
      "performance & market",
      "market & fund update",
      "fund and market update",
      "fund update report",
      "market outlook",
    ]) ||
    slug.startsWith("market/") ||
    slug.startsWith("market-updates/") ||
    slug.startsWith("daily-market-update/") ||
    slug.startsWith("updates/")
  ) {
    return MARKET_UPDATES_OPTION;
  }

  /* 8) Investment ("cash-free manifesto" intentionally stays General) */
  if (
    includesAny(haystack, [
      "strategy",
      "framework",
      "thesis",
      "playbook",
      "portfolio",
      "growth plan",
      "sell the wall",
      "medallion",
      "berkshire",
      "monarchy",
      "holy grail",
      "alpha bets",
      "alpha 27",
      "alphabets27",
      "free cash flow",
      "fcf aces",
      "investment",
    ])
  ) {
    return INVESTMENT_OPTION;
  }

  /* 9) General — fallback for everything else. */
  return GENERAL_OPTION;
};

/* Weak fallback used only when there is no content to classify on. */
const weakCategoryFallback = (category = ""): string => {
  const lower = category.trim().toLowerCase();

  if (!lower) return GENERAL_OPTION;
  if (lower.includes("market")) return MARKET_UPDATES_OPTION;
  if (lower.includes("news")) return NEWS_OPTION;
  if (lower.includes("technical")) return TECHNICAL_OPTION;
  if (lower.includes("document")) return FUND_DOCUMENTS_OPTION;
  if (lower.includes("investor")) return INVESTOR_RELATIONS_OPTION;
  if (lower.includes("fund")) return FUND_UPDATES_OPTION;
  if (lower.includes("investment")) return INVESTMENT_OPTION;
  if (lower.includes("product")) return PRODUCT_OPTION;
  if (lower.includes("general")) return GENERAL_OPTION;

  return GENERAL_OPTION;
};

const matchesCategoryVariant = (post: ClassifiablePost, variant: string) => {
  if (variant === MARKET_UPDATES_OPTION) {
    return (
      getCategoryVariant(post) === MARKET_UPDATES_OPTION ||
      (post.slug?.toLowerCase().includes("market") ?? false)
    );
  }

  return getCategoryVariant(post) === variant;
};

/* ── Hook ── */
export const useCommunityListLogic = () => {
  const toast = useToast();
  const navigate = useNavigate();
  const mountRef = useRef(true);
  const lastTrackedSearchRef = useRef("");
  const { session } = useAuthSession();

  /* local posts */
  const localPosts = useMemo<PostData[]>(() => getPosts(), []);

  /* Public GCP-backed community posts */
  const [publicPosts, setPublicPosts] = useState<CommunityPostSummary[]>([]);
  const [ndaPosts, setNdaPosts] = useState<CommunityPostSummary[]>([]);
  const [apiLoading, setApiLoading] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);

  /* UI state */
  const [selectedCategory, setSelectedCategory] = useState("All");
  const [searchQuery, setSearchQuery] = useState("");
  const [ndaApproved, setNdaApproved] = useState(false);
  const [showNdaModal, setShowNdaModal] = useState(false);
  const [showNdaDocModal, setShowNdaDocModal] = useState(false);
  const [ndaMetadata, setNdaMetadata] = useState<any>(null);
  const [ndaLoading, setNdaLoading] = useState(false);

  /* fetch public community posts through the same-origin Cloud Run API */
  useEffect(() => {
    const fetchPosts = async () => {
      setApiLoading(true);
      setApiError(null);
      try {
        setPublicPosts(await fetchCommunityPosts());
      } catch (err: any) {
        console.error(err);
        setPublicPosts([]);
        setApiError(err.message || "Failed to fetch community posts");
      } finally {
        setApiLoading(false);
        mountRef.current = false;
      }
    };
    if (mountRef.current) fetchPosts();
  }, []);

  /* combine + sort all posts */
  const allContentSorted = useMemo<UnifiedPost[]>(() => {
    const mergedBySlug = new Map<string, UnifiedPost>();

    localPosts
      .filter((post) => post.accessLevel === "Public")
      .forEach((post) => {
        mergedBySlug.set(post.slug, {
          id: post.slug,
          title: post.title,
          date: post.publishedAt,
          publishedAt: post.publishedAt,
          slug: post.slug,
          description:
            post.description ||
            getPostDescription({ id: post.slug, title: post.title, date: post.publishedAt }),
          category: post.category,
          docFamily: post.docFamily,
          docVersion: post.docVersion,
          sourceKind: post.sourceKind,
          accessLevel: post.accessLevel,
          cardCount: post.cardCount,
          readingMinutes: post.readingMinutes,
        });
      });

    publicPosts.forEach((p) => {
      mergedBySlug.set(p.slug, {
        id: p.slug,
        title: p.title,
        date: p.publishedAt || p.date,
        publishedAt: p.publishedAt || p.date,
        slug: p.slug,
        description:
          p.description ||
          getPostDescription({ id: p.slug, title: p.title, date: p.publishedAt || p.date }),
        category: p.category,
        docFamily: p.docFamily,
        docVersion: p.docVersion,
        sourceKind: p.sourceKind,
        accessLevel: p.accessLevel,
        cardCount: p.cardCount,
        readingMinutes: p.readingMinutes,
      });
    });

    // The slug Map above only collapses the same slug from two sources. Documents
    // republished under a NEW slug need selectLatestVersions, and sorting through the
    // shared comparator keeps this list in the same order the API returns.
    return selectLatestVersions(Array.from(mergedBySlug.values())).sort(comparePublishedAtDesc);
  }, [localPosts, publicPosts]);

  const categoryVariants = useMemo(() => {
    const variants = new Set(
      allContentSorted.map((p) => getCategoryVariant(p)).filter(Boolean)
    );

    return CATEGORY_VARIANT_ORDER.filter((variant) => variants.has(variant));
  }, [allContentSorted]);

  const dropdownOptions = useMemo(
    () => ["All", ...categoryVariants, NDA_OPTION],
    [categoryVariants]
  );

  /* pinning */
  const pinnedAllContent = useMemo<UnifiedPost[]>(() => {
    const orderMap = new Map(PINNED_SLUGS.map((slug, idx) => [slug, idx]));
    const pinned: UnifiedPost[] = [];
    const rest: UnifiedPost[] = [];

    allContentSorted.forEach((post) => {
      const order = orderMap.get(post.slug || post.id);
      if (order !== undefined) {
        pinned[order] = post;
      } else {
        rest.push(post);
      }
    });
    return [...pinned.filter(Boolean), ...rest];
  }, [allContentSorted]);

  /* filtered content */
  const filteredContent = useMemo(() => {
    let dataToSearch = pinnedAllContent;

    if (selectedCategory === NDA_OPTION) {
      if (!ndaApproved) return [];
      dataToSearch = ndaPosts.map((p) => ({
        id: p.slug,
        title: p.title,
        date: p.publishedAt || p.date,
        slug: p.slug,
        description:
          p.description ||
          getPostDescription({ id: p.slug, title: p.title, date: p.publishedAt || p.date }),
        category: p.category,
      }));
    } else if (selectedCategory !== "All") {
      dataToSearch = pinnedAllContent.filter((p) =>
        matchesCategoryVariant(p, selectedCategory)
      );
    }

    if (!searchQuery.trim()) return dataToSearch;

    const query = searchQuery.toLowerCase();
    return dataToSearch.filter((item) => {
      const titleMatch = item.title.toLowerCase().includes(query);
      const descMatch = (item.description || "").toLowerCase().includes(query);
      const categoryMatch = (item.category || "").toLowerCase().includes(query);
      return titleMatch || descMatch || categoryMatch;
    });
  }, [searchQuery, selectedCategory, pinnedAllContent, ndaPosts, ndaApproved]);

  useEffect(() => {
    const query = searchQuery.trim();
    if (!query) {
      lastTrackedSearchRef.current = "";
      return;
    }

    const trackingKey = `${selectedCategory}:${query.toLowerCase()}`;
    if (lastTrackedSearchRef.current === trackingKey) return;

    const timeoutId = window.setTimeout(() => {
      lastTrackedSearchRef.current = trackingKey;
      void trackSearchEvent(
        "community",
        query,
        filteredContent.length,
        "/community"
      );
    }, 500);

    return () => window.clearTimeout(timeoutId);
  }, [filteredContent.length, searchQuery, selectedCategory]);

  /* NDA check */
  const loadNdaPosts = useCallback(async (accessToken: string) => {
    setApiLoading(true);
    setApiError(null);
    try {
      const posts = await fetchCommunityPosts({
        accessLevel: "NDA",
        accessToken,
      });
      setNdaPosts(posts);
      return true;
    } catch (err: any) {
      console.error(err);
      setNdaPosts([]);
      setApiError(err.message || "Failed to fetch sensitive documents");
      toast({
        title: "Sensitive documents unavailable",
        description: err.message || "Failed to fetch sensitive documents",
        status: "error",
      });
      return false;
    } finally {
      setApiLoading(false);
    }
  }, [toast]);

  const checkNda = useCallback(async () => {
    if (!session) {
      toast({ title: "Please sign in to view the files", status: "error" });
      return false;
    }
    setNdaLoading(true);
    try {
      const status = await checkAccessStatus(session.access_token);
      if (status === "Approved") {
        setNdaApproved(true);
        return loadNdaPosts(session.access_token);
      }
      toast({
        title: "NDA required",
        description:
          status === NDA_REQUIRED_STATUS
            ? "Please sign the NDA to view sensitive documents."
            : status,
        status: "warning",
      });
      navigate("/sign-nda");
      return false;
    } catch (e: any) {
      toast({ title: e.message || "NDA check failed", status: "error" });
      return false;
    } finally {
      setNdaLoading(false);
    }
  }, [loadNdaPosts, navigate, session, toast]);

  /* category change handler */
  const onCategoryChange = useCallback(
    async (cat: string) => {
      if (cat === NDA_OPTION) {
        const ok = await checkNda();
        if (!ok) return;
      }
      void trackSiteEvent("community_filter_selected", {
        routePath: "/community",
        routeGroup: "community",
        properties: {
          surface: "community",
          category: cat,
        },
      });
      setSelectedCategory(cat);
    },
    [checkNda]
  );

  const handleBackClick = useCallback(() => navigate(-1), [navigate]);
  const handlePostClick = useCallback((post: UnifiedPost) => {
    void trackSiteEvent("community_result_clicked", {
      routePath: "/community",
      routeGroup: "community",
      properties: {
        surface: "community",
        category: post.category || "unknown",
        result: selectedCategory === NDA_OPTION ? "server-nda-post" : "gcp-community-post",
      },
    });
  }, [selectedCategory]);

  return {
    /* data */
    filteredContent,
    dropdownOptions,
    apiLoading,
    apiError,
    /* UI state */
    selectedCategory,
    searchQuery,
    setSearchQuery,
    ndaApproved,
    showNdaModal,
    setShowNdaModal,
    showNdaDocModal,
    setShowNdaDocModal,
    ndaMetadata,
    ndaLoading,
    session,
    /* actions */
    onCategoryChange,
    handleBackClick,
    handlePostClick,
    setNdaApproved,
    /* helpers (re-exported for UI) */
    getPostDescription,
    formatDisplayDate,
    getPostUrl,
    toTitleCase,
    /* constants */
    NDA_OPTION,
  };
};
