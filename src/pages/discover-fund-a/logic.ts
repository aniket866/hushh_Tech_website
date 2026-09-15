import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';

import { FINANCIAL_LINK_ROUTE } from '../../services/onboarding/flow';

export interface ShareClassRow {
  shareClass: string;
  minInvestment: string;
  managementFee: string;
  performanceFee: string;
  hurdleRate: string;
}

export interface AlphaStackRow {
  label: string;
  value: string;
  isTotalRow?: boolean;
}

export interface PhilosophyCard {
  title: string;
  description: string;
}

export interface EdgeCard {
  title: string;
  description: string;
}

export interface AssetPillar {
  title: string;
  description: string;
}

export interface RiskCard {
  title: string;
  description: string;
}

export interface KeyTerm {
  title: string;
  content: string;
}

export interface UseDiscoverFundALogicReturn {
  heroTitle: string;
  heroSubtitle: string;
  heroDescription: string;
  targetIRRLabel: string;
  targetIRRValue: string;
  targetIRRPeriod: string;
  targetIRRDisclaimer: string;
  philosophySectionTitle: string;
  philosophyCards: PhilosophyCard[];
  edgeSectionTitle: string;
  sellTheWallHref: string;
  edgeCards: EdgeCard[];
  assetFocusSectionTitle: string;
  assetFocusDescription: string;
  assetPillars: AssetPillar[];
  alphaStackSectionTitle: string;
  alphaStackSubtitle: string;
  alphaStackRows: AlphaStackRow[];
  riskSectionTitle: string;
  riskCards: RiskCard[];
  keyTermsSectionTitle: string;
  keyTermsSubtitle: string;
  keyTerms: KeyTerm[];
  shareClasses: ShareClassRow[];
  joinSectionTitle: string;
  joinSectionDescription: string;
  joinButtonLabel: string;
  handleCompleteProfile: () => void;
}

export const useDiscoverFundALogic = (): UseDiscoverFundALogicReturn => {
  const navigate = useNavigate();

  const handleCompleteProfile = useCallback(() => {
    navigate(FINANCIAL_LINK_ROUTE);
  }, [navigate]);

  const philosophyCards: PhilosophyCard[] = [
    {
      title: 'Data as an Asset',
      description:
        'We monetize volatility and information asymmetry through advanced behavioral modeling, macro awareness, and systematic execution.',
    },
    {
      title: 'AI-Enhanced Decisions',
      description:
        'Proprietary AI tools optimize every stage, from asset selection to trade execution and risk management, amplifying our ability to capture market-independent returns.',
    },
    {
      title: 'Targeting Equilibrium',
      description:
        'Balancing aggressive alpha generation with disciplined risk control to compound steadily through every market cycle.',
    },
  ];

  const edgeCards: EdgeCard[] = [
    {
      title: 'Systematically Sell Premium',
      description:
        'Write puts and calls typically 5 strikes above and below the current market price on each of our 27 core holdings.',
    },
    {
      title: 'Maximize Decay',
      description:
        'Employ a weekly-to-annual laddering of short options to capture theta (time decay) and vega (volatility) decay.',
    },
    {
      title: 'Maintain Delta-Neutrality',
      description:
        'Utilize automated rebalancing to keep net delta near zero, ensuring profits primarily from volatility harvesting and time decay, not market direction.',
    },
    {
      title: 'Strategic Accumulation & Income',
      description:
        'Enable accumulation of shares in elite companies at discounted prices (via put assignment) and generate consistent cash flow from market fluctuations.',
    },
  ];

  const assetPillars: AssetPillar[] = [
    {
      title: 'Alpha 27: Core Compounders',
      description:
        'Focus on FCF "machines" with wide moats and proven AI integration (e.g., AAPL, MSFT, BRK.B, NVDA).',
    },
    {
      title: 'Aloha 27: ESG & Humanity-Driven Growth',
      description:
        'Companies addressing critical global needs (energy, health, inclusion) with strong ESG credentials and AI-enabled impact (e.g., NEE, VTRS, DHR, MA).',
    },
    {
      title: 'Ultra 27: High-Velocity, Quant-Backed Growth',
      description:
        'AI disruptors, cutting-edge biotech, emerging market leaders, and digital finance innovators (e.g., SNOW, PLTR, MRNA, MELI).',
    },
  ];

  const alphaStackRows: AlphaStackRow[] = [
    { label: 'Options Premium (Sell the Wall - Theta/Vega)', value: '4-5%' },
    { label: 'Equity Appreciation (Core Holdings CAGR)', value: '10-12%' },
    { label: 'AI / Execution Efficiency Alpha', value: '4-6%' },
    { label: 'Total Expected Gross Return', value: '18-23%' },
    { label: 'Target Net IRR (Post-Fees & Expenses)', value: '18-23%', isTotalRow: true },
  ];

  const riskCards: RiskCard[] = [
    {
      title: 'Robust Framework',
      description:
        'Multi-leg hedges, AI-driven volatility forecasting, stringent exposure caps (sector, country, correlation), and tight controls on leverage, position sizing, and portfolio VaR. Core equities serve as high-quality collateral for risk-managed leverage.',
    },
    {
      title: 'Market Position',
      description:
        'Targeting high-liquidity, large-cap equities with deep options chains, ensuring positions are tradable within 90 days under normal market scenarios. Quarterly redemptions after initial 12-month lock-up (soft).',
    },
  ];

  const keyTerms: KeyTerm[] = [
    {
      title: 'Fund Vehicle',
      content: 'Hushh Technologies Renaissance AI Fund A (Master-Feeder Structure)',
    },
    {
      title: 'Investor Eligibility',
      content: 'Accredited Investors & Qualified Purchasers (per SEC Reg D 506(c) & ICA 3(c)(7))',
    },
    {
      title: 'Liquidity',
      content: 'Quarterly redemptions after initial 12-month lock-up (soft)',
    },
    {
      title: 'Offering status',
      content:
        'Any offering is subject to investor eligibility, definitive offering documents, and final review by qualified securities counsel. No regulatory approval is represented.',
    },
  ];

  const shareClasses: ShareClassRow[] = [
    {
      shareClass: 'Class A',
      minInvestment: '$25M',
      managementFee: '1%',
      performanceFee: '15%',
      hurdleRate: '12%',
    },
    {
      shareClass: 'Class B',
      minInvestment: '$5M',
      managementFee: '1.5%',
      performanceFee: '15%',
      hurdleRate: '10%',
    },
    {
      shareClass: 'Class C',
      minInvestment: '$1M',
      managementFee: '1.5%',
      performanceFee: '25%',
      hurdleRate: '8%',
    },
  ];

  return {
    heroTitle: 'Hushh Fund A:',
    heroSubtitle: 'AI-Powered Multi-Strategy Alpha.',
    heroDescription:
      'Our inaugural fund, demonstrating an AI-driven value investing strategy designed to deliver consistent, market-beating returns and sustainable, risk-adjusted alpha.',
    targetIRRLabel: 'Target Net IRR',
    targetIRRValue: '18-23%',
    targetIRRPeriod: 'Annually*',
    targetIRRDisclaimer:
      '*Inspired by natural equilibrium and proven quantitative strategies. Refer to PPM for full details.',
    philosophySectionTitle: 'Investment Philosophy: Data. Volatility. Alpha.',
    philosophyCards,
    edgeSectionTitle: 'Our Edge: The',
    sellTheWallHref: '/sell-the-wall',
    edgeCards,
    assetFocusSectionTitle: 'Asset Focus: Three Pillars of Global Enterprises',
    assetFocusDescription:
      'Fund A applies its multi-strategy approach across three distinct, yet complementary, selections of 27 large-cap, highly liquid global enterprises:',
    assetPillars,
    alphaStackSectionTitle: 'Targeted Alpha Stack & Returns',
    alphaStackSubtitle: '(Illustrative Annual Contribution to Gross Returns)',
    alphaStackRows,
    riskSectionTitle: 'Disciplined Risk Management. Assured Liquidity.',
    riskCards,
    keyTermsSectionTitle: 'Key Terms',
    keyTermsSubtitle: '(Illustrative - Refer to Private Placement Memorandum (PPM) for Full Details)',
    keyTerms,
    shareClasses,
    joinSectionTitle: 'Investing in the Future..',
    joinSectionDescription:
      'The AI-Powered Berkshire Hathaway.\n\nWe combine AI and human expertise to invest in exceptional businesses for long-term value creation.',
    joinButtonLabel: 'Complete your hushh profile',
    handleCompleteProfile,
  };
};
