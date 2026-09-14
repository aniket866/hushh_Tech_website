import React from "react";
import {
  BadgeDollarSign,
  Check,
  HeartPulse,
  Leaf,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import HushhTechHeader from "../../components/hushh-tech-header/HushhTechHeader";
import HushhTechFooter from "../../components/hushh-tech-footer/HushhTechFooter";
import {
  AppleSection,
  Display,
  Eyebrow,
  Lede,
  PillButton,
  appleDisplayFont,
  appleFont,
} from "../../components/hushh-tech-ui/HushhAppleUI";

type BenefitCategory = {
  icon: LucideIcon;
  title: string;
  items: string[];
};

const benefitCategories: BenefitCategory[] = [
  {
    icon: BadgeDollarSign,
    title: "Compensation & Investment Opportunities",
    items: [
      "Competitive base salaries benchmarked to top-tier firms",
      "Access to proprietary investment strategies",
      "Performance-based bonuses tied to individual and company success",
      "401(k) with generous company matching",
      "Equity participation in company growth",
      "Financial planning and investment advisory services",
    ],
  },
  {
    icon: HeartPulse,
    title: "Health, Wellness & Family Support",
    items: [
      "Premium health, dental, and vision insurance (100% company paid)",
      "Generous parental leave policies",
      "Mental health and wellness programs",
      "Childcare assistance and family support services",
      "On-site fitness facilities and wellness stipend",
      "Comprehensive life and disability insurance",
    ],
  },
  {
    icon: Leaf,
    title: "Work-Life, Growth & Giving Back",
    items: [
      "Flexible work arrangements and remote work options",
      "Conference attendance and continuing education support",
      "Unlimited PTO policy with minimum usage requirements",
      "Internal mentorship and leadership development programs",
      "Sabbatical opportunities for long-term employees",
      "Charitable giving matching program",
      "Professional development budget ($10,000+ annually)",
      "Volunteer time off for community service",
    ],
  },
  {
    icon: Sparkles,
    title: "Perks, Culture & Quality of Life",
    items: [
      "State-of-the-art office spaces with premium amenities",
      "Team events, retreats, and cultural activities",
      "Catered meals and premium coffee/snacks",
      "Innovation time for personal projects",
    ],
  },
];

function BenefitIcon({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <span className="inline-flex h-14 w-14 shrink-0 items-center justify-center rounded-[18px] border border-white/[0.12] bg-white/[0.06] text-[#2997FF] shadow-[inset_0_1px_0_rgba(255,255,255,0.10)]">
      <Icon className="h-6 w-6" strokeWidth={1.9} aria-hidden />
    </span>
  );
}

function BenefitCard({ icon, title, items }: BenefitCategory) {
  return (
    <section className="h-full rounded-[22px] border border-white/[0.08] bg-[#0E0E10] p-6 transition duration-300 hover:-translate-y-1.5 hover:border-[#2997FF]/45 sm:p-7">
      <div className="mb-5 flex flex-col items-start gap-4 text-left sm:flex-row sm:items-center">
        <BenefitIcon icon={icon} />
        <h3
          className="text-[23px] font-semibold leading-[1.1] tracking-[-0.022em] text-white sm:text-[27px]"
          style={{ fontFamily: appleDisplayFont }}
        >
          {title}
        </h3>
      </div>
      <ul className="grid grid-cols-1 gap-x-6 gap-y-3 sm:gap-y-3.5 md:grid-cols-2 md:gap-y-4">
        {items.map((item) => (
          <li key={item} className="flex items-start gap-3.5">
            <Check
              className="mt-[3px] h-5 w-5 shrink-0 text-[#2997FF]"
              aria-hidden
            />
            <p className="text-[15px] font-light leading-relaxed text-white/60">
              {item}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

const BenefitsPage: React.FC = () => {
  return (
    <div
      data-page="benefits"
      className="bg-white antialiased text-[#1D1D1F] selection:bg-[#0066CC] selection:text-white"
      style={{ fontFamily: appleFont }}
    >
      <HushhTechHeader />

      <main id="main-content">
        {/* Hero — light */}
        <AppleSection tone="light" pad="loose">
          <Eyebrow>Benefits</Eyebrow>
          <Display as="h1" size="md" maxWidth="max-w-[760px]">
            World-Class Benefits for World-Class Talent.
          </Display>
          <Lede>
            We believe that exceptional people deserve exceptional benefits. Our
            comprehensive package is designed to support your professional
            growth, personal wellbeing, and financial future.
          </Lede>
        </AppleSection>

        {/* Benefit categories — dark */}
        <AppleSection tone="dark" pad="loose">
          <div className="relative z-[1] mx-auto max-w-[1100px]">
            <Eyebrow tone="dark">What's Included</Eyebrow>
            <Display tone="dark" size="sm" maxWidth="max-w-[640px]">
              Everything you need to do your best work.
            </Display>
            <Lede tone="dark">
              Four pillars of support — compensation, wellbeing, growth, and
              culture — built for the long term.
            </Lede>

            <div className="mt-12 grid grid-cols-1 gap-4 px-5 sm:gap-5 md:px-6 lg:grid-cols-2 lg:items-stretch lg:gap-6">
              {benefitCategories.map((category) => (
                <BenefitCard key={category.title} {...category} />
              ))}
            </div>
          </div>
        </AppleSection>

        {/* Why Join — light, final section before footer */}
        <AppleSection tone="light" pad="loose" last>
          <Eyebrow>Careers</Eyebrow>
          <Display size="sm" maxWidth="max-w-[600px]">
            Why Join Hushh Technologies?
          </Display>
          <Lede>
            At Hushh Technologies, you'll be part of a team that's
            revolutionizing the investment industry through cutting-edge AI and
            quantitative methods. You'll work alongside brilliant minds, solve
            complex challenges, and directly impact the future of finance while
            enjoying unparalleled benefits and growth opportunities.
          </Lede>

          <div className="mt-9 flex justify-center px-5">
            <a href="/career">
              <PillButton kind="filled">View Open Positions</PillButton>
            </a>
          </div>
        </AppleSection>
      </main>

      <HushhTechFooter />
    </div>
  );
};

export default BenefitsPage;
