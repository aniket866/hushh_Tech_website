import { useEffect, useRef, useState, type ReactNode } from "react";

import HushhTechHeader from "../../components/hushh-tech-header/HushhTechHeader";
import HushhTechFooter, {
  HushhFooterTab,
} from "../../components/hushh-tech-footer/HushhTechFooter";
import SeoHead from "../../components/seo/SeoHead";
import { useDiscoverFundALogic } from "./logic";

const fundAFont = "'Lato', -apple-system, 'Segoe UI', sans-serif";

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

function Reveal({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  const { ref, visible } = useInViewOnce<HTMLDivElement>();

  return (
    <div
      ref={ref}
      className={className}
      style={{
        opacity: visible ? 1 : 0,
        transform: visible ? "translateY(0)" : "translateY(26px)",
        transition:
          "opacity .8s cubic-bezier(.22,.61,.36,1), transform .8s cubic-bezier(.22,.61,.36,1)",
      }}
    >
      {children}
    </div>
  );
}

function FundAStyles() {
  return (
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Lato:wght@300;400;700;900&display=swap');
      [data-page="fund-a"] *,
      [data-page="fund-a"] *::before,
      [data-page="fund-a"] *::after { box-sizing: border-box; }
      [data-page="fund-a"] h1,
      [data-page="fund-a"] h2,
      [data-page="fund-a"] h3 { margin: 0; text-wrap: balance; }
      [data-page="fund-a"] p { margin: 0; text-wrap: pretty; }
      .fa-sec { padding: clamp(96px,12vw,150px) 40px; }
      .fa-flagship {
        position: relative;
        padding: clamp(84px,9vw,118px) 40px clamp(74px,8vw,104px);
        overflow: hidden;
      }
      .fa-flagship::before {
        content: "";
        position: absolute;
        inset: 0;
        background:
          radial-gradient(ellipse at 50% 8%, rgba(0,113,227,.1), rgba(0,113,227,0) 58%),
          linear-gradient(180deg, #fff 0%, #fbfcff 100%);
        pointer-events: none;
      }
      .fa-flagship__inner {
        position: relative;
        z-index: 1;
        max-width: 1100px;
        margin: 0 auto;
      }
      .fa-flagship__intro {
        max-width: 720px;
        margin: 0 auto clamp(36px,5vw,52px);
      }
      .fa-flagship__metric {
        max-width: 620px;
        margin: 0 auto;
        padding: clamp(28px,4vw,42px);
        border: 1px solid rgba(0,113,227,.1);
        border-radius: 30px;
        background: rgba(255,255,255,.72);
        box-shadow:
          0 24px 70px rgba(0,0,0,.055),
          0 0 0 1px rgba(255,255,255,.78) inset;
        backdrop-filter: blur(18px);
        -webkit-backdrop-filter: blur(18px);
      }
      .fa-head-c { text-align: center; margin-left: auto; margin-right: auto; }
      .fa-eyebrow {
        font-size: 13px;
        font-weight: 700;
        letter-spacing: .14em;
        text-transform: uppercase;
      }
      .fa-h2 {
        font-weight: 600;
        font-size: clamp(32px,4.6vw,54px);
        line-height: 1.08;
        letter-spacing: -.025em;
      }
      .fa-r3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; }
      .fa-r2 { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
      .fa-card { display: flex; flex-direction: column; border-radius: 24px; }
      .fa-keyterm-row {
        display: grid;
        grid-template-columns: minmax(180px, 280px) minmax(0, 1fr);
        column-gap: clamp(28px,6vw,96px);
        align-items: start;
      }
      .fa-keyterm-title {
        font-weight: 600;
        font-size: 16px;
        color: #1d1d1f;
      }
      .fa-keyterm-content {
        max-width: 68ch;
        justify-self: start;
        font-size: 15px;
        line-height: 1.5;
        color: rgba(0,0,0,.55);
        text-align: left;
      }
      .fa-glow {
        transition:
          transform .4s cubic-bezier(.22,.61,.36,1),
          border-color .4s ease,
          background-color .4s ease,
          box-shadow .4s ease;
      }
      .fa-glow:hover {
        transform: translateY(-6px);
        background: #111216 !important;
        border-color: rgba(41,151,255,.34) !important;
        box-shadow:
          0 26px 70px rgba(0,70,180,.22),
          0 0 0 1px rgba(41,151,255,.06) inset;
      }
      .fa-lift { transition: transform .4s cubic-bezier(.22,.61,.36,1), box-shadow .4s; }
      .fa-lift:hover { transform: translateY(-6px); box-shadow: 0 22px 50px rgba(0,0,0,.09); }
      .fa-framework-row {
        display: flex;
        gap: clamp(18px,3vw,34px);
        align-items: flex-start;
        padding: clamp(24px,3vw,32px) 0;
      }
      .fa-framework-num {
        flex: none;
        min-width: 48px;
        font-weight: 700;
        font-size: clamp(26px,3.4vw,40px);
        line-height: 1;
        letter-spacing: -.02em;
        color: #0071e3;
      }
      @media (max-width: 760px) {
        .fa-r3 { grid-template-columns: 1fr !important; }
      }
      @media (max-width: 640px) {
        .fa-r2 { grid-template-columns: 1fr; }
        .fa-sec { padding: 72px 20px; }
        .fa-flagship { padding: 76px 20px 68px; }
        .fa-flagship__metric { border-radius: 24px; padding: 26px 20px; }
        .fa-framework-row { gap: 16px; }
        .fa-framework-num { min-width: 38px; }
        .fa-card { border-radius: 22px; }
        .fa-share-card { padding: 24px !important; }
        .fa-share-card__head {
          align-items: flex-start !important;
          flex-direction: column !important;
          gap: 10px !important;
          margin-bottom: 18px !important;
        }
        .fa-keyterms-card {
          border-radius: 22px !important;
          padding: 2px 20px !important;
        }
        .fa-keyterm-row {
          display: grid !important;
          grid-template-columns: 1fr !important;
          gap: 8px !important;
          padding: 20px 0 !important;
        }
        .fa-keyterm-title {
          font-size: 15px !important;
        }
        .fa-keyterm-content {
          max-width: none !important;
          font-size: 14.5px !important;
          line-height: 1.58 !important;
        }
      }
      @media (prefers-reduced-motion: reduce) {
        [data-page="fund-a"] * { animation: none !important; transition: none !important; }
      }
    `}</style>
  );
}

const BarIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
    <path d="M5 20V11M12 20V5M19 20v-7" stroke="#fff" strokeWidth="1.9" strokeLinecap="round" />
  </svg>
);

const ChipIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
    <rect x="7" y="7" width="10" height="10" rx="2.2" stroke="#fff" strokeWidth="1.8" />
    <rect x="10" y="10" width="4" height="4" rx="1" fill="#fff" />
    <path
      d="M9.5 3v2.5M14.5 3v2.5M9.5 18.5V21M14.5 18.5V21M3 9.5h2.5M3 14.5h2.5M18.5 9.5H21M18.5 14.5H21"
      stroke="#fff"
      strokeWidth="1.7"
      strokeLinecap="round"
    />
  </svg>
);

const CubeIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
    <path d="M12 3v18M5 8l7-5 7 5M5 8v8l7 5 7-5V8" stroke="#0e0e10" strokeWidth="1.8" strokeLinejoin="round" />
  </svg>
);

const ShieldIcon = ({ dark = false }: { dark?: boolean }) => (
  <svg width="23" height="23" viewBox="0 0 24 24" fill="none">
    <path
      d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3z"
      stroke={dark ? "#1d1d1f" : "#fff"}
      strokeWidth="1.7"
      strokeLinejoin="round"
    />
    <path
      d="M9 12l2 2 4-4"
      stroke={dark ? "#1d1d1f" : "#fff"}
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const SproutIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
    <path
      d="M12 21V10"
      stroke="#fff"
      strokeWidth="1.7"
      strokeLinecap="round"
    />
    <path
      d="M12 14C8.5 14 6.5 11.5 6.5 8 10 8 12 10.5 12 14Z"
      stroke="#fff"
      strokeWidth="1.6"
      strokeLinejoin="round"
    />
    <path
      d="M12 12C15.5 12 17.5 9.5 17.5 6 14 6 12 8.5 12 12Z"
      stroke="#fff"
      strokeWidth="1.6"
      strokeLinejoin="round"
    />
  </svg>
);

const BoltIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
    <path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z" stroke="#fff" strokeWidth="1.7" strokeLinejoin="round" />
  </svg>
);

const ArrowsIcon = () => (
  <svg width="23" height="23" viewBox="0 0 24 24" fill="none">
    <path
      d="M4 8h13l-3.5-3.5M20 16H7l3.5 3.5"
      stroke="#1d1d1f"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const FUND_A_SCHEMA: Record<string, unknown> = {
  "@context": "https://schema.org",
  "@type": "FinancialProduct",
  name: "HushhTech Fund A",
  url: "https://hushhtech.com/discover-fund-a",
  category: "Investment Fund",
  provider: {
    "@type": "Organization",
    name: "Hushh Technologies LLC",
    url: "https://hushhtech.com",
  },
  description:
    "Fund A is HushhTech's AI-driven, long-term value investing strategy - " +
    "disciplined capital allocation into exceptional businesses, modeled on " +
    "Berkshire Hathaway.",
};

const assetVisuals = [
  {
    tag: "Alpha 27",
    title: "Core Compounders",
    color: "#0071e3",
    icon: <ShieldIcon />,
  },
  {
    tag: "Aloha 27",
    title: "Humanity-Driven Growth",
    color: "#1d8a4f",
    icon: <SproutIcon />,
  },
  {
    tag: "Ultra 27",
    title: "High-Velocity Growth",
    color: "#7c3aed",
    icon: <BoltIcon />,
  },
];

const FundA = () => {
  const {
    targetIRRLabel,
    targetIRRValue,
    targetIRRPeriod,
    targetIRRDisclaimer,
    philosophySectionTitle,
    philosophyCards,
    edgeCards,
    assetFocusDescription,
    assetPillars,
    alphaStackSubtitle,
    alphaStackRows,
    riskCards,
    keyTermsSubtitle,
    keyTerms,
    shareClasses,
  } = useDiscoverFundALogic();

  const grossReturn =
    alphaStackRows.find((row) => row.label.toLowerCase().includes("gross"))
      ?.value ?? targetIRRValue;

  return (
    <div
      data-page="fund-a"
      className="min-h-screen bg-[#FFFFFF] text-[#1D1D1F] antialiased selection:bg-[#0066CC] selection:text-[#F5F5F7]"
      style={{ fontFamily: fundAFont }}
    >
      <FundAStyles />
      <SeoHead
        title="Fund A - AI-powered value investing"
        description="Fund A is HushhTech's AI-driven, long-term value strategy: disciplined capital allocation into exceptional businesses, modeled on Berkshire Hathaway."
        path="/discover-fund-a"
        jsonLd={FUND_A_SCHEMA}
      />
      <HushhTechHeader />

      <main id="main-content">
        <section className="fa-flagship" style={{ background: "#fff" }}>
          <div className="fa-flagship__inner">
            <Reveal className="fa-head-c">
              <div className="fa-flagship__intro">
                <div className="fa-eyebrow" style={{ color: "#0071e3", marginBottom: 18 }}>
                  Flagship Fund
                </div>
                <h2 className="fa-h2" style={{ color: "#1d1d1f" }}>
                  Hushh Fund A.
                </h2>
                <p
                  style={{
                    margin: "20px auto 0",
                    maxWidth: "46ch",
                    fontWeight: 400,
                    fontSize: "clamp(17px,1.6vw,20px)",
                    lineHeight: 1.5,
                    color: "rgba(0,0,0,.62)",
                  }}
                >
                  Our inaugural fund &mdash; an AI-driven value strategy built for consistent,
                  risk-adjusted alpha.
                </p>
              </div>
            </Reveal>
            <Reveal className="fa-head-c">
              <div className="fa-flagship__metric">
                <div className="fa-eyebrow" style={{ color: "#0071e3", marginBottom: 14 }}>
                  {targetIRRLabel}
                </div>
                <div
                  style={{
                    fontWeight: 700,
                    fontSize: "clamp(52px,8vw,92px)",
                    lineHeight: .98,
                    letterSpacing: "-.04em",
                    color: "#0071e3",
                  }}
                >
                  {targetIRRValue.replace("-", "–")}
                </div>
                <div style={{ marginTop: 10, fontSize: 15, color: "rgba(0,0,0,.5)" }}>
                  {targetIRRPeriod}
                </div>
                <p
                  style={{
                    margin: "22px auto 0",
                    maxWidth: "48ch",
                    fontSize: 13,
                    lineHeight: 1.5,
                    color: "rgba(0,0,0,.38)",
                  }}
                >
                  {targetIRRDisclaimer}
                </p>
              </div>
            </Reveal>
          </div>
        </section>

        <section className="fa-sec" style={{ background: "#000", color: "#fff" }}>
          <div style={{ maxWidth: 1200, margin: "0 auto" }}>
            <Reveal className="fa-head-c">
              <div style={{ maxWidth: 720, margin: "0 auto clamp(44px,6vw,64px)" }}>
                <div className="fa-eyebrow" style={{ color: "#2997ff", marginBottom: 18 }}>
                  Investment Philosophy
                </div>
                <h2 className="fa-h2">
                  {philosophySectionTitle.replace(/^Investment Philosophy:\s*/i, "")}
                </h2>
                <p
                  style={{
                    margin: "20px auto 0",
                    maxWidth: "50ch",
                    fontWeight: 300,
                    fontSize: "clamp(17px,1.5vw,20px)",
                    lineHeight: 1.5,
                    color: "rgba(255,255,255,.55)",
                  }}
                >
                  Three principles turn market noise into durable, market-independent returns.
                </p>
              </div>
            </Reveal>
            <Reveal className="fa-r3">
              {philosophyCards.map((card, index) => (
                <div
                  key={card.title}
                  className="fa-card fa-glow"
                  style={{
                    minHeight: 330,
                    padding: 34,
                    background: "#101114",
                    border: "1px solid rgba(255,255,255,.07)",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      marginBottom: 28,
                    }}
                  >
                    <span
                      style={{
                        width: 48,
                        height: 48,
                        borderRadius: 13,
                        background: index === 1 ? "#0071e3" : index === 2 ? "#fff" : "#1c1c1f",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        boxShadow: index === 1 ? "0 8px 20px rgba(0,113,227,.4)" : undefined,
                      }}
                    >
                      {index === 0 ? <BarIcon /> : index === 1 ? <ChipIcon /> : <CubeIcon />}
                    </span>
                    <span
                      style={{
                        fontSize: 13,
                        fontWeight: 700,
                        letterSpacing: ".14em",
                        color: "rgba(255,255,255,.32)",
                      }}
                    >
                      {String(index + 1).padStart(2, "0")}
                    </span>
                  </div>
                  <h3 style={{ margin: "0 0 10px", fontWeight: 600, fontSize: 22, letterSpacing: "-.01em" }}>
                    {card.title}
                  </h3>
                  <p
                    style={{
                      margin: 0,
                      fontSize: 15,
                      lineHeight: 1.55,
                      color: "rgba(255,255,255,.56)",
                    }}
                  >
                    {card.description}
                  </p>
                </div>
              ))}
            </Reveal>
          </div>
        </section>

        <section className="fa-sec" style={{ background: "#fff" }}>
          <div style={{ maxWidth: 980, margin: "0 auto" }}>
            <Reveal className="fa-head-c">
              <div style={{ maxWidth: 680, margin: "0 auto clamp(44px,6vw,60px)" }}>
                <div className="fa-eyebrow" style={{ color: "#0071e3", marginBottom: 18 }}>
                  Our Edge
                </div>
                <h2 className="fa-h2" style={{ color: "#1d1d1f" }}>
                  The Sell the Wall framework.
                </h2>
              </div>
            </Reveal>
            <Reveal>
              <div
                style={{
                  borderRadius: 28,
                  overflow: "hidden",
                  background: "#f6f7f9",
                  border: "1px solid rgba(0,0,0,.06)",
                  padding: "clamp(16px,2.5vw,30px) clamp(24px,3.5vw,46px)",
                }}
              >
                {edgeCards.map((card, index) => (
                  <div key={card.title}>
                    <div className="fa-framework-row">
                      <span className="fa-framework-num">{String(index + 1).padStart(2, "0")}</span>
                      <div>
                        <h3
                          style={{
                            margin: "0 0 7px",
                            fontWeight: 600,
                            fontSize: "clamp(20px,2.2vw,24px)",
                            letterSpacing: "-.01em",
                            color: "#1d1d1f",
                          }}
                        >
                          {card.title}
                        </h3>
                        <p style={{ margin: 0, fontSize: 16, lineHeight: 1.55, color: "rgba(0,0,0,.5)" }}>
                          {card.description}
                        </p>
                      </div>
                    </div>
                    {index < edgeCards.length - 1 ? (
                      <div style={{ height: 1, background: "rgba(0,0,0,.08)" }} />
                    ) : null}
                  </div>
                ))}
              </div>
            </Reveal>
          </div>
        </section>

        <section className="fa-sec" style={{ background: "#f5f5f7" }}>
          <div style={{ maxWidth: 1200, margin: "0 auto" }}>
            <Reveal className="fa-head-c">
              <div style={{ maxWidth: 760, margin: "0 auto clamp(44px,6vw,60px)" }}>
                <div className="fa-eyebrow" style={{ color: "#0071e3", marginBottom: 18 }}>
                  Asset Focus
                </div>
                <h2 className="fa-h2" style={{ color: "#1d1d1f" }}>
                  Three pillars. 81 global enterprises.
                </h2>
                <p
                  style={{
                    margin: "22px auto 0",
                    maxWidth: "44ch",
                    fontWeight: 300,
                    fontSize: "clamp(17px,1.7vw,21px)",
                    lineHeight: 1.45,
                    color: "rgba(0,0,0,.5)",
                  }}
                >
                  {assetFocusDescription.replace(
                    "Fund A applies its multi-strategy approach across three distinct, yet complementary, selections of ",
                    "Three complementary selections of ",
                  )}
                </p>
              </div>
            </Reveal>
            <Reveal className="fa-r3">
              {assetPillars.map((pillar, index) => {
                const visual = assetVisuals[index];
                return (
                  <div
                    key={pillar.title}
                    className="fa-card fa-lift"
                    style={{ padding: 30, background: "#fff", boxShadow: "0 1px 3px rgba(0,0,0,.05)" }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 24 }}>
                      <span
                        style={{
                          width: 40,
                          height: 40,
                          borderRadius: 11,
                          background: visual.color,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        {visual.icon}
                      </span>
                      <span
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 7,
                          padding: "5px 12px",
                          borderRadius: 980,
                          background: `${visual.color}1A`,
                        }}
                      >
                        <span style={{ width: 6, height: 6, borderRadius: "50%", background: visual.color }} />
                        <span
                          style={{
                            fontSize: 11,
                            fontWeight: 600,
                            letterSpacing: ".08em",
                            color: visual.color,
                            textTransform: "uppercase",
                          }}
                        >
                          {visual.tag}
                        </span>
                      </span>
                    </div>
                    <h3
                      style={{
                        margin: "0 0 12px",
                        fontWeight: 600,
                        fontSize: 21,
                        letterSpacing: "-.01em",
                        color: "#1d1d1f",
                      }}
                    >
                      {visual.title}
                    </h3>
                    <p style={{ margin: 0, fontSize: 15, lineHeight: 1.5, color: "rgba(0,0,0,.5)" }}>
                      {pillar.description}
                    </p>
                  </div>
                );
              })}
            </Reveal>
          </div>
        </section>

        <section className="fa-sec" style={{ background: "#000", color: "#fff" }}>
          <div style={{ maxWidth: 1100, margin: "0 auto" }}>
            <Reveal className="fa-head-c">
              <div style={{ maxWidth: 760, margin: "0 auto clamp(44px,6vw,60px)" }}>
                <div className="fa-eyebrow" style={{ color: "#2997ff", marginBottom: 18 }}>
                  Alpha Stack
                </div>
                <h2 className="fa-h2">Targeted returns, broken down.</h2>
                <p
                  style={{
                    margin: "20px auto 0",
                    fontWeight: 300,
                    fontSize: "clamp(16px,1.7vw,20px)",
                    lineHeight: 1.45,
                    color: "rgba(255,255,255,.5)",
                  }}
                >
                  {alphaStackSubtitle}
                </p>
              </div>
            </Reveal>
            <Reveal>
              <div
                style={{
                  background: "#0e0e10",
                  border: "1px solid rgba(255,255,255,.07)",
                  borderRadius: 24,
                  padding: "8px clamp(20px,3vw,40px)",
                }}
              >
                {alphaStackRows
                  .filter((row) => !row.isTotalRow)
                  .map((row) => (
                    <div
                      key={row.label}
                      style={{
                        padding: "22px 0",
                        borderBottom: "1px solid rgba(255,255,255,.08)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 16,
                      }}
                    >
                      <div>
                        <div style={{ fontWeight: 600, fontSize: "clamp(16px,1.8vw,19px)", letterSpacing: "-.01em" }}>
                          {row.label}
                        </div>
                        <div style={{ marginTop: 4, fontSize: 13, color: "rgba(255,255,255,.42)" }}>
                          Illustrative annual contribution
                        </div>
                      </div>
                      <div
                        style={{
                          flex: "none",
                          fontWeight: 600,
                          fontSize: "clamp(20px,2.4vw,26px)",
                          letterSpacing: "-.02em",
                        }}
                      >
                        {row.value.replace("-", "–")}
                      </div>
                    </div>
                  ))}
                <div
                  style={{
                    padding: "24px clamp(16px,2vw,24px)",
                    margin: "8px -8px 0",
                    borderRadius: 18,
                    background: "rgba(255,255,255,.04)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 16,
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 700, fontSize: "clamp(17px,1.9vw,20px)", letterSpacing: "-.01em" }}>
                      Total Gross
                    </div>
                    <div style={{ marginTop: 4, fontSize: 13, color: "rgba(255,255,255,.42)" }}>
                      Illustrative annual contribution
                    </div>
                  </div>
                  <div
                    style={{
                      flex: "none",
                      fontWeight: 700,
                      fontSize: "clamp(22px,2.6vw,30px)",
                      letterSpacing: "-.02em",
                      color: "#30d673",
                    }}
                  >
                    {grossReturn.replace("-", "–")}
                  </div>
                </div>
              </div>
            </Reveal>
          </div>
        </section>

        <section className="fa-sec" style={{ background: "#fff" }}>
          <div style={{ maxWidth: 1080, margin: "0 auto" }}>
            <Reveal className="fa-head-c">
              <div style={{ maxWidth: 700, margin: "0 auto clamp(44px,6vw,60px)" }}>
                <div className="fa-eyebrow" style={{ color: "#0071e3", marginBottom: 18 }}>
                  Risk &amp; Liquidity
                </div>
                <h2 className="fa-h2" style={{ color: "#1d1d1f" }}>
                  Disciplined risk. Assured liquidity.
                </h2>
              </div>
            </Reveal>
            <Reveal className="fa-r2">
              {riskCards.map((card, index) => (
                <div key={card.title} className="fa-card fa-lift" style={{ padding: 38, background: "#f5f5f7" }}>
                  <span
                    style={{
                      width: 48,
                      height: 48,
                      borderRadius: 13,
                      background: "#fff",
                      boxShadow: "0 4px 14px rgba(0,0,0,.07)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      marginBottom: 26,
                    }}
                  >
                    {index === 0 ? <ShieldIcon dark /> : <ArrowsIcon />}
                  </span>
                  <h3 style={{ margin: "0 0 12px", fontWeight: 600, fontSize: 23, letterSpacing: "-.01em", color: "#1d1d1f" }}>
                    {card.title}
                  </h3>
                  <p style={{ margin: 0, fontSize: 16, lineHeight: 1.5, color: "rgba(0,0,0,.5)" }}>
                    {card.description}
                  </p>
                </div>
              ))}
            </Reveal>
          </div>
        </section>

        <section className="fa-sec" style={{ background: "#f5f5f7" }}>
          <div style={{ maxWidth: 1200, margin: "0 auto" }}>
            <Reveal className="fa-head-c">
              <div style={{ maxWidth: 780, margin: "0 auto clamp(40px,5vw,56px)" }}>
                <div className="fa-eyebrow" style={{ color: "#0071e3", marginBottom: 18 }}>
                  Key Terms
                </div>
                <h2 className="fa-h2" style={{ color: "#1d1d1f" }}>
                  How the fund is structured.
                </h2>
                <p style={{ margin: "18px auto 0", maxWidth: "52ch", fontSize: 14, lineHeight: 1.5, color: "rgba(0,0,0,.4)" }}>
                  {keyTermsSubtitle}
                </p>
              </div>
            </Reveal>
            <Reveal>
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  letterSpacing: ".12em",
                  textTransform: "uppercase",
                  color: "rgba(0,0,0,.45)",
                  marginBottom: 18,
                }}
              >
                Share Classes
              </div>
            </Reveal>
            <Reveal className="fa-r3">
              {shareClasses.map((shareClass) => (
                <div
                  key={shareClass.shareClass}
                  className="fa-card fa-lift fa-share-card"
                  style={{ padding: 30, background: "#fff", boxShadow: "0 1px 3px rgba(0,0,0,.05)" }}
                >
                  <div
                    className="fa-share-card__head"
                    style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, marginBottom: 22 }}
                  >
                    <span style={{ fontWeight: 600, fontSize: 24, letterSpacing: "-.02em", color: "#1d1d1f" }}>
                      {shareClass.shareClass}
                    </span>
                    <span
                      style={{
                        fontSize: 12,
                        fontWeight: 600,
                        color: "#0071e3",
                        background: "rgba(0,113,227,.1)",
                        padding: "5px 12px",
                        borderRadius: 980,
                      }}
                    >
                      Min {shareClass.minInvestment}
                    </span>
                  </div>
                  {[
                    ["Management fee", shareClass.managementFee],
                    ["Performance fee", shareClass.performanceFee],
                    ["Hurdle rate", shareClass.hurdleRate],
                  ].map(([label, value]) => (
                    <div
                      key={label}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        gap: 16,
                        padding: "13px 0",
                        borderTop: "1px solid rgba(0,0,0,.07)",
                      }}
                    >
                      <span style={{ fontSize: 14, color: "rgba(0,0,0,.5)" }}>{label}</span>
                      <span style={{ fontWeight: 600, fontSize: 20, color: "#1d1d1f" }}>{value}</span>
                    </div>
                  ))}
                </div>
              ))}
            </Reveal>
            <Reveal>
              <div
                className="fa-keyterms-card"
                style={{
                  marginTop: 20,
                  background: "#fff",
                  borderRadius: 24,
                  boxShadow: "0 1px 3px rgba(0,0,0,.05)",
                  padding: "8px clamp(22px,3vw,38px)",
                }}
              >
                {keyTerms.map((term, index) => (
                  <div
                    key={term.title}
                    className="fa-keyterm-row"
                    style={{
                      padding: "22px 0",
                      borderBottom: index < keyTerms.length - 1 ? "1px solid rgba(0,0,0,.07)" : undefined,
                    }}
                  >
                    <span className="fa-keyterm-title">
                      {term.title}
                    </span>
                    <span className="fa-keyterm-content">
                      {term.content}
                    </span>
                  </div>
                ))}
              </div>
            </Reveal>
          </div>
        </section>
      </main>

      <HushhTechFooter activeTab={HushhFooterTab.FUND_A} />
    </div>
  );
};

export default FundA;
