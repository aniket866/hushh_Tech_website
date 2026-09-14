import React from "react";
import { Link, Route, Routes, useLocation } from "react-router-dom";
import {
  Box,
  Flex,
  Heading,
  HStack,
  Icon,
  Text,
  VStack,
} from "@chakra-ui/react";
import {
  Briefcase,
  ChevronRight,
  Clock,
  DollarSign,
  MapPin,
  Rocket,
  Sparkles,
} from "lucide-react";

import HushhTechHeader from "../../components/hushh-tech-header/HushhTechHeader";
import HushhTechFooter from "../../components/hushh-tech-footer/HushhTechFooter";
import {
  AppleSection,
  Display,
  Eyebrow,
  Lede,
  PillButton,
  appleFont,
} from "../../components/hushh-tech-ui/HushhAppleUI";
import { careers } from "../../data/career";
import JobDetails from "./JobDetails";
import {
  appleDisplayFont,
  brandBlue,
  focusVisible,
  textPrimary,
  textTertiary,
} from "./careerTheme";
import "./Career.css";

const benefitCards = [
  {
    icon: Rocket,
    title: "Cutting-edge technology",
    body: "Work with AI, quantitative research, and data systems built for real investing outcomes.",
    tint: "#2997FF",
  },
  {
    icon: DollarSign,
    title: "Meaningful upside",
    body: "Competitive compensation, ownership-minded incentives, and work tied directly to business impact.",
    tint: "#34C759",
  },
  {
    icon: Sparkles,
    title: "Fast growth",
    body: "Learn from operators, researchers, and builders while taking on real responsibility early.",
    tint: "#AF52DE",
  },
];

const totalRoles = Object.values(careers).reduce((count, jobs) => count + jobs.length, 0);
const totalDepartments = Object.keys(careers).length;

const metaTextProps = {
  fontSize: "13px",
  fontWeight: "400",
  color: textTertiary,
  lineHeight: "1.35",
};

const CareerList = () => {
  return (
    <div
      className="min-h-screen overflow-x-hidden bg-white text-[#1D1D1F] antialiased"
      style={{ fontFamily: appleFont }}
    >
      <HushhTechHeader />

      <main id="main-content">
        {/* HERO — light */}
        <AppleSection tone="light" pad="loose">
          <div className="relative z-[1] mx-auto max-w-[1060px]">
            <Eyebrow>Careers</Eyebrow>
            <Display as="h1" size="lg" maxWidth="max-w-[18ch]">
              Hushh Jobs.
            </Display>
            <Lede>
              Help us build the AI-powered investment company where rigorous research, product
              craft, and long-term ownership meet.
            </Lede>

            <div className="mt-8 flex flex-wrap items-center justify-center gap-3 md:gap-4">
              <span className="inline-flex items-center rounded-full bg-[#0066CC]/[0.08] px-3.5 py-1.5 text-[12px] font-semibold tracking-[0.08em] text-[#0066CC]">
                {totalRoles} open roles
              </span>
              <span className="inline-flex items-center rounded-full bg-[#1D1D1F]/[0.05] px-3.5 py-1.5 text-[12px] font-semibold tracking-[0.08em] text-[#1D1D1F]/60">
                {totalDepartments} teams
              </span>
            </div>
          </div>
        </AppleSection>

        {/* OPEN ROLES — light, clean white cards */}
        <AppleSection tone="light" pad="normal" className="!pt-0">
          <Box
            maxW="1060px"
            mx="auto"
            px={{ base: 5, md: 6 }}
            style={{ fontFamily: appleFont }}
          >
            <VStack spacing={{ base: 5, md: 7 }} align="stretch">
              {Object.entries(careers).map(([department, jobs]) => (
                <Box
                  key={department}
                  p={{ base: 5, md: 7 }}
                  borderRadius="24px"
                  bg="#FFFFFF"
                  boxShadow="inset 0 0 0 1px rgba(29,29,31,0.08)"
                >
                  <Flex
                    align={{ base: "flex-start", md: "center" }}
                    justify="space-between"
                    gap={4}
                    mb={{ base: 5, md: 6 }}
                    direction={{ base: "column", md: "row" }}
                  >
                    <Box>
                      <Text
                        mb={2}
                        fontSize="12px"
                        fontWeight="600"
                        letterSpacing="0.16em"
                        textTransform="uppercase"
                        color={brandBlue}
                      >
                        Team
                      </Text>
                      <Heading
                        as="h2"
                        fontSize={{ base: "22px", md: "26px" }}
                        lineHeight="1.12"
                        letterSpacing="-0.02em"
                        fontWeight="600"
                        color={textPrimary}
                        style={{ fontFamily: appleDisplayFont }}
                      >
                        {department}
                      </Heading>
                    </Box>
                    <Text fontSize="14px" fontWeight="400" color={textTertiary}>
                      {jobs.length} {jobs.length === 1 ? "role" : "roles"}
                    </Text>
                  </Flex>

                  <VStack spacing={3} align="stretch">
                    {jobs.map((job) => (
                      <Box
                        key={job.id}
                        as={Link}
                        to={`/career/${job.id}`}
                        aria-label={`View ${job.title} role`}
                        p={{ base: 4, md: 5 }}
                        borderRadius="18px"
                        bg="#F5F5F7"
                        transition="background 0.2s ease, transform 0.2s ease"
                        _hover={{ bg: "#EEEEF1", textDecoration: "none", transform: "translateY(-1px)" }}
                        _active={{ transform: "scale(0.995)" }}
                        {...focusVisible}
                      >
                        <Flex align="center" justify="space-between" gap={4}>
                          <Flex align={{ base: "flex-start", md: "center" }} gap={4} minW={0}>
                            <Flex
                              align="center"
                              justify="center"
                              w="42px"
                              h="42px"
                              flexShrink={0}
                              borderRadius="14px"
                              color={brandBlue}
                              bg="rgba(0, 102, 204, 0.1)"
                            >
                              <Icon as={Briefcase} boxSize="19px" strokeWidth={1.8} aria-hidden />
                            </Flex>
                            <Box minW={0}>
                              <Heading
                                as="h3"
                                fontSize={{ base: "17px", md: "19px" }}
                                lineHeight="1.2"
                                letterSpacing="-0.018em"
                                fontWeight="600"
                                color={textPrimary}
                                style={{ fontFamily: appleDisplayFont }}
                              >
                                {job.title}
                              </Heading>
                              <HStack
                                mt={3}
                                spacing={{ base: 2, md: 5 }}
                                alignItems={{ base: "flex-start", md: "center" }}
                                flexDirection={{ base: "column", md: "row" }}
                              >
                                <HStack spacing={2}>
                                  <Icon as={MapPin} boxSize={4} color={brandBlue} aria-hidden />
                                  <Text {...metaTextProps}>{job.location}</Text>
                                </HStack>
                                <HStack spacing={2}>
                                  <Icon as={Clock} boxSize={4} color={brandBlue} aria-hidden />
                                  <Text {...metaTextProps}>Full-time</Text>
                                </HStack>
                              </HStack>
                            </Box>
                          </Flex>
                          <Icon as={ChevronRight} color="rgba(29, 29, 31, 0.34)" boxSize={5} aria-hidden />
                        </Flex>
                      </Box>
                    ))}
                  </VStack>
                </Box>
              ))}
            </VStack>
          </Box>
        </AppleSection>

        {/* WHY HUSHH — dark */}
        <AppleSection tone="dark" pad="normal">
          <div className="relative z-[1] mx-auto max-w-[1100px]">
            <Eyebrow tone="dark">Why Hushh</Eyebrow>
            <Display as="h2" size="sm" tone="dark" maxWidth="max-w-[16ch]">
              Designed for ambitious builders.
            </Display>

            <div className="mt-[clamp(40px,6vw,60px)] grid gap-[18px] sm:grid-cols-3">
              {benefitCards.map((benefit) => (
                <div
                  key={benefit.title}
                  className="flex min-h-[200px] flex-col rounded-[22px] border border-white/[0.08] bg-[#0E0E10] p-[30px] transition duration-300 hover:-translate-y-1.5 hover:border-[#2997FF]/45"
                >
                  <span
                    className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-[14px]"
                    style={{ background: "rgba(255,255,255,0.06)", color: benefit.tint }}
                  >
                    <Icon as={benefit.icon} boxSize="22px" strokeWidth={1.8} aria-hidden />
                  </span>
                  <h3 className="mt-5 text-[20px] font-semibold tracking-[-0.01em] text-white">
                    {benefit.title}
                  </h3>
                  <p className="mt-2 text-[15px] leading-[1.55] text-white/55">
                    {benefit.body}
                  </p>
                </div>
              ))}
            </div>

            <div className="mt-[clamp(44px,6vw,62px)] flex justify-center">
              <Link to="/benefits" className="focus-visible:outline-none">
                <PillButton tone="dark" kind="filled">
                  View full benefits
                </PillButton>
              </Link>
            </div>
          </div>
        </AppleSection>
      </main>

      <HushhTechFooter />
    </div>
  );
};

const Career = () => {
  const location = useLocation();

  if (location.pathname === "/career") {
    return <CareerList />;
  }

  return (
    <Routes>
      <Route path="/:jobId" element={<JobDetails />} />
    </Routes>
  );
};

export default Career;
