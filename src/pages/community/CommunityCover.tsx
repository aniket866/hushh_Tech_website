import React from "react";
import { getCoverImage } from "./coverImages";

/**
 * CommunityCover
 * --------------
 * On-brand cover art for community article cards.
 * Renders a real photo when one is available for the article (via getCoverImage),
 * and falls back to a self-contained, deterministic inline-SVG gradient when there
 * is no photo or the photo fails to load. The SVG fallback is per-article stable:
 * the same slug always yields the same art.
 *
 * Sizing is owned entirely by the caller via `className` (e.g. "h-40 w-full").
 * The root only contributes position/overflow/rounding so caller sizing wins.
 */

export interface CommunityCoverProps {
  category: string; // e.g. "Market Updates", "News", "Technical", ...
  title: string;
  slug: string;
  className?: string; // applied to the root element
  rounded?: string; // optional tailwind rounding override, default "rounded-[18px]"
  /**
   * An image that belongs to this specific post, used ahead of the category stock photo.
   * A deck's own title card is a far better cover than a hashed Unsplash photo: it is the
   * article's actual first page, it is distinctive, and every deck in a category otherwise draws
   * from the same small pool and the grid reads as one repeated image.
   */
  imageSrc?: string;
}

/* -------------------------------------------------------------------------- */
/* HUSHH palette                                                              */
/* -------------------------------------------------------------------------- */

const BRAND = {
  blueDeep: "#0066CC",
  blue: "#0071E3",
  blueBright: "#2997FF",
  ink: "#1D1D1F",
  light: "#F5F5F7",
  white: "#FFFFFF",
};

/**
 * Per-category accent. Everything stays within a restrained, premium look —
 * mostly blue/ink with a single accent hue. Unknown categories fall back to
 * brand blue.
 */
interface Accent {
  /** Primary accent used for the gradient sweep + motif strokes. */
  accent: string;
  /** Secondary / deeper tone, anchors the gradient. */
  deep: string;
}

const CATEGORY_ACCENTS: Record<string, Accent> = {
  "market updates": { accent: BRAND.blueBright, deep: BRAND.blueDeep },
  news: { accent: "#5E5CE6", deep: "#3634A3" }, // slate / indigo
  technical: { accent: "#22B8CF", deep: "#0A6E83" }, // teal / cyan-blue
  investment: { accent: "#34C759", deep: "#0A7E4F" }, // blue / green
  "investor relations": { accent: "#7D5CE6", deep: "#4B2FA8" }, // violet
  "fund updates": { accent: BRAND.blue, deep: BRAND.blueDeep },
  "fund documents": { accent: "#5B6470", deep: "#2B2F36" }, // graphite / ink
  product: { accent: BRAND.blueBright, deep: BRAND.blue },
  general: { accent: "#5E80A6", deep: "#324B63" }, // neutral blue-gray
};

const DEFAULT_ACCENT: Accent = { accent: BRAND.blueBright, deep: BRAND.blueDeep };

function accentFor(category: string): Accent {
  const key = (category || "").trim().toLowerCase();
  return CATEGORY_ACCENTS[key] ?? DEFAULT_ACCENT;
}

/* -------------------------------------------------------------------------- */
/* Deterministic hash from slug                                              */
/* -------------------------------------------------------------------------- */

function hashString(input: string): number {
  // FNV-1a 32-bit — stable, fast, no deps.
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // force unsigned
  return h >>> 0;
}

/* -------------------------------------------------------------------------- */
/* Component                                                                  */
/* -------------------------------------------------------------------------- */

export default function CommunityCover({
  category,
  title,
  slug,
  className,
  rounded = "rounded-[18px]",
  imageSrc,
}: CommunityCoverProps): JSX.Element {
  const { accent, deep } = accentFor(category);

  // The post's own image wins; otherwise a category photo; otherwise the SVG gradient. A runtime
  // load failure falls through to the gradient as before.
  const stock = getCoverImage(category, slug, title);
  const img = imageSrc ? { src: imageSrc, srcSet: "", alt: title } : stock;
  const [failed, setFailed] = React.useState(false);
  const [loaded, setLoaded] = React.useState(false);
  const showImage = Boolean(img) && !failed;

  // Derive deterministic variation from slug (fall back to title so empty slugs
  // still differ per article).
  const seed = hashString(slug || title || category || "hushh");

  // Gradient angle: 90deg .. 200deg range keeps the sheen tasteful.
  const angle = 90 + (seed % 110);

  // Motif placement, varied but kept within the canvas.
  const cx = 24 + (seed % 52); // 24..75 (% of width)
  const cy = 18 + ((seed >> 5) % 46); // 18..63 (% of height)

  // Motif selection: 0 = concentric rings, 1 = diagonal sheen bands, 2 = arcs.
  const motif = (seed >> 11) % 3;

  // Unique-ish ids so multiple covers on a page don't collide.
  const uid = `cc-${(seed % 0xffffff).toString(16)}`;

  // The root must NOT carry h-full/w-full — sizing is owned by the caller's
  // className. The root only provides position/overflow/rounding.
  const rootClass = ["relative overflow-hidden", rounded, className || ""].join(
    " "
  );

  /** Always-painted backdrop; a photo, when there is one, fades in over it. */
  const gradient = (
    <svg
      aria-hidden="true"
      className="absolute inset-0 h-full w-full"
      viewBox="0 0 400 250"
      preserveAspectRatio="xMidYMid slice"
      xmlns="http://www.w3.org/2000/svg"
    >
    <defs>
      {/* Background gradient — deep accent into brand ink for depth. */}
      <linearGradient
        id={`${uid}-bg`}
        gradientTransform={`rotate(${angle}, 0.5, 0.5)`}
      >
        <stop offset="0%" stopColor={deep} />
        <stop offset="55%" stopColor={BRAND.blueDeep} stopOpacity="0.92" />
        <stop offset="100%" stopColor={BRAND.ink} />
      </linearGradient>

      {/* Soft radial glow positioned by the seed. */}
      <radialGradient
        id={`${uid}-glow`}
        cx={`${cx}%`}
        cy={`${cy}%`}
        r="70%"
      >
        <stop offset="0%" stopColor={accent} stopOpacity="0.55" />
        <stop offset="45%" stopColor={accent} stopOpacity="0.18" />
        <stop offset="100%" stopColor={accent} stopOpacity="0" />
      </radialGradient>

      {/* Diagonal sheen overlay. */}
      <linearGradient id={`${uid}-sheen`} x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stopColor={BRAND.white} stopOpacity="0.14" />
        <stop offset="38%" stopColor={BRAND.white} stopOpacity="0" />
        <stop offset="100%" stopColor={BRAND.white} stopOpacity="0" />
      </linearGradient>
    </defs>

    {/* Base */}
    <rect x="0" y="0" width="400" height="250" fill={`url(#${uid}-bg)`} />
    {/* Glow */}
    <rect x="0" y="0" width="400" height="250" fill={`url(#${uid}-glow)`} />


    {/* Abstract motif — varies by seed, always restrained line-art. */}
    {motif === 0 && (
      <g
        stroke={accent}
        strokeOpacity="0.5"
        fill="none"
        strokeWidth="1.25"
      >
        {[26, 52, 80, 110, 142].map((r, i) => (
          <circle
            key={r}
            cx={(cx / 100) * 400}
            cy={(cy / 100) * 250}
            r={r}
            strokeOpacity={0.42 - i * 0.06}
          />
        ))}
      </g>
    )}

    {motif === 1 && (
      <g stroke={accent} strokeOpacity="0.4" strokeWidth="1.25">
        {[0, 1, 2, 3, 4, 5].map((i) => {
          const x = -60 + i * 90 + (seed % 40);
          return (
            <line
              key={i}
              x1={x}
              y1={0}
              x2={x + 150}
              y2={250}
              strokeOpacity={0.36 - i * 0.04}
            />
          );
        })}
      </g>
    )}

    {motif === 2 && (
      <g
        stroke={accent}
        strokeOpacity="0.5"
        fill="none"
        strokeWidth="1.5"
        strokeLinecap="round"
      >
        {[60, 110, 165, 225].map((r, i) => {
          const ox = (cx / 100) * 400;
          const oy = (cy / 100) * 250;
          return (
            <path
              key={r}
              d={`M ${ox - r} ${oy} A ${r} ${r} 0 0 1 ${ox} ${oy - r}`}
              strokeOpacity={0.45 - i * 0.07}
            />
          );
        })}
      </g>
    )}

      {/* Diagonal sheen on top for the glassy Apple feel. */}
      <rect
        x="0"
        y="0"
        width="400"
        height="250"
        fill={`url(#${uid}-sheen)`}
      />
    </svg>
  );

  return (
    <div
      role="img"
      aria-label={img?.alt ?? `${category} cover`}
      className={rootClass}
      style={{
        backgroundColor: BRAND.ink,
        boxShadow: "inset 0 0 0 0.5px rgba(0,0,0,0.06)",
      }}
    >
      {/*
        The gradient is always painted, and the photo fades in over it. Previously the root was a
        flat near-black rectangle until the image decoded, so a grid of lazily loaded cards showed a
        wall of black boxes on first paint and again on any slow connection — the loading state
        looked like a bug rather than a placeholder.
      */}
      {gradient}

      {showImage && img ? (
        <>
          <img
            src={img.src}
            srcSet={img.srcSet || undefined}
            sizes="(max-width: 640px) 100vw, 400px"
            alt=""
            loading="lazy"
            decoding="async"
            className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-500 ${
              loaded ? "opacity-100" : "opacity-0"
            }`}
            onLoad={() => setLoaded(true)}
            onError={() => setFailed(true)}
          />
          {/* Subtle depth/cohesion overlay over the photo. */}
          <span
            aria-hidden
            className="absolute inset-0"
            style={{
              background:
                "linear-gradient(180deg, rgba(0,0,0,0) 55%, rgba(0,0,0,0.18) 100%)",
            }}
          />
        </>
      ) : null}
    </div>
  );
}
