import React from "react";
import HushhTechHeader from "../../components/hushh-tech-header/HushhTechHeader";
import HushhTechFooter from "../../components/hushh-tech-footer/HushhTechFooter";
import {
  Eyebrow,
  Display,
  Lede,
  appleFont,
  appleDisplayFont,
} from "../../components/hushh-tech-ui/HushhAppleUI";

const pageBg = "#F5F5F7";
const textPrimary = "#1D1D1F";
const textSecondary = "rgba(29, 29, 31, 0.68)";
const textTertiary = "rgba(29, 29, 31, 0.48)";

type LegalSection = {
  title: string;
  intro?: string;
  paragraphs?: string[];
  items?: string[];
};

const sections: LegalSection[] = [
  {
    title: "California Investors",
    paragraphs: [
      "This section applies to California Residents who are individual investors, beneficial owners, shareholders, executive officers, directors, trustees, general partners, managing members, or persons acting in a similar capacity in connection with investments in private investment funds sponsored by Hushh.",
    ],
  },
  {
    title: "Notice at Collection of Personal Information",
    intro: "Hushh collects the following categories of personal information:",
    items: [
      "1. Identifiers: Name, alias, postal address, email address, driver’s license number, and online identifiers.",
      "2. Financial Information: Education, name, signature, address, telephone number, and investment details.",
      "3. Protected Characteristics: Gender, age, citizenship status, national origin, and marital status.",
      "4. Internet Activity: Website interactions and use of online tools.",
      "5. Professional Information: Employment details, compensation, and title.",
      "6. Sensitive Personal Information: Social security numbers and passport numbers.",
    ],
  },
  {
    title: "How Hushh Uses Your Personal Information",
    intro: "Hushh uses personal information for business purposes, including:",
    items: [
      "Delivering requested products, services, and information.",
      "Managing investor accounts and processing transactions.",
      "Compliance with legal and regulatory obligations.",
      "Detecting and preventing fraud or illegal activity.",
    ],
  },
  {
    title: "Retention of Personal Information",
    paragraphs: [
      "Hushh retains personal information for as long as required to fulfill its business purposes or comply with legal and regulatory requirements.",
    ],
  },
  {
    title: "Your California Rights",
    intro: "California Residents have the right to:",
    items: [
      "1. Be informed about collected personal information and its purposes.",
      "2. Request deletion of personal information, subject to exceptions.",
      "3. Request details about categories and sources of collected personal information.",
      "4. Correct inaccuracies in personal information.",
      "5. Not be discriminated against for exercising privacy rights.",
    ],
  },
  {
    title: "California Job Candidates",
    paragraphs: [
      "This section applies to California Residents who are job candidates, interns, or independent contractors applying to Hushh.",
    ],
  },
  {
    title: "Notice at Collection of Personal Information",
    intro: "Hushh collects the following categories of personal information for job applicants:",
    items: [
      "Identifiers: Name, alias, postal address, email address, driver’s license number.",
      "Professional Information: Employment history, previous job titles.",
      "Sensitive Personal Information: Social security numbers, passport numbers.",
    ],
  },
  {
    title: "Contact Information",
    intro: "If you have any questions about this California Privacy Policy, please contact:",
    items: ["Email: ir@hushhtech.com", "Phone: (888) 462-1726"],
  },
];

const CaliforniaPrivacyPolicy = () => {
  return (
    <div
      className="min-h-screen antialiased"
      style={{ background: pageBg, color: textPrimary, fontFamily: appleFont }}
    >
      <HushhTechHeader />

      {/* Hero */}
      <header className="px-5 pt-12 sm:px-6 sm:pt-16">
        <div className="mx-auto max-w-[760px] text-center">
          <Eyebrow>California Privacy</Eyebrow>
          <Display as="h1" size="sm" maxWidth="max-w-[680px]">
            California Privacy Policy.
          </Display>
          <Lede>
            How Hushh collects, uses, and safeguards your personal information,
            and your rights under the CCPA as amended by the CPRA.
          </Lede>
          <p
            className="mt-5 text-[13px] font-medium tracking-[-0.01em]"
            style={{ color: textTertiary, fontFamily: appleFont }}
          >
            Last Updated: February 6, 2025
          </p>
        </div>
      </header>

      {/* Legal body */}
      <main className="px-5 pb-20 pt-12 sm:px-6 sm:pb-24">
        <article className="mx-auto max-w-[760px]">
          <p
            className="text-[16px] leading-[1.7] tracking-[-0.005em] md:text-[17px]"
            style={{ color: textSecondary }}
          >
            Hushh Technologies LLC and its affiliates (collectively, &ldquo;Hushh&rdquo;)
            are committed to protecting the privacy of California residents
            (&ldquo;California Residents,&rdquo; &ldquo;you,&rdquo; or &ldquo;your&rdquo;) in accordance with
            the California Consumer Privacy Act (&ldquo;CCPA&rdquo;) as amended by the
            California Privacy Rights Act (&ldquo;CPRA&rdquo;). This California Privacy
            Policy explains how Hushh collects, uses, and safeguards your
            personal information, and it describes your rights under the
            CCPA/CPRA.
          </p>

          <div className="mt-14 space-y-14">
            {sections.map((section, index) => (
              <section key={`${section.title}-${index}`}>
                <h2
                  className="text-[24px] font-semibold leading-[1.14] tracking-[-0.022em] md:text-[28px]"
                  style={{ color: textPrimary, fontFamily: appleDisplayFont }}
                >
                  {section.title}
                </h2>

                {section.paragraphs?.map((paragraph, i) => (
                  <p
                    key={i}
                    className="mt-4 text-[16px] leading-[1.7] tracking-[-0.005em] md:text-[17px]"
                    style={{ color: textSecondary }}
                  >
                    {paragraph}
                  </p>
                ))}

                {section.intro ? (
                  <p
                    className="mt-4 text-[16px] leading-[1.7] tracking-[-0.005em] md:text-[17px]"
                    style={{ color: textSecondary }}
                  >
                    {section.intro}
                  </p>
                ) : null}

                {section.items?.length ? (
                  <ul className="mt-5 space-y-3">
                    {section.items.map((item, i) => (
                      <li
                        key={i}
                        className="flex gap-3 text-[16px] leading-[1.6] tracking-[-0.005em] md:text-[17px]"
                        style={{ color: textSecondary }}
                      >
                        <span
                          aria-hidden="true"
                          className="mt-[0.62em] h-1.5 w-1.5 shrink-0 rounded-full"
                          style={{ background: "rgba(0, 102, 204, 0.7)" }}
                        />
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </section>
            ))}
          </div>

          <div
            className="mt-16 border-t pt-8 text-center"
            style={{ borderColor: "rgba(29, 29, 31, 0.08)" }}
          >
            <p
              className="text-[13px] font-medium tracking-[-0.01em]"
              style={{ color: textTertiary, fontFamily: appleFont }}
            >
              Last Updated: February 6, 2025
            </p>
          </div>
        </article>
      </main>

      <HushhTechFooter />
    </div>
  );
};

export default CaliforniaPrivacyPolicy;
