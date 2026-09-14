import { useEffect, useRef, useState, type ReactNode } from "react";
import { useHomeLogic } from "./logic";
import HushhTechHeader from "../../components/hushh-tech-header/HushhTechHeader";
import SeoHead from "../../components/seo/SeoHead";
import HushhTechFooter, {
  HushhFooterTab,
} from "../../components/hushh-tech-footer/HushhTechFooter";
import techTeamImage from "../../components/images/tech-team-final.png";

const homeFont = "'Lato', -apple-system, 'Segoe UI', sans-serif";
const easeOutCubic = (value: number) => 1 - Math.pow(1 - value, 3);

function useInViewOnce<T extends HTMLElement>(threshold = 0.12) {
  const ref = useRef<T | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element || visible) return;

    if (!("IntersectionObserver" in window)) {
      setVisible(true);
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        setVisible(true);
        observer.disconnect();
      },
      { threshold, rootMargin: "0px 0px -6% 0px" },
    );

    observer.observe(element);
    return () => observer.disconnect();
  }, [threshold, visible]);

  return { ref, visible };
}

function CountUp({
  value,
  decimals = 0,
  active,
}: {
  value: number;
  decimals?: number;
  active: boolean;
}) {
  const [display, setDisplay] = useState(0);

  useEffect(() => {
    if (!active) return;
    let frame = 0;
    const duration = 1500;
    const start = performance.now();

    const tick = (now: number) => {
      const progress = Math.min(1, (now - start) / duration);
      setDisplay(value * easeOutCubic(progress));
      if (progress < 1) frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [active, value]);

  return <>{display.toFixed(decimals)}</>;
}

function Reveal({
  children,
  className = "",
  delay = 0,
  immediate = false,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
  immediate?: boolean;
}) {
  const { ref, visible } = useInViewOnce<HTMLDivElement>();
  const shown = immediate || visible;

  return (
    <div
      ref={ref}
      className={className}
      style={{
        opacity: shown ? 1 : 0,
        transform: shown ? "translateY(0)" : "translateY(28px)",
        transition:
          "opacity .8s cubic-bezier(.22,.61,.36,1), transform .8s cubic-bezier(.22,.61,.36,1)",
        transitionDelay: `${delay}ms`,
      }}
    >
      {children}
    </div>
  );
}

function HomeStyles() {
  return (
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Lato:wght@300;400;500;600;700;900&display=swap');
      :root {
        --hh-home-blue: #0071e3;
        --hh-home-blue-2: #2997ff;
        --hh-home-ink: #1d1d1f;
        --hh-home-muted: #6e6e73;
      }
      [data-page="hushh-home"] *,
      [data-page="hushh-home"] *::before,
      [data-page="hushh-home"] *::after {
        box-sizing: border-box;
      }
      @keyframes hh-home-glowdrift {
        0%, 100% { transform: translateX(-50%) translateY(0) scale(1); }
        50% { transform: translateX(-50%) translateY(-16px) scale(1.06); }
      }
      .hh-hero {
        position: relative;
        min-height: 100svh;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        background: #fff;
        color: var(--hh-home-ink);
        padding: clamp(118px, 15vh, 168px) 24px clamp(100px, 13vh, 140px);
        text-align: center;
        overflow: hidden;
      }
      .hh-hero__glow {
        position: absolute;
        top: 6%;
        left: 50%;
        transform: translateX(-50%);
        width: min(78vw, 920px);
        height: min(70vw, 760px);
        border-radius: 50%;
        background: radial-gradient(ellipse at 50% 40%, rgba(0,113,227,.1), rgba(0,113,227,0) 62%);
        pointer-events: none;
        z-index: 0;
        animation: hh-home-glowdrift 11s ease-in-out infinite;
        will-change: transform;
      }
      .hh-hero__grid {
        position: absolute;
        inset: 0;
        z-index: 0;
        pointer-events: none;
        background-image: radial-gradient(rgba(0,0,0,.035) 1px, transparent 1px);
        background-size: 40px 40px;
        -webkit-mask-image: radial-gradient(ellipse 56% 42% at 50% 28%, #000 0%, transparent 76%);
        mask-image: radial-gradient(ellipse 56% 42% at 50% 28%, #000 0%, transparent 76%);
        opacity: .55;
      }
      .hh-hero__inner {
        position: relative;
        z-index: 2;
        max-width: 980px;
        margin: 0 auto;
        display: flex;
        flex-direction: column;
        align-items: center;
      }
      .hh-hero__badge {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 7px 15px 7px 11px;
        border-radius: 980px;
        background: rgba(0,113,227,.08);
        margin-bottom: 26px;
      }
      .hh-hero__badge span:first-child {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: var(--hh-home-blue);
      }
      .hh-hero__badge span:last-child,
      .hh-eyebrow {
        font-size: 13px;
        font-weight: 700;
        letter-spacing: .14em;
        text-transform: uppercase;
        color: var(--hh-home-blue);
      }
      .hh-hero h1 {
        margin: 0;
        font-weight: 600;
        font-size: clamp(38px, 6.2vw, 68px);
        line-height: 1.08;
        letter-spacing: -.025em;
        color: var(--hh-home-ink);
        text-wrap: balance;
      }
      .hh-hero__sub {
        margin: 26px 0 0;
        max-width: 54ch;
        font-weight: 400;
        font-size: clamp(19px, 2.1vw, 25px);
        line-height: 1.4;
        letter-spacing: -.01em;
        color: rgba(0,0,0,.6);
        text-wrap: pretty;
      }
      .hh-hero__cta {
        display: flex;
        flex-wrap: wrap;
        gap: 22px;
        align-items: center;
        justify-content: center;
        margin-top: 36px;
      }
      .hh-hero__trust {
        margin-top: 22px;
        font-size: 13px;
        color: rgba(0,0,0,.4);
      }
      .hh-section {
        padding: clamp(96px, 11vw, 150px) 40px;
      }
      .hh-wrap {
        max-width: 1280px;
        margin: 0 auto;
      }
      .hh-h2 {
        margin: 0;
        font-weight: 600;
        font-size: clamp(32px, 4.6vw, 54px);
        line-height: 1.08;
        letter-spacing: -.025em;
        text-wrap: balance;
      }
      .hh-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 52px;
        padding: 0 30px;
        border-radius: 980px;
        border: 0;
        font-size: 17px;
        font-weight: 500;
        text-decoration: none;
        transition: background .2s, transform .25s cubic-bezier(.4,0,.2,1), box-shadow .25s;
        cursor: pointer;
      }
      .hh-btn--primary {
        background: var(--hh-home-blue);
        color: #fff;
        box-shadow: 0 8px 24px rgba(0,113,227,.26);
      }
      .hh-btn--primary:hover {
        background: #0077ed;
        transform: translateY(-2px);
        box-shadow: 0 14px 34px rgba(0,113,227,.34);
      }
      .hh-btn--primary:active {
        transform: scale(.97);
      }
      .hh-btn--text {
        background: transparent;
        color: #0066cc;
        gap: 5px;
      }
      .hh-btn--chevron::after {
        content: "›";
        font-size: 19px;
        line-height: 1;
      }
      .hh-btn--text:hover {
        text-decoration: underline;
      }
      .hh-btn--white {
        background: #fff;
        color: var(--hh-home-ink);
        font-weight: 600;
      }
      .hh-btn--white:hover {
        background: #f0f0f2;
        transform: translateY(-1px);
      }
      .hh-btn--outline-dark {
        background: transparent;
        border: 1px solid rgba(255,255,255,.4);
        color: #fff;
        gap: 6px;
      }
      .hh-btn--outline-dark:hover {
        background: rgba(255,255,255,.08);
        border-color: rgba(255,255,255,.7);
      }
      .hh-perf {
        background:
          radial-gradient(ellipse at 50% 0%, rgba(0,113,227,.18), rgba(0,113,227,0) 56%),
          linear-gradient(180deg, #050506 0%, #000 100%);
        color: #fff;
        overflow: hidden;
      }
      .hh-perf__head {
        max-width: 760px;
        margin: 0 auto;
        text-align: center;
      }
      .hh-chip {
        display: inline-flex;
        align-items: center;
        gap: 9px;
        margin-bottom: 24px;
        padding: 8px 16px;
        border-radius: 980px;
        border: 1px solid rgba(255,255,255,.2);
      }
      .hh-chip span:first-child {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: var(--hh-home-blue-2);
      }
      .hh-chip span:last-child {
        font-size: 12px;
        font-weight: 600;
        letter-spacing: .06em;
        color: rgba(255,255,255,.82);
      }
      .hh-perf__sub {
        margin-top: 22px;
        margin-left: auto;
        margin-right: auto;
        max-width: 42ch;
        font-weight: 300;
        font-size: clamp(18px, 1.6vw, 24px);
        line-height: 1.4;
        color: rgba(255,255,255,.56);
      }
      .hh-fund-ring {
        position: relative;
        width: min(100%, 440px);
        margin: clamp(48px, 6vw, 72px) auto 0;
        text-align: center;
      }
      .hh-fund-ring::before {
        content: "";
        position: absolute;
        inset: 4% 3% auto;
        height: 74%;
        border-radius: 50%;
        background:
          radial-gradient(circle at 50% 54%, rgba(41,151,255,.18), transparent 54%),
          radial-gradient(circle at 50% 50%, rgba(48,209,88,.09), transparent 62%);
        filter: blur(22px);
        opacity: .78;
        pointer-events: none;
      }
      .hh-fund-ring__dial {
        position: relative;
        width: clamp(230px, 26vw, 278px);
        height: clamp(230px, 26vw, 278px);
        margin: 0 auto;
      }
      .hh-fund-ring__svg {
        display: block;
        width: 100%;
        height: 100%;
        transform: rotate(-90deg);
      }
      .hh-fund-ring__track {
        fill: none;
        stroke: rgba(235,235,245,.08);
        stroke-width: 19;
      }
      .hh-fund-ring__progress {
        fill: none;
        stroke: #30D158;
        stroke-width: 19;
        stroke-linecap: round;
        filter: drop-shadow(0 0 10px rgba(48,209,88,.42));
        transition: stroke-dashoffset 1.25s cubic-bezier(.34,.85,.3,1);
      }
      .hh-fund-ring__center {
        position: absolute;
        inset: 0;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
      }
      .hh-fund-ring__number {
        display: flex;
        align-items: baseline;
        font-weight: 600;
        line-height: 1;
        letter-spacing: -1.7px;
        color: #fff;
        font-variant-numeric: tabular-nums;
      }
      .hh-fund-ring__plus {
        margin-right: 2px;
        font-size: clamp(30px, 4vw, 40px);
        color: #30D158;
      }
      .hh-fund-ring__value {
        font-size: clamp(48px, 6vw, 64px);
      }
      .hh-fund-ring__percent {
        margin-left: 1px;
        font-size: clamp(22px, 3vw, 28px);
        font-weight: 500;
        color: rgba(235,235,245,.55);
      }
      .hh-fund-ring__caption {
        margin-top: 8px;
        font-size: 13px;
        font-weight: 400;
        letter-spacing: -.06px;
        color: rgba(235,235,245,.52);
      }
      .hh-fund-ring__meta {
        margin-top: 22px;
        font-size: 12px;
        font-weight: 600;
        letter-spacing: 1.35px;
        text-transform: uppercase;
        color: rgba(235,235,245,.48);
      }
      .hh-fund-ring__facts {
        display: grid;
        grid-template-columns: 1fr 1px 1fr;
        align-items: start;
        max-width: 400px;
        margin: 30px auto 0;
        padding-top: 27px;
        border-top: 1px solid rgba(235,235,245,.13);
      }
      .hh-fund-ring__divider {
        height: 44px;
        background: rgba(235,235,245,.13);
      }
      .hh-fund-ring__fact-value {
        font-size: clamp(20px, 2.5vw, 24px);
        font-weight: 600;
        line-height: 1;
        letter-spacing: -.5px;
        color: #fff;
        font-variant-numeric: tabular-nums;
      }
      .hh-fund-ring__fact-label {
        margin-top: 12px;
        font-size: 11px;
        font-weight: 600;
        letter-spacing: .6px;
        text-transform: uppercase;
        color: rgba(235,235,245,.43);
      }
      .hh-tech__grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
        gap: clamp(40px, 6vw, 80px);
        align-items: center;
      }
      .hh-tech h2 {
        margin-top: 18px;
        color: var(--hh-home-ink);
      }
      .hh-tech__p {
        margin-top: 24px;
        max-width: 44ch;
        font-weight: 400;
        font-size: clamp(18px, 1.5vw, 21px);
        line-height: 1.47;
        color: var(--hh-home-muted);
      }
      .hh-includes {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 28px 32px;
        margin-top: 24px;
      }
      .hh-includes__label {
        font-size: 12px;
        font-weight: 600;
        letter-spacing: .08em;
        text-transform: uppercase;
        color: #86868b;
        margin: clamp(40px,5vw,56px) 0 22px;
      }
      .hh-feat {
        display: flex;
        flex-direction: column;
        gap: 16px;
      }
      .hh-feat h3 {
        margin: 0;
        font-size: 19px;
        font-weight: 600;
        color: var(--hh-home-ink);
      }
      .hh-feat p {
        margin: 7px 0 0;
        font-size: 15px;
        line-height: 1.45;
        color: var(--hh-home-muted);
      }
      .hh-tech__img img {
        display: block;
        width: 100%;
        height: auto;
      }
      .hh-tile {
        width: 46px;
        height: 46px;
        border-radius: 13px;
        background: var(--hh-home-blue);
        display: flex;
        align-items: center;
        justify-content: center;
        flex: none;
      }
      .hh-tile--sm {
        width: 44px;
        height: 44px;
        border-radius: 12px;
      }
      @media (prefers-reduced-motion: reduce) {
        [data-home-motion] {
          animation: none !important;
          transition: none !important;
          transform: none !important;
          opacity: 1 !important;
        }
      }
      @media (max-width: 760px) {
        .hh-tech__grid { grid-template-columns: 1fr; }
      }
      @media (max-width: 640px) {
        .hh-section,
        .hh-hero {
          padding-left: 20px;
          padding-right: 20px;
        }
        .hh-section {
          padding-top: 78px;
          padding-bottom: 82px;
        }
        .hh-hero {
          min-height: 92svh;
        }
        .hh-hero h1 {
          font-size: clamp(38px, 11.2vw, 52px);
        }
        .hh-hero__sub {
          font-size: clamp(18px, 5vw, 21px);
          max-width: 31ch;
        }
        .hh-hero__cta {
          width: 100%;
          gap: 14px;
        }
        .hh-hero__cta .hh-btn--primary {
          width: min(100%, 260px);
        }
        .hh-includes {
          grid-template-columns: 1fr;
          gap: 26px;
        }
        .hh-perf__head {
          max-width: 100%;
        }
        .hh-perf__sub {
          max-width: 31ch;
          font-size: clamp(17px, 4.7vw, 20px);
        }
        .hh-fund-ring {
          margin-top: 40px;
        }
        .hh-fund-ring__dial {
          width: min(72vw, 248px);
          height: min(72vw, 248px);
        }
        .hh-fund-ring__track,
        .hh-fund-ring__progress {
          stroke-width: 17;
        }
        .hh-fund-ring__facts {
          margin-top: 26px;
          padding-top: 24px;
        }
        .hh-tech__grid {
          gap: 34px;
        }
        .hh-tech__p {
          font-size: clamp(17px, 4.6vw, 20px);
        }
      }
    `}</style>
  );
}

function Section({
  children,
  tone = "light",
  className = "",
}: {
  children: ReactNode;
  tone?: "light" | "gray" | "dark";
  className?: string;
}) {
  const toneClass =
    tone === "dark"
      ? "bg-black text-white"
      : tone === "gray"
        ? "bg-[#F5F5F7] text-[#1D1D1F]"
        : "bg-white text-[#1D1D1F]";

  return (
    <section
      className={`relative overflow-hidden px-5 py-[96px] sm:px-10 lg:py-[150px] ${toneClass} ${className}`}
      style={{ fontFamily: homeFont }}
    >
      {children}
    </section>
  );
}

function Eyebrow({
  children,
  dark = false,
  className = "",
}: {
  children: ReactNode;
  dark?: boolean;
  className?: string;
}) {
  return (
    <div
      className={`text-[13px] font-bold uppercase tracking-[0.14em] ${dark ? "text-[#2997FF]" : "text-[#0071E3]"} ${className}`}
      style={{ fontFamily: homeFont }}
    >
      {children}
    </div>
  );
}

function Heading({
  children,
  className = "",
  as: Tag = "h2",
}: {
  children: ReactNode;
  className?: string;
  as?: "h1" | "h2";
}) {
  return (
    <Tag
      className={`m-0 text-balance text-[clamp(32px,4.6vw,54px)] font-semibold leading-[1.08] tracking-[-0.025em] ${className}`}
      style={{ fontFamily: homeFont }}
    >
      {children}
    </Tag>
  );
}

function Lead({
  children,
  className = "",
  dark = false,
}: {
  children: ReactNode;
  className?: string;
  dark?: boolean;
}) {
  return (
    <p
      className={`m-0 text-pretty text-[clamp(17px,1.6vw,20px)] font-light leading-[1.5] ${dark ? "text-white/55" : "text-black/50"} ${className}`}
      style={{ fontFamily: homeFont }}
    >
      {children}
    </p>
  );
}

function IconTile({ children, large = false }: { children: ReactNode; large?: boolean }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center bg-[#0071E3] ${large ? "h-[46px] w-[46px] rounded-[13px]" : "h-11 w-11 rounded-xl"}`}
    >
      {children}
    </span>
  );
}

const technologyFeatures = [
  {
    title: "AI-Powered",
    body: "Institutional analytics processing millions of signals.",
    icon: (
      <svg width="23" height="23" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <rect x="7" y="7" width="10" height="10" rx="2" stroke="#fff" strokeWidth="1.7" />
        <rect x="10" y="10" width="4" height="4" rx="1" fill="#fff" />
        <path
          d="M9.5 3v2.5M14.5 3v2.5M9.5 18.5V21M14.5 18.5V21M3 9.5h2.5M3 14.5h2.5M18.5 9.5H21M18.5 14.5H21"
          stroke="#fff"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      </svg>
    ),
  },
  {
    title: "Human-Led",
    body: "Seasoned oversight ensuring long-term, conviction-led decisions.",
    icon: (
      <svg width="23" height="23" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="12" cy="9" r="3.2" stroke="#fff" strokeWidth="1.7" />
        <path
          d="M5.5 20c0-3.4 2.9-5.4 6.5-5.4s6.5 2 6.5 5.4"
          stroke="#fff"
          strokeWidth="1.7"
          strokeLinecap="round"
        />
      </svg>
    ),
  },
];

const principleCards = [
  {
    title: "Data Driven",
    body: "Decisions based on facts, not emotions.",
    icon: <path d="M5 20V11M12 20V5M19 20v-7" stroke="#fff" strokeWidth="1.9" strokeLinecap="round" />,
  },
  {
    title: "Low Fees",
    body: "More of your returns stay in your pocket.",
    icon: (
      <>
        <circle cx="8" cy="8" r="2.4" stroke="#fff" strokeWidth="1.6" />
        <circle cx="16" cy="16" r="2.4" stroke="#fff" strokeWidth="1.6" />
        <path d="M17 7L7 17" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" />
      </>
    ),
  },
  {
    title: "Expert Vetted",
    body: "Top-tier financial minds at work.",
    icon: (
      <>
        <path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3z" stroke="#fff" strokeWidth="1.7" strokeLinejoin="round" />
        <path d="M9 12l2 2 4-4" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      </>
    ),
  },
  {
    title: "Automated",
    body: "Set it and forget it peace of mind.",
    icon: <path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z" stroke="#fff" strokeWidth="1.7" strokeLinejoin="round" />,
  },
];

const whatYouGetCards = [
  {
    title: "High Growth",
    body: "Accelerated returns strategy.",
    icon: (
      <>
        <path d="M4 17l6-6 4 3 6-8" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M15 6h5v5" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </>
    ),
  },
  {
    title: "Diversified",
    body: "Multi-sector allocation.",
    icon: (
      <>
        <rect x="4" y="4" width="6.5" height="6.5" rx="1.4" stroke="#fff" strokeWidth="1.7" />
        <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.4" stroke="#fff" strokeWidth="1.7" />
        <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.4" stroke="#fff" strokeWidth="1.7" />
        <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.4" stroke="#fff" strokeWidth="1.7" />
      </>
    ),
  },
  {
    title: "Liquid",
    body: "Quarterly redemption windows.",
    icon: (
      <>
        <path d="M3 9h14M13.5 5L18 9l-4.5 4" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M21 15H7m3.5-4L6 15l4.5 4" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      </>
    ),
  },
  {
    title: "Secure",
    body: "Regulated custodian assets.",
    icon: (
      <>
        <path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3z" stroke="#fff" strokeWidth="1.7" strokeLinejoin="round" />
        <path d="M9 12l2 2 4-4" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      </>
    ),
  },
];

function FundStatsSection({
  onInvest,
}: {
  onInvest: () => void;
}) {
  const { ref, visible } = useInViewOnce<HTMLDivElement>(0.35);
  const ringSize = 270;
  const ringCenter = ringSize / 2;
  const ringStroke = 19;
  const ringRadius = (ringSize - ringStroke) / 2 - 6;
  const circumference = 2 * Math.PI * ringRadius;
  const progress = 0.86;
  const dash = circumference * progress;

  return (
    <section id="fund" className="hh-section hh-perf" style={{ fontFamily: homeFont }}>
      <div className="hh-wrap">
        <Reveal className="hh-perf__head">
          <div className="hh-chip">
            <span />
            <span>High Growth</span>
          </div>
          <h2 className="hh-h2">Fund A.</h2>
          <p className="hh-perf__sub">
            A high-growth strategy engineered to compound capital with discipline.
          </p>
        </Reveal>

        <Reveal>
          <div ref={ref} className="hh-fund-ring" aria-label="Fund A FY 2025 net return 21.4 percent">
            <div className="hh-fund-ring__dial">
              <svg className="hh-fund-ring__svg" viewBox={`0 0 ${ringSize} ${ringSize}`} aria-hidden="true">
                <circle
                  className="hh-fund-ring__track"
                  cx={ringCenter}
                  cy={ringCenter}
                  r={ringRadius}
                />
                <circle
                  className="hh-fund-ring__progress"
                  cx={ringCenter}
                  cy={ringCenter}
                  r={ringRadius}
                  strokeDasharray={`${dash} ${circumference}`}
                  strokeDashoffset={visible ? 0 : dash}
                />
              </svg>
              <div className="hh-fund-ring__center">
                <div className="hh-fund-ring__number">
                  <span className="hh-fund-ring__plus">+</span>
                  <span className="hh-fund-ring__value" data-count="21.4" data-dec="1">
                    <CountUp value={21.4} active={visible} decimals={1} />
                  </span>
                  <span className="hh-fund-ring__percent">%</span>
                </div>
                <div className="hh-fund-ring__caption">Net of fees</div>
              </div>
            </div>
            <div className="hh-fund-ring__meta">FY 2025</div>
            <div className="hh-fund-ring__facts">
              <div>
                <div className="hh-fund-ring__fact-value">
                  <span data-count="18">18</span>&ndash;<span data-count="23"><CountUp value={23} active={visible} /></span>%
                </div>
                <div className="hh-fund-ring__fact-label">Target internal rate of return</div>
              </div>
              <div className="hh-fund-ring__divider" />
              <div>
                <div className="hh-fund-ring__fact-value">Quarterly</div>
                <div className="hh-fund-ring__fact-label">Redemption liquidity windows</div>
              </div>
            </div>
          </div>
        </Reveal>

        <Reveal className="mt-[clamp(48px,6vw,72px)]">
          <button type="button" onClick={onInvest} className="hh-btn hh-btn--white">
            Invest in Fund A
          </button>
        </Reveal>
      </div>
    </section>
  );
}

function TechnologySection() {
  return (
    <section id="tech" className="hh-section hh-tech bg-white" style={{ fontFamily: homeFont }}>
      <div className="hh-wrap">
        <div className="hh-tech__grid">
          <Reveal>
            <div className="hh-eyebrow">Fund Technology</div>
            <h2 className="hh-h2">Designed like a technology product.</h2>
            <p className="hh-tech__p">
              Institutional analytics, human oversight, and modern fund operations
              &mdash; in one investment experience.
            </p>

            <div className="hh-includes__label">Includes</div>
            <div className="hh-includes">
              {technologyFeatures.map((feature) => (
                <div key={feature.title} className="hh-feat">
                  <span className="hh-tile hh-tile--sm">{feature.icon}</span>
                  <div>
                    <h3>{feature.title}</h3>
                    <p>{feature.body}</p>
                  </div>
                </div>
              ))}
            </div>

            <a
              className="hh-btn hh-btn--text"
              style={{
                marginTop: "clamp(40px,5vw,56px)",
                minHeight: "auto",
                padding: 0,
              }}
              href="#tech"
            >
              Explore the technology <span style={{ fontSize: 19 }}>&rsaquo;</span>
            </a>
          </Reveal>

          <Reveal delay={120} className="hh-tech__img">
            <img
              src={techTeamImage}
              alt="hushh product team - AI-powered, +21.4% net"
            />
          </Reveal>
        </div>
      </div>
    </section>
  );
}

function PrinciplesSection() {
  return (
    <Section tone="gray">
      <div className="mx-auto max-w-[1280px]">
        <Reveal className="mx-auto mb-[clamp(48px,6vw,64px)] max-w-[680px] text-center">
          <Eyebrow className="mb-4">Why Hushh</Eyebrow>
          <Heading>Built on principles you can trust.</Heading>
        </Reveal>

        <div className="grid gap-[18px] sm:grid-cols-2 lg:grid-cols-4">
          {principleCards.map((card, index) => (
            <Reveal key={card.title} delay={index * 70}>
              <div className="flex min-h-[200px] flex-col rounded-[22px] bg-white p-[30px] transition duration-300 hover:-translate-y-1.5 hover:shadow-[0_18px_40px_rgba(0,0,0,0.08)]">
                <IconTile>
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    {card.icon}
                  </svg>
                </IconTile>
                <h3 className="mt-5 text-[20px] font-semibold tracking-[-0.01em] text-[#1D1D1F]">
                  {card.title}
                </h3>
                <p className="mt-2 text-[15px] leading-[1.5] text-[#6E6E73]">
                  {card.body}
                </p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </Section>
  );
}

function WhatYouGetSection() {
  return (
    <Section tone="dark">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute left-1/2 top-0 h-[58%] w-[min(92vw,1040px)] -translate-x-1/2"
        style={{
          background:
            "radial-gradient(ellipse at 50% 0%, rgba(0,113,227,0.18), rgba(0,113,227,0) 70%)",
        }}
      />
      <div className="relative z-[1] mx-auto max-w-[1100px]">
        <Reveal className="mx-auto mb-[clamp(48px,6vw,64px)] max-w-[680px] text-center">
          <Eyebrow dark className="mb-[18px]">
            What you get
          </Eyebrow>
          <Heading className="text-white">Everything for serious investing.</Heading>
          <Lead dark className="mx-auto mt-5 max-w-[46ch]">
            Start with Fund A, or read the full prospectus to understand the
            strategy, terms, and risk framework.
          </Lead>
        </Reveal>

        <div className="grid gap-[18px] sm:grid-cols-2 lg:grid-cols-4">
          {whatYouGetCards.map((card, index) => (
            <Reveal key={card.title} delay={index * 70}>
              <div className="flex min-h-[204px] flex-col rounded-[22px] border border-white/[0.08] bg-[#0E0E10] p-[30px] transition duration-300 hover:-translate-y-1.5 hover:border-[#2997FF]/45">
                <IconTile large>
                  <svg width="23" height="23" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    {card.icon}
                  </svg>
                </IconTile>
                <h3 className="mt-5 text-[20px] font-semibold tracking-[-0.01em] text-white">
                  {card.title}
                </h3>
                <p className="mt-2 text-[15px] leading-[1.5] text-white/55">
                  {card.body}
                </p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </Section>
  );
}

function FinalCtaSection({
  onInvest,
  onProspectus,
}: {
  onInvest: () => void;
  onProspectus: () => void;
}) {
  return (
    <Section tone="light">
      <Reveal className="mx-auto max-w-[680px] text-center">
        <Eyebrow className="mb-[18px]">Get started</Eyebrow>
        <Heading>Start with Fund A.</Heading>
        <Lead className="mx-auto mt-5 max-w-[46ch]">
          Begin investing in Fund A, or read the full prospectus to understand
          the strategy, terms, and risk framework.
        </Lead>

        <div className="mt-[clamp(32px,5vw,44px)] flex flex-wrap justify-center gap-4">
          <a
            href="/discover-fund-a"
            onClick={(event) => {
              event.preventDefault();
              onInvest();
            }}
            className="inline-flex min-h-[52px] items-center justify-center rounded-full bg-[#0071e3] px-[30px] text-[17px] font-semibold text-white transition hover:-translate-y-px hover:bg-[#0077ED] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0071e3]/45"
          >
            Invest in Fund A
          </a>
          <button
            type="button"
            onClick={onProspectus}
            className="hh-btn--chevron inline-flex min-h-[52px] items-center justify-center gap-1 rounded-full border border-[#1D1D1F]/20 bg-transparent px-[30px] text-[17px] font-medium text-[#1D1D1F] transition hover:bg-[#1D1D1F]/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0071e3]/45"
          >
            Read the fund prospectus
          </button>
        </div>
      </Reveal>
    </Section>
  );
}

export default function HomePage() {
  const { onNavigate, primaryCTA } = useHomeLogic();

  return (
    <div
      data-page="hushh-home"
      className="min-h-screen overflow-x-hidden bg-white text-[#1D1D1F] antialiased selection:bg-[#0066CC] selection:text-[#F5F5F7]"
      style={{ fontFamily: homeFont }}
    >
      <HomeStyles />
      <SeoHead
        path="/"
        description="Invest alongside HushhTech — an AI-driven, long-term value strategy modeled on Berkshire Hathaway. We combine AI and human expertise to back exceptional businesses."
      />
      <HushhTechHeader />

      <main id="main-content">
        <section className="hh-hero" style={{ fontFamily: homeFont }}>
          <div data-home-motion className="hh-hero__glow" />
          <div className="hh-hero__grid" />
          <div className="hh-hero__inner">
            <Reveal immediate>
              <div className="hh-hero__badge">
                <span />
                <span>AI-Powered Investing</span>
              </div>
            </Reveal>
            <Reveal immediate delay={70}>
              <h1>The world&apos;s first AI-powered Berkshire Hathaway.</h1>
            </Reveal>
            <Reveal immediate delay={140}>
              <p className="hh-hero__sub">
                Merging rigorous data science with human wisdom.
              </p>
            </Reveal>
            <Reveal immediate delay={210}>
              <div className="hh-hero__cta">
                <button
                  className="hh-btn hh-btn--primary"
                  type="button"
                  disabled={primaryCTA.loading}
                  onClick={primaryCTA.action}
                >
                  {primaryCTA.text}
                </button>
                <button
                  className="hh-btn hh-btn--text hh-btn--chevron"
                  type="button"
                  onClick={() => onNavigate("/discover-fund-a")}
                >
                  Discover Fund A
                </button>
              </div>
            </Reveal>
            <Reveal immediate delay={280}>
              <div className="hh-hero__trust">
                SEC Registered &nbsp;&middot;&nbsp; 256-bit encryption
              </div>
            </Reveal>
          </div>
        </section>

        <FundStatsSection onInvest={() => onNavigate("/discover-fund-a")} />
        <TechnologySection />
        <PrinciplesSection />
        <WhatYouGetSection />
        <FinalCtaSection
          onInvest={() => onNavigate("/discover-fund-a")}
          onProspectus={() =>
            onNavigate("/community/fund-documents/investment-prospectus")
          }
        />
      </main>

      <HushhTechFooter activeTab={HushhFooterTab.HOME} />
    </div>
  );
}
