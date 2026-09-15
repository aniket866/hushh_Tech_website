/**
 * Hero — Home Page (iOS-native design)
 *
 * Combined scrollable page:
 * 1. Investment Intro — icon, title, AI+Human card, CTAs, badges
 * 2. The Hushh Advantage — 2×2 feature grid
 * 3. Fund A — performance card, strategy list, CTAs
 * 4. Fixed bottom tab bar
 *
 * Backend logic unchanged: auth session, onboarding status, navigation.
 */
import { useNavigate } from "react-router-dom";
import { Box, Text, Flex, Spinner, Image } from "@chakra-ui/react";
import HushhLogo from "./images/Hushhogo.png";
import { FINANCIAL_LINK_ROUTE } from "../services/onboarding/flow";
import { useInvestorJourneyCta } from "../hooks/useInvestorJourneyCta";

/* ─── iOS Design Tokens ─── */
const IOS = {
  blue: "#007AFF",
  blueActive: "#0062CC",
  bg: "#F2F2F7",
  bgWhite: "#FFFFFF",
  text: "#000000",
  subtext: "#86868B",
  separator: "#C6C6C8",
  fillGray: "rgba(118,118,128,0.12)",
  font: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif',
  fontDisplay: '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Helvetica Neue", sans-serif',
};

/* ─── Inline SVG Icons (no external deps) ─── */
const PsychologyIcon = () => (
  <svg width="36" height="36" viewBox="0 0 24 24" fill="none">
    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.94-.49-7-3.85-7-7.93 0-.62.08-1.22.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z" fill={IOS.blue} opacity="0.8"/>
  </svg>
);

const SparkIcon = () => (
  <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
    <path d="M12 2L14.09 8.26L20 9.27L15.55 13.97L16.91 20L12 16.9L7.09 20L8.45 13.97L4 9.27L9.91 8.26L12 2Z" fill="white"/>
  </svg>
);

const ShieldIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
    <path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm-2 16l-4-4 1.41-1.41L10 14.17l6.59-6.59L18 9l-8 8z" fill="#8E8E93"/>
  </svg>
);

const LockSmallIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
    <rect x="5" y="11" width="14" height="10" rx="2" fill="#8E8E93"/>
    <path d="M8 11V8a4 4 0 118 0v3" stroke="#8E8E93" strokeWidth="2" fill="none"/>
  </svg>
);

const ChevronRight = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
    <path d="M9 6l6 6-6 6" stroke="#C7C7CC" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

/* ─── Feature Grid Item ─── */
const FeatureCard = ({ icon, iconBg, iconColor, title, desc }: {
  icon: string; iconBg: string; iconColor: string; title: string; desc: string;
}) => (
  <Box
    bg="white"
    p={4}
    borderRadius="20px"
    boxShadow="inset 0 0 0 0.5px #E5E5EA"
    display="flex"
    flexDir="column"
    justifyContent="space-between"
    h="140px"
  >
    <Flex
      w="32px" h="32px" borderRadius="full"
      bg={iconBg} align="center" justify="center"
    >
      <Text fontSize="20px" lineHeight="1" role="img" aria-label={title}
        sx={{ fontVariationSettings: "'FILL' 1, 'wght' 600" }}
        className="material-symbols-outlined"
        color={iconColor}
      >
        {icon}
      </Text>
    </Flex>
    <Box>
      <Text fontSize="15px" fontWeight="600" color={IOS.text} mb={0.5}>{title}</Text>
      <Text fontSize="12px" color="rgba(60,60,67,0.6)" lineHeight="16px">{desc}</Text>
    </Box>
  </Box>
);

/* ─── Strategy List Item ─── */
const StrategyItem = ({ icon, iconBg, title, subtitle, isLast = false }: {
  icon: string; iconBg: string; title: string; subtitle: string; isLast?: boolean;
}) => (
  <Flex
    align="center" px={4} py={3}
    borderBottom={isLast ? "none" : "0.5px solid"}
    borderColor="rgba(198,198,200,0.4)"
    cursor="pointer"
    transition="background 0.15s"
    _active={{ bg: "#D1D1D6" }}
  >
    <Flex
      w="30px" h="30px" borderRadius="7px"
      bg={iconBg} align="center" justify="center" mr={3} flexShrink={0}
    >
      <Text fontSize="18px" color="white" lineHeight="1"
        className="material-symbols-outlined"
        sx={{ fontVariationSettings: "'FILL' 1, 'wght' 600" }}
      >
        {icon}
      </Text>
    </Flex>
    <Box flex="1" py={0.5}>
      <Text fontSize="17px" color={IOS.text}>{title}</Text>
    </Box>
    <Flex align="center">
      <Text fontSize="17px" color="rgba(60,60,67,0.6)" mr={1}>{subtitle}</Text>
      <ChevronRight />
    </Flex>
  </Flex>
);

/* ─── Tab Bar Item ─── */
const TabItem = ({ icon, label, active = false }: {
  icon: string; label: string; active?: boolean;
}) => (
  <Flex flexDir="column" align="center" gap={1} w="64px" opacity={active ? 1 : 0.6}>
    <Text
      fontSize="26px" lineHeight="1"
      color={active ? IOS.blue : "#8E8E93"}
      className="material-symbols-outlined"
      sx={{ fontVariationSettings: `'FILL' ${active ? 1 : 0}, 'wght' ${active ? 500 : 400}` }}
    >
      {icon}
    </Text>
    <Text fontSize="10px" fontWeight="500" color={active ? IOS.blue : "#8E8E93"}>{label}</Text>
  </Flex>
);

/* ═══════════════════════════════════════════════
   HERO COMPONENT — All backend logic preserved
   ═══════════════════════════════════════════════ */
export default function Hero() {
  const navigate = useNavigate();
  // All session + onboarding + CTA decision logic now lives in the unified
  // useInvestorJourneyCta hook. Hero used to maintain its own duplicate
  // copy of the state machine (which bypassed the InvestorAccessRoute gate
  // and routed users to the wrong page).
  const { session, primaryCTA } = useInvestorJourneyCta();
  const onboardingStatus = {
    loading: primaryCTA.loading,
    hasProfile: primaryCTA.isInvestor,
    isCompleted: primaryCTA.isInvestor,
    currentStep: 1,
  };

  /* ─── RENDER ─── */
  return (
    <Box
      bg={IOS.bg}
      fontFamily={IOS.font}
      minH="100dvh"
      position="relative"
      sx={{ WebkitFontSmoothing: "antialiased", MozOsxFontSmoothing: "grayscale" }}
    >
      {/* Scrollable content */}
      <Box
        as="main"
        maxW={{ base: "393px", md: "768px", lg: "1024px" }}
        mx="auto"
        pb="120px"
        pt="50px"
      >
        {/* ═══ Section 1: Investment Intro ═══ */}
        <Flex flexDir="column" align="center" px={6} pt={4} pb={2} bg="white" borderBottomRadius="0">
          {/* Hushh Brand Logo */}
          <Flex
            w="72px" h="72px" borderRadius="full"
            bg="white" align="center" justify="center" mb={6}
            border="1px solid" borderColor="gray.100"
            boxShadow="0 2px 12px rgba(0,0,0,0.06)"
          >
            <Image
              src={HushhLogo}
              alt="Hushh brand logo"
              w="48px" h="48px"
              objectFit="contain"
            />
          </Flex>

          {/* Title */}
          <Text
            fontSize="34px" lineHeight="41px" fontWeight="700"
            textAlign="center" letterSpacing="-0.02em"
            fontFamily={IOS.fontDisplay} color={IOS.text} mb={3}
          >
            Investing in the <br />
            <Box as="span" color={IOS.blue}>Future</Box>
          </Text>

          {/* Subtitle */}
          <Text
            fontSize="17px" lineHeight="22px" textAlign="center"
            color={IOS.subtext} fontWeight="400" letterSpacing="-0.01em"
            px={2} mb={4}
          >
            The AI-Powered Berkshire Hathaway. We combine AI and human expertise
            to invest in exceptional businesses for long-term value creation.
          </Text>

          {/* AI + Human — Two iOS widget cards */}
          <Flex w="100%" gap={3} my={4}>
            {/* AI Card */}
            <Box
              flex="1" bg="white" borderRadius="16px"
              p={4} pb={5}
              border="0.5px solid" borderColor="rgba(0,0,0,0.06)"
              boxShadow="0 1px 3px rgba(0,0,0,0.04)"
            >
              <Box
                w="8px" h="8px" borderRadius="full"
                bg={IOS.blue} mb={3}
              />
              <Text fontSize="22px" fontWeight="700" color={IOS.text}
                lineHeight="26px" letterSpacing="-0.02em"
                fontFamily={IOS.fontDisplay} mb={1}
              >
                AI-Powered
              </Text>
              <Text fontSize="13px" lineHeight="18px" color={IOS.subtext}>
                Institutional grade analytics and real-time signals.
              </Text>
            </Box>

            {/* Human Card */}
            <Box
              flex="1" bg="white" borderRadius="16px"
              p={4} pb={5}
              border="0.5px solid" borderColor="rgba(0,0,0,0.06)"
              boxShadow="0 1px 3px rgba(0,0,0,0.04)"
            >
              <Box
                w="8px" h="8px" borderRadius="full"
                bg="#34C759" mb={3}
              />
              <Text fontSize="22px" fontWeight="700" color={IOS.text}
                lineHeight="26px" letterSpacing="-0.02em"
                fontFamily={IOS.fontDisplay} mb={1}
              >
                Human-Led
              </Text>
              <Text fontSize="13px" lineHeight="18px" color={IOS.subtext}>
                Seasoned expert oversight for generational wealth.
              </Text>
            </Box>
          </Flex>

          {/* CTAs */}
          <Box w="100%" mt={2} mb={2}>
            <Box
              as="button" w="100%" bg={IOS.blue} color="white"
              fontWeight="600" fontSize="17px" py="16px" borderRadius="14px"
              textAlign="center" cursor="pointer" mb={3.5}
              transition="background 0.2s"
              _active={{ bg: IOS.blueActive }}
              _disabled={{ opacity: 0.6, cursor: "not-allowed" }}
              onClick={primaryCTA.action}
              aria-label={primaryCTA.text}
              {...(primaryCTA.loading ? { opacity: 0.6 } : {})}
            >
              {primaryCTA.loading ? <Spinner size="sm" color="white" /> : primaryCTA.text}
            </Box>

            <Box
              as="button" w="100%" bg={IOS.fillGray} color={IOS.blue}
              fontWeight="600" fontSize="17px" py="16px" borderRadius="14px"
              textAlign="center" cursor="pointer"
              transition="background 0.2s"
              _active={{ bg: "#E5E5EA" }}
              onClick={() => navigate("/discover-fund-a")}
            >
              Discover Fund A
            </Box>
          </Box>

          {/* Trust Badges */}
          <Flex align="center" justify="center" gap={6} mt={4} mb={6} opacity={0.6}>
            <Flex align="center" gap={1.5}>
              <ShieldIcon />
              <Text fontSize="10px" fontWeight="600" color="#8E8E93" letterSpacing="0.04em" textTransform="uppercase">
                Private Markets
              </Text>
            </Flex>
            <Box w="1px" h="12px" bg="rgba(0,0,0,0.1)" />
            <Flex align="center" gap={1.5}>
              <LockSmallIcon />
              <Text fontSize="10px" fontWeight="600" color="#8E8E93" letterSpacing="0.04em" textTransform="uppercase">
                Bank Level Security
              </Text>
            </Flex>
          </Flex>
        </Flex>

        {/* ═══ Section 2: The Hushh Advantage ═══ */}
        <Box px={5} pt={8} pb={4}>
          <Text
            fontSize="34px" lineHeight="41px" fontWeight="700"
            letterSpacing="-0.02em" fontFamily={IOS.fontDisplay} color={IOS.text}
          >
            The Hushh <br />
            <Box as="span" color={IOS.blue}>Advantage</Box>
          </Text>
        </Box>

        <Box px={4} mb={8}>
          <Flex gap={3} wrap="wrap">
            <Box flex="1" minW="45%">
              <FeatureCard icon="analytics" iconBg="rgba(0,122,255,0.1)" iconColor={IOS.blue}
                title="Data Driven" desc="Real-time market analytics." />
            </Box>
            <Box flex="1" minW="45%">
              <FeatureCard icon="percent" iconBg="rgba(52,199,89,0.12)" iconColor="#34C759"
                title="Low Fees" desc="Maximize your total returns." />
            </Box>
            <Box flex="1" minW="45%">
              <FeatureCard icon="verified_user" iconBg="rgba(255,149,0,0.12)" iconColor="#FF9500"
                title="Expert Vetted" desc="Curated top opportunities." />
            </Box>
            <Box flex="1" minW="45%">
              <FeatureCard icon="smart_toy" iconBg="rgba(175,82,222,0.12)" iconColor="#AF52DE"
                title="Automated" desc="Hands-free smart investing." />
            </Box>
          </Flex>
        </Box>

        {/* ═══ Section 3: Fund A ═══ */}
        <Box px={5} mb={2} mt={4}>
          <Text fontSize="22px" lineHeight="28px" fontWeight="700"
            fontFamily={IOS.fontDisplay} color={IOS.text} letterSpacing="0.35px"
          >
            Fund A
          </Text>
        </Box>

        {/* Performance Card */}
        <Box px={4} mb={6}>
          <Box bg="white" borderRadius="20px" p={5}
            boxShadow="0 1px 3px rgba(0,0,0,0.04)" border="1px solid rgba(0,0,0,0.03)"
          >
            <Flex justify="space-between" align="flex-start" mb={6}>
              <Box>
                <Text fontSize="11px" fontWeight="600" color="rgba(60,60,67,0.6)"
                  textTransform="uppercase" letterSpacing="0.06em"
                >
                  Target Net IRR
                </Text>
                <Text fontSize="40px" lineHeight="1" fontWeight="700" color={IOS.blue}
                  letterSpacing="-0.02em" mt={1}
                >
                  18–23%
                </Text>
              </Box>
              <Box bg="rgba(0,122,255,0.08)" color={IOS.blue} px={3} py={1}
                borderRadius="full" fontSize="12px" fontWeight="600"
              >
                High Growth
              </Box>
            </Flex>

            <Flex justify="space-between" align="flex-end" borderTop="1px solid" borderColor="gray.100" pt={4}>
              <Box>
                <Text fontSize="12px" color="rgba(60,60,67,0.6)">Inception Year</Text>
                <Text fontSize="17px" fontWeight="600" color={IOS.text}>2024</Text>
              </Box>
              <Flex align="center" gap={1} cursor="pointer" color={IOS.blue}
                onClick={() => navigate("/discover-fund-a")}
              >
                <Text fontSize="15px" fontWeight="500">Performance Details</Text>
                <ChevronRight />
              </Flex>
            </Flex>
          </Box>

          <Text px={1} mt={2} fontSize="13px" color="rgba(60,60,67,0.6)" lineHeight="18px">
            Flagship growth fund focusing on diversified assets across emerging tech sectors.
          </Text>
        </Box>

        {/* Strategy List */}
        <Box px={4} mb={8}>
          <Box bg="white" borderRadius="10px" overflow="hidden">
            <StrategyItem icon="trending_up" iconBg="#3B82F6" title="High Growth" subtitle="Accelerated" />
            <StrategyItem icon="grid_view" iconBg="#6B7280" title="Diversified" subtitle="Multi-sector" />
            <StrategyItem icon="shield" iconBg="#F97316" title="Secure Assets" subtitle="Managed" />
            <StrategyItem icon="rocket_launch" iconBg="#8B5CF6" title="Emerging Tech" subtitle="Unicorns" isLast />
          </Box>
        </Box>

        {/* Bottom CTAs */}
        <Box px={4} mb={8}>
          <Box
            as="button" w="100%" bg={IOS.blue} color="white"
            fontWeight="600" fontSize="17px" py="14px" borderRadius="14px"
            textAlign="center" cursor="pointer" mb={3}
            _active={{ bg: IOS.blueActive, transform: "scale(0.96)", opacity: 0.8 }}
            transition="all 0.15s ease-out"
            onClick={() => navigate("/discover-fund-a")}
          >
            Explore Our Approach
          </Box>

          <Box
            as="button" w="100%" bg={IOS.fillGray} color={IOS.blue}
            fontWeight="600" fontSize="17px" py="14px" borderRadius="14px"
            textAlign="center" cursor="pointer"
            _active={{ bg: "#E5E5EA", transform: "scale(0.96)", opacity: 0.8 }}
            transition="all 0.15s ease-out"
            onClick={() => navigate(FINANCIAL_LINK_ROUTE)}
          >
            Learn More
          </Box>

          <Text fontSize="11px" textAlign="center" color="rgba(60,60,67,0.6)" mt={6} px={4} lineHeight="13px">
            *Past performance is not indicative of future results. Investment involves risk including possible loss of principal.
          </Text>
        </Box>
      </Box>

      {/* ═══ Fixed Bottom Tab Bar ═══ */}
      <Box
        position="fixed" bottom={0} left={0} right={0}
        bg="rgba(255,255,255,0.8)" backdropFilter="blur(20px)"
        sx={{ WebkitBackdropFilter: "blur(20px)" }}
        borderTop="0.5px solid rgba(0,0,0,0.1)"
        pb="28px" pt={2} px={6} zIndex={40}
      >
        <Flex justify="space-between" align="center" maxW={{ base: "393px", md: "768px", lg: "1024px" }} mx="auto">
          <TabItem icon="home" label="Home" active />
          <Box onClick={() => navigate("/hushh-user-profile")} cursor="pointer">
            <TabItem icon="pie_chart" label="Portfolio" />
          </Box>
          <Box onClick={() => navigate("/discover-fund-a")} cursor="pointer">
            <TabItem icon="swap_horiz" label="Trade" />
          </Box>
          <Box onClick={() => session ? navigate("/hushh-user-profile") : navigate("/login")} cursor="pointer">
            <TabItem icon="person" label="Profile" />
          </Box>
        </Flex>
      </Box>
    </Box>
  );
}
