import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ToastContainer, toast } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';
import {
  Container,
  Box,
  Heading,
  Text,
  VStack,
  HStack,
  Grid,
  GridItem,
  SimpleGrid,
  Input,
  Textarea,
  Select,
  Button,
  FormControl,
  FormLabel,
  Icon,
  Link as ChakraLink,
} from "@chakra-ui/react";
import { MapPin, Phone, Clock, ArrowRight } from "lucide-react";
import HushhTechHeader from "../components/hushh-tech-header/HushhTechHeader";
import HushhTechFooter from "../components/hushh-tech-footer/HushhTechFooter";
import { appleDisplayFont, appleFont } from "../components/hushh-tech-ui/HushhAppleUI";

/** Greys aligned with `home/ui.tsx` Tailwind tokens (gray-*, ios-gray-bg). */
const iosGrayBg = "#F5F5F7";
const gray50 = "#F9FAFB";
const gray100 = "#F3F4F6";
const gray300 = "#D1D5DB";

const pageBg = iosGrayBg;
const textPrimary = "#1D1D1F";
const textSecondary = "rgba(29, 29, 31, 0.6)";
const textTertiary = "rgba(29, 29, 31, 0.48)";
const brandBlue = "#0066CC";
const cardBorder = "rgba(29, 29, 31, 0.07)";
const inputFocus = {
  borderColor: brandBlue,
  boxShadow: `0 0 0 1px ${brandBlue}, 0 0 0 4px rgba(0, 102, 204, 0.1)`,
};

/** Shared field chrome — matches home gray inputs / ios-gray-bg section. */
const fieldChrome = {
  borderRadius: "14px" as const,
  borderColor: "rgba(29, 29, 31, 0.08)",
  bg: "rgba(249, 250, 251, 0.78)",
  color: textPrimary,
  fontSize: "15px",
  fontWeight: "400",
  boxShadow: "inset 0 1px 0 rgba(255, 255, 255, 0.75)",
  _placeholder: { color: "rgba(29, 29, 31, 0.38)" },
  _hover: { borderColor: gray300 },
  _focusVisible: inputFocus,
};

const cardHoverBorder = "rgba(0, 102, 204, 0.24)";
const glassCardChrome = {
  borderRadius: "24px" as const,
  borderWidth: "1px",
  borderColor: cardBorder,
  bg: "rgba(255, 255, 255, 0.82)",
  boxShadow:
    "0 24px 70px rgba(29, 29, 31, 0.08), inset 0 1px 0 rgba(255, 255, 255, 0.82)",
  backdropFilter: "blur(22px)",
  transition: "border-color 0.2s ease, box-shadow 0.2s ease, transform 0.2s ease",
  _hover: {
    borderColor: cardHoverBorder,
    boxShadow:
      "0 28px 80px rgba(29, 29, 31, 0.1), inset 0 1px 0 rgba(255, 255, 255, 0.9)",
    transform: "translateY(-1px)",
  },
};

const sectionHeadingProps = {
  fontSize: { base: "26px", md: "30px" },
  lineHeight: "1.12",
  letterSpacing: "-0.022em",
  fontWeight: "600",
  color: textPrimary,
};

const buttonFocusVisible = {
  _focusVisible: inputFocus,
};

const CAPTCHA_ERROR_ID = "contact-captcha-error";

const reasonOptions = [
  "Infrastructure Consultation",
  "Investment Information",
  "Technical Support",
  "Other"
];

export default function Contact() {
  const [num1, setNum1] = useState<number>(0);
  const [num2, setNum2] = useState<number>(0);

  const [formData, setFormData] = useState({
    name: '',
    company: '',
    email: '',
    phone: '',
    reason: '',
    message: '',
    captcha: '',
    website: '',
  });

  const [captchaError, setCaptchaError] = useState<string>('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const navigate = useNavigate();

  const generateRandomNumbers = () => {
    const randomNum1 = Math.floor(Math.random() * 100);
    const randomNum2 = Math.floor(Math.random() * 100);
    setNum1(randomNum1);
    setNum2(randomNum2);
  };

  useEffect(() => {
    generateRandomNumbers();
  }, []);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    if (name === "captcha" && captchaError) {
      setCaptchaError("");
    }
    setFormData({
      ...formData,
      [name]: value,
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;

    const userCaptcha = parseInt(formData.captcha, 10);
    const correctAnswer = num1 + num2;

    if (userCaptcha !== correctAnswer) {
      setCaptchaError("Incorrect sum. Please try again.");
      return;
    }

    setCaptchaError("");

    setIsSubmitting(true);
    try {
      const response = await fetch("/api/contact-notification", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: formData.name,
          company: formData.company,
          email: formData.email,
          phone: formData.phone,
          reason: formData.reason,
          message: formData.message,
          website: formData.website,
          sourcePath: window.location.pathname,
        }),
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || "Failed to send message");
      }

      toast.success("Message sent successfully.");
      setFormData({
        name: '',
        company: '',
        email: '',
        phone: '',
        reason: '',
        message: '',
        captcha: '',
        website: '',
      });
      generateRandomNumbers();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Please try again later.";
      console.error("Failed to send contact message:", message);
      toast.error("Failed to send message. Please try again later.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Box bg={pageBg} minH="100vh" className="antialiased text-gray-900" style={{ fontFamily: appleFont }}>
      <HushhTechHeader />
      <Box
        as="main"
        id="main-content"
        w="100%"
      >
      <Container maxW="7xl" py={{ base: 12, md: 20 }} px={{ base: 5, md: 6, lg: 8 }}>
        {/* Main Header */}
        <Box textAlign="center" mb={{ base: 9, md: 12 }}>
          <Heading
            as="h1"
            fontSize="clamp(32px, 4.6vw, 54px)"
            mb={5}
            letterSpacing="-0.025em"
            lineHeight="1.08"
            fontWeight="600"
            color={textPrimary}
            style={{ fontFamily: appleDisplayFont, textWrap: "balance" }}
          >
            Get in touch.
          </Heading>

          <Text
            fontSize="clamp(17px, 1.6vw, 20px)"
            maxW="46ch"
            mx="auto"
            color="rgba(0,0,0,0.62)"
            fontWeight="400"
            lineHeight="1.5"
            letterSpacing="-0.01em"
          >
            Ready to transform your investment strategy? We'd love to hear from you.
          </Text>

          <Text
            mt={4}
            fontSize={{ base: "14px", md: "15px" }}
            maxW="760px"
            mx="auto"
            color={textTertiary}
            fontWeight="400"
            lineHeight="1.6"
          >
            For career-related inquiries, please visit our{" "}
            <ChakraLink
              href="/career"
              // target="_blank"
              rel="noopener noreferrer"
              color={brandBlue}
              fontWeight="500"
              _hover={{ color: brandBlue, textDecoration: "underline" }}
            >
              Jobs page
            </ChakraLink>
            . For all other inquiries, please submit the form below.
          </Text>
        </Box>

        {/* Contact Form and Information */}
        <Grid
          templateColumns={{ base: "1fr", lg: "1fr 1fr" }}
          gap={{ base: 8, md: 10 }}
          mt={{ base: 7, md: 9 }}
          maxW="1060px"
          mx="auto"
          alignItems="start"
        >
          {/* Contact Form */}
          <GridItem
            as={Box}
            p={{ base: 6, md: 8 }}
            {...glassCardChrome}
          >
            <Heading
              as="h2"
              mb={6}
              {...sectionHeadingProps}
              style={{ fontFamily: appleDisplayFont }}
            >
              Send us a message
            </Heading>

            <form onSubmit={handleSubmit} aria-busy={isSubmitting}>
              <VStack spacing={5} align="stretch">
                <Input
                  name="website"
                  value={formData.website}
                  onChange={handleChange}
                  tabIndex={-1}
                  autoComplete="off"
                  aria-hidden="true"
                  display="none"
                />
                <SimpleGrid
                  columns={{ base: 1, md: 2 }}
                  spacing={5}
                  alignItems="start"
                  w="full"
                  data-testid="contact-form-field-row"
                >
                  <FormControl isRequired>
                    <FormLabel fontWeight="500" fontSize="13px" color="rgba(29, 29, 31, 0.62)" mb={1.5}>
                      Full Name
                    </FormLabel>
                    <Input
                      name="name"
                      placeholder="Enter your full name"
                      value={formData.name}
                      onChange={handleChange}
                      size="lg"
                      h="52px"
                      {...fieldChrome}
                    />
                  </FormControl>

                  <FormControl>
                    <FormLabel fontWeight="500" fontSize="13px" color="rgba(29, 29, 31, 0.62)" mb={1.5}>
                      Company
                    </FormLabel>
                    <Input
                      name="company"
                      placeholder="Company name (optional)"
                      value={formData.company}
                      onChange={handleChange}
                      size="lg"
                      h="52px"
                      {...fieldChrome}
                    />
                  </FormControl>
                </SimpleGrid>

                <SimpleGrid
                  columns={{ base: 1, md: 2 }}
                  spacing={5}
                  alignItems="start"
                  w="full"
                  data-testid="contact-form-field-row"
                >
                  <FormControl isRequired>
                    <FormLabel fontWeight="500" fontSize="13px" color="rgba(29, 29, 31, 0.62)" mb={1.5}>
                      Email Address
                    </FormLabel>
                    <Input
                      name="email"
                      type="email"
                      placeholder="Enter your email address"
                      value={formData.email}
                      onChange={handleChange}
                      size="lg"
                      h="52px"
                      {...fieldChrome}
                    />
                  </FormControl>

                  <FormControl>
                    <FormLabel fontWeight="500" fontSize="13px" color="rgba(29, 29, 31, 0.62)" mb={1.5}>
                      Phone Number
                    </FormLabel>
                    <Input
                      name="phone"
                      placeholder="Phone number (optional)"
                      value={formData.phone}
                      onChange={handleChange}
                      size="lg"
                      h="52px"
                      {...fieldChrome}
                    />
                  </FormControl>
                </SimpleGrid>

                <FormControl isRequired>
                  <FormLabel fontWeight="500" fontSize="13px" color="rgba(29, 29, 31, 0.62)" mb={1.5}>
                    Reason for Contact
                  </FormLabel>
                  <Select
                    name="reason"
                    placeholder="Select a reason"
                    value={formData.reason}
                    onChange={handleChange}
                    size="lg"
                    h="52px"
                    {...fieldChrome}
                  >
                    {reasonOptions.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </Select>
                </FormControl>

                <FormControl isRequired>
                  <FormLabel fontWeight="500" fontSize="13px" color="rgba(29, 29, 31, 0.62)" mb={1.5}>
                    Message
                  </FormLabel>
                  <Textarea
                    name="message"
                    placeholder="Tell us how we can help you..."
                    value={formData.message}
                    onChange={handleChange}
                    size="md"
                    minH="120px"
                    rows={4}
                    {...fieldChrome}
                  />
                </FormControl>

                <FormControl isRequired>
                  <FormLabel fontWeight="500" fontSize="13px" color="rgba(29, 29, 31, 0.62)" mb={1.5}>
                    What is the sum of {num1} and {num2}?
                  </FormLabel>
                  <Input
                    name="captcha"
                    inputMode="numeric"
                    placeholder="Enter the answer"
                    value={formData.captcha}
                    onChange={handleChange}
                    size="lg"
                    h="52px"
                    aria-invalid={captchaError ? true : undefined}
                    aria-describedby={captchaError ? CAPTCHA_ERROR_ID : undefined}
                    isDisabled={isSubmitting}
                    {...fieldChrome}
                  />
                  <Text
                    id={CAPTCHA_ERROR_ID}
                    role="alert"
                    aria-live="polite"
                    color={captchaError ? "#FF3B30" : "transparent"}
                    fontSize="sm"
                    mt={1}
                    minH="20px"
                  >
                    {captchaError}
                  </Text>
                </FormControl>

                <Box pt={6} mt={1} borderTopWidth="1px" borderTopColor="rgba(29, 29, 31, 0.06)">
                  <Button
                    type="submit"
                    width="full"
                    size="lg"
                    h="52px"
                    borderRadius="full"
                    fontWeight="500"
                    bg={brandBlue}
                    color="white"
                    isLoading={isSubmitting}
                    isDisabled={isSubmitting}
                    loadingText="Sending..."
                    aria-busy={isSubmitting}
                    boxShadow="0 12px 26px rgba(0, 102, 204, 0.24), inset 0 1px 0 rgba(255, 255, 255, 0.24)"
                    _hover={{ bg: isSubmitting ? brandBlue : "#0071E3" }}
                    _active={{ bg: "#005BB5", transform: "scale(0.99)" }}
                    _disabled={{ bg: brandBlue, opacity: 0.7, cursor: "not-allowed" }}
                    {...buttonFocusVisible}
                  >
                    Submit message
                  </Button>
                </Box>
              </VStack>
            </form>
          </GridItem>

          {/* Contact Information */}
          <GridItem>
            <Box
              p={{ base: 6, md: 8 }}
              mb={8}
              {...glassCardChrome}
            >
              <Heading
                as="h2"
                mb={6}
                {...sectionHeadingProps}
                style={{ fontFamily: appleDisplayFont }}
              >
                Contact Information
              </Heading>

              <VStack spacing={6} align="start">
                <HStack spacing={4} align="flex-start">
                  <Box
                    display="flex"
                    alignItems="center"
                    justifyContent="center"
                    w="40px"
                    h="40px"
                    flexShrink={0}
                    borderRadius="14px"
                    bg="rgba(255, 255, 255, 0.78)"
                    boxShadow="0 10px 24px rgba(29, 29, 31, 0.08), inset 0 0 0 1px rgba(29, 29, 31, 0.05), inset 0 1px 0 rgba(255, 255, 255, 0.8)"
                  >
                    <Icon
                      as={MapPin}
                      aria-hidden
                      color={brandBlue}
                      boxSize={5}
                      strokeWidth={1.8}
                    />
                  </Box>
                  <Box>
                    <Text fontWeight="600" color={textPrimary} fontSize="15px">
                      Address
                    </Text>
                    <Text color={textTertiary} fontSize="14px" lineHeight="1.6" mt={0.5} fontWeight="300">
                      1021 5th St W
                    </Text>
                    <Text color={textTertiary} fontSize="14px" lineHeight="1.6" fontWeight="300">
                      Kirkland, WA 98033
                    </Text>
                  </Box>
                </HStack>

                <HStack spacing={4} align="flex-start">
                  <Box
                    display="flex"
                    alignItems="center"
                    justifyContent="center"
                    w="40px"
                    h="40px"
                    flexShrink={0}
                    borderRadius="14px"
                    bg="rgba(255, 255, 255, 0.78)"
                    boxShadow="0 10px 24px rgba(29, 29, 31, 0.08), inset 0 0 0 1px rgba(29, 29, 31, 0.05), inset 0 1px 0 rgba(255, 255, 255, 0.8)"
                  >
                    <Icon
                      as={Phone}
                      aria-hidden
                      color={brandBlue}
                      boxSize={5}
                      strokeWidth={1.8}
                    />
                  </Box>
                  <Box>
                    <Text fontWeight="600" color={textPrimary} fontSize="15px">
                      Phone
                    </Text>
                    <Text color={textTertiary} fontSize="14px" lineHeight="1.6" mt={0.5} fontWeight="300">
                      (888) 462-1726
                    </Text>
                  </Box>
                </HStack>

                <HStack spacing={4} align="flex-start">
                  <Box
                    display="flex"
                    alignItems="center"
                    justifyContent="center"
                    w="40px"
                    h="40px"
                    flexShrink={0}
                    borderRadius="14px"
                    bg="rgba(255, 255, 255, 0.78)"
                    boxShadow="0 10px 24px rgba(29, 29, 31, 0.08), inset 0 0 0 1px rgba(29, 29, 31, 0.05), inset 0 1px 0 rgba(255, 255, 255, 0.8)"
                  >
                    <Icon
                      as={Clock}
                      aria-hidden
                      color={brandBlue}
                      boxSize={5}
                      strokeWidth={1.8}
                    />
                  </Box>
                  <Box>
                    <Text fontWeight="600" color={textPrimary} fontSize="15px">
                      Office Hours
                    </Text>
                    <Text color={textTertiary} fontSize="14px" lineHeight="1.6" mt={0.5} fontWeight="300">
                      Monday - Friday
                    </Text>
                    <Text color={textTertiary} fontSize="14px" lineHeight="1.6" fontWeight="300">
                      9:00 AM - 6:00 PM PST
                    </Text>
                  </Box>
                </HStack>
              </VStack>
            </Box>

            <Box
              p={{ base: 6, md: 8 }}
              borderRadius="24px"
              bg="linear-gradient(180deg, #1D1D1F 0%, #0F1115 100%)"
              color="white"
              boxShadow="0 24px 70px rgba(29, 29, 31, 0.2), inset 0 1px 0 rgba(255, 255, 255, 0.12)"
              borderWidth="1px"
              borderColor="rgba(255, 255, 255, 0.1)"
            >
              <Heading
                as="h3"
                mb={4}
                fontSize={{ base: "24px", md: "28px" }}
                lineHeight="1.12"
                letterSpacing="-0.022em"
                fontWeight="600"
                color="white"
                style={{ fontFamily: appleDisplayFont }}
              >
                Ready to Invest?
              </Heading>
              <Text
                mb={6}
                color="rgba(255, 255, 255, 0.5)"
                lineHeight="1.65"
                fontSize="md"
                fontWeight="300"
              >
                Join forward-thinking investors who are already benefiting from our
                AI-driven approach to wealth creation.
              </Text>
              <Button
                width="full"
                size="lg"
                h="52px"
                borderRadius="full"
                bg="white"
                color={textPrimary}
                fontWeight="500"
                borderWidth="1px"
                borderColor="rgba(255, 255, 255, 0.7)"
                boxShadow="0 10px 24px rgba(0, 0, 0, 0.24), inset 0 1px 0 rgba(255, 255, 255, 0.65)"
                rightIcon={
                  <Icon as={ArrowRight} aria-hidden boxSize={4} color={textPrimary} />
                }
                _hover={{ bg: gray50 }}
                _active={{ bg: gray100 }}
                onClick={() => navigate("/about/leadership")}
                {...buttonFocusVisible}
              >
                Learn About Our Strategy
              </Button>
            </Box>
          </GridItem>
        </Grid>

        <ToastContainer />
      </Container>
      </Box>
      <HushhTechFooter />
    </Box>
  );
}
