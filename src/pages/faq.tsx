import React from "react";
import { Link } from "react-router-dom";
import HushhTechHeader from "../components/hushh-tech-header/HushhTechHeader";
import HushhTechFooter from "../components/hushh-tech-footer/HushhTechFooter";
import SeoHead from "../components/seo/SeoHead";
import {
  AppleSection,
  Display,
  Eyebrow,
  Lede,
  PillButton,
  appleFont,
} from "../components/hushh-tech-ui/HushhAppleUI";

interface FaqItem {
  question: string;
  answer: string;
}

interface FaqCategory {
  label: string;
  summary: string;
  items: FaqItem[];
}

const faqCategories: FaqCategory[] = [
  {
    label: "Strategy & Returns",
    summary: "How we invest and where long-term value comes from.",
    items: [
      {
        question: "How does Hushh Technologies ensure its investment strategies align with long-term value creation?",
        answer: "At Hushh, we’re playing the long game. Every strategy we deploy is designed with sustainability in mind. We don’t just focus on short-term gains or trendy assets. Instead, we ground ourselves in businesses with robust cash flows, a strong competitive advantage, and a clear path for compounding growth. Our approach is built on options income, volatility capture, and disciplined dividend reinvestment in market leaders. It’s about making smart, calculated moves that allow us to grow steadily over time, and all our models are built to withstand a variety of market conditions. In short, we’re not interested in chasing the next big thing—we’re here to build something that lasts."
      },
      {
        question: "How does Hushh differentiate itself from traditional investment firms? What’s the “moat” here?",
        answer: "Our moat is threefold: our technology, our commitment to human-first principles, and our adaptability. Traditional firms are often tied to legacy systems and rigid structures, while we’re built for agility. We leverage cutting-edge AI and machine learning in ways that larger, more bureaucratic firms simply can’t match. Our focus on making data work for individuals—turning it into a genuine personal asset—isn’t just innovative; it’s transformative. Add to that our dedication to transparency and ethical business practices, and you’ve got a platform that stands apart in a world dominated by transactional relationships."
      },
      {
        question: "What types of assets do you invest in?",
        answer: "We maintain a diversified approach across multiple asset classes including equities, fixed income, alternatives, and derivatives. Our AI models are designed to identify opportunities across global markets and various sectors. The specific allocation depends on market conditions, risk parameters, and individual client objectives."
      }
    ]
  },
  {
    label: "Risk & Trust",
    summary: "How we protect capital and earn lasting confidence.",
    items: [
      {
        question: "What are the key risk management protocols that Hushh has in place?",
        answer: "We manage risk with the same precision that we seek in returns. Every strategy is safeguarded by a few core principles: diversification, position limits, and stop-loss triggers. We never allow ourselves to be overexposed in a single sector or asset, and we’re relentless about preserving capital. Options, by nature, introduce leverage and exposure, so we’ve built guardrails to prevent excessive risk-taking. Think of it like an artist using the finest brushstrokes—controlled, intentional, and designed to minimize waste. We know that wealth preservation is as crucial as wealth generation, and we’re fanatical about protecting what we’ve built."
      },
      {
        question: "Why should investors trust that Hushh’s results are sustainable over time?",
        answer: "Trust comes from discipline, and our discipline is unbreakable. We’re not just achieving returns by chasing the latest market trends; we’re doing it through structured, data-driven strategies that have proven resilient over time. Our options income strategy, our focus on high-free-cash-flow stocks, and our conservative approach to volatility capture are built to endure. We’re not promising the moon—we’re focused on realistic, consistent growth. Just as Apple created products that people could rely on, we’re creating a financial ecosystem that people can count on, year in and year out."
      },
      {
        question: "How does Hushh plan to handle downturns or market corrections?",
        answer: "Market corrections are a given, and we don’t shy away from that reality. Our strategies are inherently defensive, with built-in risk management features that prioritize capital preservation. During downturns, we lean heavily on our dividend-compounding assets, which provide stability, and we adjust our options strategies to minimize exposure. The beauty of our approach is that we’re not reliant on bull markets to create value. Our focus on fundamentals and disciplined risk protocols allows us to stay resilient. In fact, volatility often creates the very opportunities we’re structured to capture."
      },
      {
        question: "What’s the biggest risk you’re willing to take, and why?",
        answer: "The biggest risk we’re willing to take is betting on the intelligence and autonomy of our users. We believe people are smarter and more capable than they’re often given credit for. By empowering them with the right tools, insights, and control over their data, we’re stepping away from the traditional “trust us, we know best” model. It’s a leap of faith, but it’s one we believe will pay off. Our users are our greatest asset, and betting on them to succeed is a risk we’re proud to take."
      }
    ]
  },
  {
    label: "Data & Technology",
    summary: "How we use data and stay human-first as we build.",
    items: [
      {
        question: "You talk about putting data to work for people. How does Hushh use data in a way that’s ethical and human-first?",
        answer: "This is the core of what Hushh stands for. Data is powerful, but only when it serves people, not exploits them. Every data-driven decision we make is built around empowering our users and investors. We’re not in the business of selling data or compromising privacy. Our AI models are designed to find inefficiencies, identify opportunities, and help us deliver consistent value—all while respecting user privacy. In essence, we use data as a tool to benefit our stakeholders, not as a product. We believe that wealth creation should never come at the cost of trust."
      },
      {
        question: "How do you ensure Hushh remains innovative and adaptable as it grows?",
        answer: "Adaptability is in our DNA. The key is to stay curious and never assume we have it all figured out. We’re constantly refining our models, experimenting with new data sources, and pushing the limits of what our AI can do. Like Steve Jobs always sought perfection through iteration, we’re obsessive about improvement. Innovation doesn’t mean adding complexity; sometimes, it means simplifying even further. Our approach to adaptability is to stay lean, stay focused, and always look for ways to deliver more value without sacrificing the core principles that define us."
      },
      {
        question: "What does Hushh’s commitment to “human-first” actually look like in practice?",
        answer: "Being “human-first” isn’t a slogan for us—it’s a fundamental operational principle. Every decision we make has to answer the question: “Does this serve our users and investors?” For example, our privacy policies are designed to give users control over their data, not just because it’s compliant, but because it’s the right thing to do. Our platform features are designed to educate, empower, and support, not overwhelm or manipulate. In practical terms, “human-first” means transparency, simplicity, and a commitment to integrity in every interaction we have with our users and stakeholders"
      }
    ]
  },
  {
    label: "Company",
    summary: "How we grow, hire, and stay true to our mission.",
    items: [
      {
        question: "What’s the biggest challenge Hushh faces, and how do you plan to address it?",
        answer: "Our biggest challenge is managing growth without losing our soul. We’re gaining traction fast, and with that comes the risk of diluting our values as we scale. To address this, we’re committed to a few non-negotiables: transparency, ethical data use, and a human-centered approach. We’re building a strong core team that not only understands finance but is also deeply aligned with our vision. As we grow, we’ll be deliberate about who joins the Hu$$h family, ensuring that every addition strengthens our values rather than compromises them. Growth is only meaningful if it’s rooted in integrity."
      },
      {
        question: "How will Hushh continue to attract and retain top talent as it scales?",
        answer: "Talent is the backbone of any great company, and we’re committed to building a team of “learn-it-alls,” not “know-it-alls.” We look for people who are hungry, curious, and aligned with our mission. Our culture is built on transparency, accountability, and a love for innovation. We don’t just offer jobs; we offer a chance to be part of a movement that’s reshaping wealth creation. Like Apple’s approach to product design, we believe in investing in people who believe in our vision, creating an environment that fosters both excellence and creativity."
      },
      {
        question: "If Hushh could only achieve one thing, what would it be?",
        answer: "To redefine wealth as something personal, empowering, and accessible. At the end of the day, we’re here to make sure that every person can see their data as an asset they own and control. If we can shift the world’s perspective—even a little—toward that vision, we’ll have succeeded beyond measure. We’re not just creating financial returns; we’re creating a legacy where data-driven wealth is human-centered and inclusive."
      }
    ]
  }
];

// Flatten for stable, page-unique indices so single-open behaviour spans all
// categories (only one panel open at a time across the entire page).
const flatFaqs: FaqItem[] = faqCategories.flatMap((category) => category.items);

/**
 * FAQPage structured data, built from the same array the page renders.
 *
 * These questions and answers already existed here; nothing pointed a search engine at them, so
 * they were never eligible for an FAQ rich result. Generating the schema from faqCategories keeps
 * it honest — the markup can never describe answers the page does not show.
 */
const FAQ_SCHEMA = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: flatFaqs.map((faq) => ({
    "@type": "Question",
    name: faq.question,
    acceptedAnswer: { "@type": "Answer", text: faq.answer },
  })),
};

const FaqPage: React.FC = () => {
  const [openIndex, setOpenIndex] = React.useState<number | null>(null);
  const [activeCategory, setActiveCategory] = React.useState<string>("All");

  const toggleAccordion = (index: number) => {
    setOpenIndex(openIndex === index ? null : index);
  };

  const tabs = ["All", ...faqCategories.map((category) => category.label)];
  const visibleCategories =
    activeCategory === "All"
      ? faqCategories
      : faqCategories.filter((category) => category.label === activeCategory);

  return (
    <div
      className="min-h-screen bg-white text-[#1D1D1F] antialiased selection:bg-[#0066CC] selection:text-white"
      style={{ fontFamily: appleFont }}
    >
      <SeoHead
        title="Frequently asked questions"
        description="Common questions about HushhTech, Fund A, eligibility, fees and how the investment process works."
        path="/faq"
        jsonLd={FAQ_SCHEMA}
      />
      <HushhTechHeader />

      <main id="main-content">
        <AppleSection tone="light" pad="normal">
          <Eyebrow>Support</Eyebrow>
          <Display as="h1" size="md" maxWidth="max-w-[720px]">
            FAQ
          </Display>
          <Lede>
            Find answers to common questions about our investment strategies,
            processes, and services.
          </Lede>

          {/* Centered category filter pills */}
          <div className="mx-auto mt-9 flex max-w-[760px] flex-wrap items-center justify-center gap-2 px-5">
            {tabs.map((tab) => {
              const active = activeCategory === tab;
              return (
                <button
                  key={tab}
                  type="button"
                  onClick={() => {
                    setActiveCategory(tab);
                    setOpenIndex(null);
                  }}
                  aria-pressed={active}
                  className={`rounded-full px-4 py-2 text-[13px] font-medium tracking-[-0.01em] transition ${
                    active
                      ? "bg-[#0066CC] text-white shadow-[0_6px_16px_rgba(0,102,204,0.22)]"
                      : "bg-[#1D1D1F]/[0.05] text-[#1D1D1F]/65 hover:bg-[#1D1D1F]/[0.09]"
                  }`}
                >
                  {tab}
                </button>
              );
            })}
          </div>
        </AppleSection>

        <AppleSection tone="light" pad="normal" className="!pt-0">
          <div className="mx-auto w-full max-w-[760px] px-5">
            {visibleCategories.map((category, idx) => (
              <section key={category.label} className={idx === 0 ? "" : "mt-12"}>
                {activeCategory === "All" && (
                  <div className="mb-6 text-center">
                    <h2 className="text-[12px] font-semibold uppercase tracking-[0.14em] text-[#0066CC]">
                      {category.label}
                    </h2>
                    <p className="mx-auto mt-2 max-w-[520px] text-[14px] font-normal leading-snug text-[#1D1D1F]/55">
                      {category.summary}
                    </p>
                  </div>
                )}

                <ul className="flex flex-col gap-3" role="list">
                  {category.items.map((faq) => {
                    const index = flatFaqs.indexOf(faq);
                    const isOpen = openIndex === index;
                    const panelId = `faq-panel-${index}`;
                    const triggerId = `faq-trigger-${index}`;

                    return (
                      <li
                        key={index}
                        className={`overflow-hidden rounded-[18px] bg-white ring-1 transition-shadow duration-200 ${
                          isOpen
                            ? "ring-[#1D1D1F]/[0.12] shadow-[0_14px_40px_rgba(29,29,31,0.07)]"
                            : "ring-[#1D1D1F]/[0.08] shadow-[0_2px_10px_rgba(29,29,31,0.03)] hover:ring-[#1D1D1F]/[0.14]"
                        }`}
                      >
                        <h3 className="m-0">
                          <button
                            type="button"
                            id={triggerId}
                            aria-expanded={isOpen}
                            aria-controls={panelId}
                            onClick={() => toggleAccordion(index)}
                            className="flex w-full items-start justify-between gap-4 px-5 py-5 text-left transition-colors duration-200 hover:bg-[#1D1D1F]/[0.015] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0066CC]/40 md:px-6 md:py-6"
                          >
                            <span className="flex-1 text-[16px] font-semibold leading-snug tracking-[-0.01em] text-[#1D1D1F] md:text-[17px]">
                              {faq.question}
                            </span>
                            <span
                              aria-hidden="true"
                              className={`mt-1 shrink-0 text-[#86868B] transition-transform duration-200 ${
                                isOpen ? "rotate-180" : ""
                              }`}
                            >
                              <svg
                                width="16"
                                height="16"
                                viewBox="0 0 16 16"
                                fill="none"
                              >
                                <path
                                  d="M4 6l4 4 4-4"
                                  stroke="currentColor"
                                  strokeWidth="1.8"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                />
                              </svg>
                            </span>
                          </button>
                        </h3>

                        {isOpen && (
                          <div
                            id={panelId}
                            role="region"
                            aria-labelledby={triggerId}
                            className="border-t border-[#1D1D1F]/[0.07] px-5 pb-5 pt-4 text-[15px] font-normal leading-[1.65] text-[#1D1D1F]/68 md:px-6 md:pb-6 md:text-[16px]"
                          >
                            {faq.answer}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        </AppleSection>

        <AppleSection tone="dark" pad="normal" last>
          <Eyebrow tone="dark">Still have questions?</Eyebrow>
          <Display as="h2" size="sm" tone="dark" maxWidth="max-w-[600px]">
            We’re here to help.
          </Display>
          <Lede tone="dark">
            Reach out and our team will get back to you with the answers you need.
          </Lede>
          <div className="mt-8 flex justify-center px-5">
            <Link to="/contact">
              <PillButton tone="dark" kind="filled">
                Contact Us
              </PillButton>
            </Link>
          </div>
        </AppleSection>
      </main>

      <HushhTechFooter />
    </div>
  );
};

export default FaqPage;
