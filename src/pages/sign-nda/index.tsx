/**
 * Sign NDA + Fund Documents Page
 * User must sign the NDA AND acknowledge all 4 fund documents.
 * Apple-style agreement review surface.
 * Backend logic (auth, NDA signing, PDF gen, notification) fully preserved.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useToast } from '@chakra-ui/react';
import {
  ArrowRight,
  ChevronDown,
  FileDown,
  FileSearch2,
  FileText,
  LockKeyhole,
  Signature,
  ShieldCheck,
  UserRound,
} from 'lucide-react';
import config from '../../resources/config/config';
import { signNDA, sendNDANotification, generateNDAPdf, uploadSignedNDA } from '../../services/nda/ndaService';
import { FUND_DOCUMENTS, NDA_CONSENT_VERSION } from '../../services/nda/ndaDocuments';
import HushhTechHeader from '../../components/hushh-tech-header/HushhTechHeader';
import HushhTechFooter from '../../components/hushh-tech-footer/HushhTechFooter';
import { useAuthSession } from '../../auth/AuthSessionProvider';
import { buildLoginRedirectPath } from '../../auth/routePolicy';
import {
  AppIcon,
  AppleLineIcon,
  AppleSection,
  Display,
  Eyebrow,
  Lede,
  PillButton,
  SmallSpinner,
  appleFont,
} from '../../components/hushh-tech-ui/HushhAppleUI';

/* ── Fund documents config — shared source of truth (services/nda/ndaDocuments) ── */

/* ── NDA terms data ── */
const NDA_SECTIONS = [
  {
    title: '1. definition of confidential information',
    body: '"Confidential Information" means any non-public information disclosed by Hushh to the Recipient, including but not limited to: business strategies, financial information, investment strategies, fund performance data, technical specifications, proprietary algorithms, AI models, trade secrets, and any other information marked as confidential or that reasonably should be understood to be confidential.',
  },
  {
    title: '2. obligations of the recipient',
    body: 'The Recipient agrees to: (a) hold Confidential Information in strict confidence; (b) not disclose Confidential Information to any third party without prior written consent; (c) use Confidential Information solely for evaluating a potential relationship with Hushh; (d) take reasonable measures to protect the confidentiality of such information.',
  },
  {
    title: '3. exceptions',
    body: 'This Agreement does not apply to information that: (a) is or becomes publicly available through no fault of the Recipient; (b) was known to the Recipient prior to disclosure; (c) is independently developed by the Recipient; (d) is disclosed pursuant to a court order or legal requirement.',
  },
  {
    title: '4. term and termination',
    body: 'This Agreement shall remain in effect for a period of three (3) years from the date of execution. The obligations of confidentiality shall survive the termination of this Agreement.',
  },
  {
    title: '5. governing law',
    body: 'This Agreement shall be governed by the laws of the State of Delaware, United States of America, without regard to its conflict of laws principles.',
  },
  {
    title: '6. acknowledgment',
    body: 'By signing below, the Recipient acknowledges that they have read, understood, and agree to be bound by the terms of this Non-Disclosure Agreement. The Recipient further acknowledges that any breach of this Agreement may result in irreparable harm to Hushh and that Hushh shall be entitled to seek injunctive relief in addition to any other remedies available at law.',
  },
];

const stepRail = [
  { label: 'NDA', detail: 'Terms', icon: ShieldCheck },
  { label: 'Fund Docs', detail: 'Review', icon: FileSearch2 },
  { label: 'Sign', detail: 'Continue', icon: Signature },
];

type AppIconKind = Parameters<typeof AppIcon>[0]['kind'];

const getDocumentIconKind = (docId: string): AppIconKind => {
  if (docId.includes('delaware')) return 'balance';
  if (docId.includes('prospectus')) return 'chart';
  if (docId.includes('master')) return 'layers';
  if (docId.includes('ppm')) return 'shield';
  return 'api';
};

const stepCardOffsets = [
  { x: -68, y: 20, rotate: -6 },
  { x: 0, y: -12, rotate: 0 },
  { x: 68, y: 20, rotate: 6 },
];

const StepCardStack = () => (
  <>
    <style>
      {`
        @keyframes nda-step-card-fan {
          0%, 10% {
            opacity: 0;
            transform: translate(-50%, 44px) scale(0.9) rotate(0deg);
          }
          24%, 72% {
            opacity: 1;
            transform: translate(calc(-50% + var(--slot-x)), var(--slot-y)) scale(1) rotate(var(--slot-rot));
          }
          82%, 100% {
            opacity: 0;
            transform: translate(calc(-50% + var(--slot-x)), calc(var(--slot-y) - 16px)) scale(0.98) rotate(var(--slot-rot));
          }
        }

        .nda-step-card {
          animation: nda-step-card-fan 7.2s cubic-bezier(0.23, 1, 0.32, 1) infinite;
          animation-delay: var(--step-delay);
          transform-origin: center bottom;
        }

        @media (prefers-reduced-motion: reduce) {
          .nda-step-card {
            animation: none;
            opacity: 1;
            transform: translate(calc(-50% + var(--slot-x)), var(--slot-y)) scale(1) rotate(var(--slot-rot));
          }
        }
      `}
    </style>
    <AppleSection tone="dark" pad="normal" className="!py-12 md:!py-16">
      <div className="mx-auto max-w-5xl px-5 sm:px-6">
        <div className="overflow-hidden rounded-[24px] bg-[#161617] p-4 shadow-[inset_0_0_0_0.5px_rgba(245,245,247,0.08)] sm:p-5">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_286px] lg:items-center">
            <div className="relative h-[168px] sm:h-[180px] lg:h-[166px]" aria-label="Agreement steps">
              {stepRail.map((step, index) => {
                const offset = stepCardOffsets[index];
                const IconGlyph = step.icon;

                return (
                  <div
                    key={step.label}
                    className="nda-step-card absolute left-1/2 top-6 flex h-[108px] w-[178px] flex-col justify-between rounded-[24px] border border-[#1D1D1F]/[0.07] bg-white/95 p-4 shadow-[0_18px_45px_rgba(29,29,31,0.13)] backdrop-blur sm:w-[220px]"
                    style={{
                      '--slot-x': `${offset.x}px`,
                      '--slot-y': `${offset.y}px`,
                      '--slot-rot': `${offset.rotate}deg`,
                      '--step-delay': `${index * 0.72}s`,
                      zIndex: 10 + index,
                    } as React.CSSProperties}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[14px] bg-[#F5F5F7]">
                        <IconGlyph aria-hidden="true" size={17} strokeWidth={1.55} className="text-[#1D1D1F]/62" />
                      </span>
                      <span className="text-[10px] font-semibold uppercase tracking-[1.7px] text-[#1D1D1F]/45">
                        Step {index + 1}
                      </span>
                    </div>
                    <div>
                      <p className="text-[18px] font-medium leading-[1.08] tracking-[-0.028em] text-[#1D1D1F]">
                        {step.label}
                      </p>
                      <p className="mt-1 text-[12px] leading-[1.35] text-[#1D1D1F]/60">
                        {step.detail}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="hidden rounded-[20px] bg-[#000000]/35 p-5 shadow-[inset_0_0_0_0.5px_rgba(245,245,247,0.08)] lg:block">
              <p className="text-[11px] font-semibold uppercase tracking-[1.8px] text-[#F5F5F7]/55">
                Agreement packet
              </p>
              <div className="mt-4 space-y-2.5">
                {stepRail.map((step, index) => (
                  <div key={step.label} className="flex items-center gap-3 rounded-[14px] bg-[#161617] px-3 py-2.5">
                    <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[#F5F5F7] text-[11px] font-semibold text-[#1D1D1F]/58">
                      {index + 1}
                    </span>
                    <div>
                      <p className="text-[14px] font-medium leading-none text-[#F5F5F7]">{step.label}</p>
                      <p className="mt-1 text-[11px] text-[#F5F5F7]/58">{step.detail}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </AppleSection>
  </>
);

const SignNDAPage: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const isMountedRef = useRef(true);
  const { session, status, user, revalidateSession } = useAuthSession();

  const [isLoading, setIsLoading] = useState(true);
  const [signerName, setSignerName] = useState('');
  const [agreedToTerms, setAgreedToTerms] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);
  const [userEmail, setUserEmail] = useState<string | null>(null);

  /* Track which fund documents have been acknowledged */
  const [docAcknowledged, setDocAcknowledged] = useState<Record<string, boolean>>(
    Object.fromEntries(FUND_DOCUMENTS.map((d) => [d.id, false]))
  );

  const [nameError, setNameError] = useState('');
  const [termsError, setTermsError] = useState('');
  const [openNdaItem, setOpenNdaItem] = useState<string | null>(null);
  const [openFundDocument, setOpenFundDocument] = useState<string | null>(null);

  /* Derived: all documents acknowledged? */
  const allDocsAcknowledged = FUND_DOCUMENTS.every((d) => docAcknowledged[d.id]);

  /* Can submit? */
  const canSubmit = agreedToTerms && allDocsAcknowledged && signerName.trim().length >= 2 && !isSubmitting;

  /* Cleanup on unmount */
  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  /* Auth lifecycle */
  useEffect(() => {
    if (status === 'booting') {
      return;
    }

    if (status !== 'authenticated' || !user) {
      setIsLoading(false);
      navigate(
        buildLoginRedirectPath(location.pathname, location.search, location.hash),
        { replace: true }
      );
      return;
    }

    setUserId(user.id);
    setUserEmail(user.email || null);

    const fullName =
      user.user_metadata?.full_name ||
      user.user_metadata?.name ||
      '';

    if (fullName) {
      setSignerName((currentName) => currentName || fullName);
    }

    setIsLoading(false);
  }, [location.hash, location.pathname, location.search, navigate, status, user]);

  /* Toggle individual document acknowledgment */
  const handleDocToggle = useCallback((docId: string) => {
    setDocAcknowledged((prev) => ({ ...prev, [docId]: !prev[docId] }));
  }, []);

  /* Download handler */
  const handleDownload = useCallback((url: string, name: string) => {
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
  }, []);

  const handleReadDocument = useCallback((url: string, title: string) => {
    const readerUrl = new URL('/document-viewer', window.location.origin);
    readerUrl.searchParams.set('src', url);
    readerUrl.searchParams.set('title', title);
    window.open(readerUrl.toString(), '_blank', 'noopener,noreferrer');
  }, []);

  const validateForm = useCallback((): boolean => {
    let isValid = true;

    const trimmedName = signerName.trim();
    if (!trimmedName) {
      setNameError('please enter your full legal name');
      isValid = false;
    } else if (trimmedName.length < 2) {
      setNameError('name must be at least 2 characters');
      isValid = false;
    } else {
      setNameError('');
    }

    if (!agreedToTerms) {
      setTermsError('you must agree to the terms');
      isValid = false;
    } else {
      setTermsError('');
    }

    if (!allDocsAcknowledged) {
      toast({
        title: 'documents required',
        description: 'please acknowledge all fund documents before signing.',
        status: 'warning',
        duration: 4000,
        isClosable: true,
      });
      isValid = false;
    }

    return isValid;
  }, [signerName, agreedToTerms, allDocsAcknowledged, toast]);

  const handleSignNDA = useCallback(async () => {
    if (!validateForm()) return;
    if (isSubmitting) return;

    if (!config.gcpBackendClient || !userId) {
      toast({
        title: 'session expired',
        description: 'please log in again.',
        status: 'error',
        duration: 4000,
        isClosable: true,
      });
      navigate(
        buildLoginRedirectPath(location.pathname, location.search, location.hash),
        { replace: true }
      );
      return;
    }

    setIsSubmitting(true);

    try {
      let accessToken = session?.access_token || null;

      if (!accessToken) {
        const snapshot = await revalidateSession();
        if (snapshot.status === 'authenticated') {
          accessToken = snapshot.session?.access_token || null;
        }
      }

      if (!accessToken) {
        toast({
          title: 'session expired',
          description: 'your session has expired. please log in again.',
          status: 'error',
          duration: 4000,
          isClosable: true,
        });
        navigate(
          buildLoginRedirectPath(location.pathname, location.search, location.hash),
          { replace: true }
        );
        return;
      }

      const trimmedName = signerName.trim();
      let generatedPdfUrl: string | undefined;
      let pdfBlob: Blob | undefined;

      // Electronic-signature evidence (ESIGN/UETA). The IP is captured
      // server-side (x-forwarded-for) by the notification edge function; here we
      // capture the client-known parts and a unique signature ID shared across
      // the NDA PDF, the signed fund docs, and the DB record.
      const signatureId =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? `sig_${crypto.randomUUID()}`
          : `sig_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const signedAtIso = new Date().toISOString();
      const signerUserAgent = typeof navigator !== 'undefined' ? navigator.userAgent : '';
      let signedAtLocal = '';
      try {
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        signedAtLocal = `${new Date(signedAtIso).toLocaleString()} (${tz})`;
      } catch {
        signedAtLocal = new Date(signedAtIso).toLocaleString();
      }
      const signEvidence = {
        userAgent: signerUserAgent,
        signatureId,
        signedAtLocal,
        consentVersion: NDA_CONSENT_VERSION,
      };

      /* PDF generation — non-blocking */
      try {
        if (accessToken) {
          const pdfResult = await generateNDAPdf(
            {
              signerName: trimmedName,
              signerEmail: userEmail || 'unknown@email.com',
              signedAt: signedAtIso,
              ndaVersion: 'v1.0',
              userId,
              // Electronic-signature evidence for the certificate on the PDF.
              signatureId,
              userAgent: signerUserAgent,
              signedAtLocal,
              consentVersion: NDA_CONSENT_VERSION,
              signatureMethod: 'Typed name / click-to-sign',
            },
            accessToken
          );

          if (pdfResult.success && pdfResult.blob) {
            pdfBlob = pdfResult.blob;
            const uploadResult = await uploadSignedNDA(userId, pdfResult.blob);
            if (uploadResult.success && uploadResult.url) {
              generatedPdfUrl = uploadResult.url;
            }
          }
        }
      } catch (pdfError) {
        console.warn('[SignNDA] PDF generation/upload failed, continuing:', pdfError);
      }

      /* Documents the user acknowledged — persisted with the signature (the
         consent record) and listed in / attached to the emails. */
      const acknowledgedDocs = FUND_DOCUMENTS.map((d) => d.fullName);

      const result = await signNDA(
        trimmedName,
        NDA_CONSENT_VERSION,
        generatedPdfUrl,
        acknowledgedDocs,
        NDA_CONSENT_VERSION,
      );

      if (!isMountedRef.current) return;

      if (result.success) {
        // Notify only on a first sign or a genuine version change — an accidental
        // re-sign of the same version emails no one. (Old RPC without the signal
        // returns shouldNotify=undefined → default to notifying.)
        if (result.shouldNotify !== false) {
          sendNDANotification(
            trimmedName,
            result.signedAt || signedAtIso,
            result.ndaVersion || NDA_CONSENT_VERSION,
            generatedPdfUrl,
            pdfBlob,
            acknowledgedDocs,
            accessToken,
            undefined, // signerIp — captured server-side from x-forwarded-for
            signEvidence,
          ).catch((err) => console.error('[SignNDA] Notification failed:', err));
        }

        toast({
          title: 'agreements signed successfully',
          description: 'thank you for signing the NDA and acknowledging the fund documents.',
          status: 'success',
          duration: 4000,
          isClosable: true,
        });

        const redirectTo = sessionStorage.getItem('nda_redirect_after') || '/';
        sessionStorage.removeItem('nda_redirect_after');
        navigate(redirectTo, { replace: true });
      } else {
        toast({
          title: 'error signing agreements',
          description: result.error || 'an error occurred. please try again.',
          status: 'error',
          duration: 5000,
          isClosable: true,
        });
      }
    } catch (error) {
      console.error('[SignNDA] Unexpected error:', error);
      if (isMountedRef.current) {
        toast({
          title: 'error',
          description: 'an unexpected error occurred. please try again.',
          status: 'error',
          duration: 5000,
          isClosable: true,
        });
      }
    } finally {
      if (isMountedRef.current) setIsSubmitting(false);
    }
  }, [
    location.hash,
    location.pathname,
    location.search,
    navigate,
    revalidateSession,
    session?.access_token,
    signerName,
    toast,
    userEmail,
    userId,
    validateForm,
    isSubmitting,
  ]);

  const reviewedCount = FUND_DOCUMENTS.filter((d) => docAcknowledged[d.id]).length;
  const reviewProgress = (reviewedCount / FUND_DOCUMENTS.length) * 100;
  const scrollToSection = useCallback((sectionId: string) => {
    document.getElementById(sectionId)?.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
    });
  }, []);

  /* Loading state */
  if (isLoading) {
    return (
      <div
        className="flex min-h-screen items-center justify-center bg-[#FFFFFF] text-[#1D1D1F] antialiased"
        style={{ fontFamily: appleFont }}
      >
        <SmallSpinner label="Loading agreements" />
      </div>
    );
  }

  /* ─── RENDER ─── */
  return (
    <div
      className="flex min-h-screen flex-col bg-white text-[#202124] antialiased selection:bg-[#1D1D1F] selection:text-white"
      style={{ fontFamily: appleFont }}
    >
      <HushhTechHeader />

      <main id="main-content" className="flex-grow">
        <AppleSection tone="light" pad="tight" fill>
          <div className="relative z-[1]">
            <Eyebrow>Investor Agreements</Eyebrow>
            <Display as="h1" size="md" maxWidth="max-w-[640px]">
              Review, acknowledge, sign.
            </Display>
            <Lede className="max-w-[560px]">
              Review the NDA, download the fund documents, and sign to access
              confidential investment materials.
            </Lede>
            <div className="mt-7 flex flex-col justify-center gap-3 px-6 sm:flex-row">
              <PillButton
                onClick={() => scrollToSection('nda-terms')}
                className="w-full sm:w-auto"
              >
                Start review
              </PillButton>
              <PillButton
                kind="ghost"
                onClick={() => scrollToSection('signature')}
                className="w-full sm:w-auto"
              >
                Go to signature
              </PillButton>
            </div>

            <div className="mt-7 flex flex-wrap items-center justify-center gap-x-4 gap-y-2 px-6 text-center text-[12px] text-[#1D1D1F]/55">
              <span>NDA</span>
              <span className="h-1 w-1 rounded-full bg-[#1D1D1F]/25" />
              <span>Fund documents</span>
              <span className="h-1 w-1 rounded-full bg-[#1D1D1F]/25" />
              <span>Digital signature</span>
            </div>
          </div>
        </AppleSection>

        <StepCardStack />

        <AppleSection tone="gray" pad="normal" last>
          <div className="mx-auto mb-8 max-w-3xl text-center sm:mb-10">
            <Eyebrow>Investor Agreements</Eyebrow>
            <Display size="sm" maxWidth="max-w-[580px]">
              Review the NDA, fund documents, and signature.
            </Display>
            <Lede className="max-w-[500px]">
              Review the NDA, download the fund documents, and sign to access confidential investment materials.
            </Lede>
          </div>
          <div className="mx-auto grid max-w-5xl grid-cols-1 gap-6 px-5 lg:grid-cols-[minmax(0,1fr)_360px] lg:gap-8">
            <div className="space-y-6">
              <section
                id="nda-terms"
                className="scroll-mt-28 rounded-[30px] border border-[#1D1D1F]/[0.08] bg-white p-4 shadow-[0_18px_60px_rgba(29,29,31,0.05)] sm:p-5"
              >
                <div className="flex items-center gap-3 rounded-[24px] bg-[#F5F5F7] px-3 py-3 shadow-[inset_0_0_0_1px_rgba(29,29,31,0.04)]">
                  <AppleLineIcon icon={ShieldCheck} size={34} iconSize={16} className="shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-[10px] font-semibold uppercase tracking-[1.5px] text-[#1D1D1F]/50">
                      Step 01
                    </p>
                    <h2 className="mt-0.5 truncate text-[18px] font-medium leading-[1.1] tracking-[-0.028em] text-[#1D1D1F] sm:text-[21px]">
                      Non-Disclosure Agreement
                    </h2>
                  </div>
                </div>

                <div className="mt-3 overflow-hidden rounded-[24px] border border-[#1D1D1F]/[0.08] bg-white shadow-[0_6px_24px_rgba(29,29,31,0.03)]">
                  <button
                    type="button"
                    aria-expanded={openNdaItem === 'all'}
                    onClick={() => setOpenNdaItem((current) => current === 'all' ? null : 'all')}
                    className="flex w-full items-center gap-3 px-3.5 py-3 text-left transition hover:bg-[#F5F5F7] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1D1D1F]/20"
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl bg-[#F5F5F7] text-[#1D1D1F]/70">
                      <FileText aria-hidden="true" size={16} strokeWidth={1.55} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-semibold uppercase tracking-[1.5px] text-[#1D1D1F]/74">
                        View NDA terms
                      </span>
                      <span className="mt-0.5 block truncate text-[12px] leading-[1.35] text-[#1D1D1F]/58">
                        Agreement overview and 6 clauses
                      </span>
                    </span>
                    <ChevronDown
                      aria-hidden="true"
                      size={18}
                      strokeWidth={1.65}
                      className={`shrink-0 text-[#1D1D1F]/50 transition-transform ${
                        openNdaItem === 'all' ? 'rotate-180' : ''
                      }`}
                    />
                  </button>
                  {openNdaItem === 'all' ? (
                    <div className="max-h-[280px] overflow-y-auto border-t border-[#1D1D1F]/[0.08] bg-[#F5F5F7] px-4 py-4">
                      <div className="space-y-4">
                        <div>
                          <p className="text-[11px] font-semibold uppercase tracking-[1.5px] text-[#1D1D1F]/62">
                            Mutual non-disclosure agreement
                          </p>
                          <p className="mt-2 text-[14px] leading-[1.65] text-[#1D1D1F]/72">
                            This Non-Disclosure Agreement ("Agreement") is entered into
                            between Hushh Technologies LLC ("Hushh") and the undersigned
                            party ("Recipient").
                          </p>
                        </div>
                        {NDA_SECTIONS.map((section) => (
                          <div key={section.title} className="border-t border-[#1D1D1F]/10 pt-4">
                            <p className="text-[11px] font-semibold uppercase tracking-[1.5px] text-[#1D1D1F]/62">
                              {section.title}
                            </p>
                            <p className="mt-2 text-[14px] leading-[1.65] text-[#1D1D1F]/72">
                              {section.body}
                            </p>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              </section>

              <section
                id="fund-documents"
                className="scroll-mt-28"
              >
                <p
                  className="mb-2 px-1 text-[11px] font-medium uppercase tracking-[1.6px] text-[#0066CC]/85"
                  style={{ fontFamily: appleFont }}
                >
                  Step 02
                </p>

                <div className="overflow-hidden rounded-[16px] bg-[#FFFFFF] shadow-[0_0_0_0.5px_rgba(29,29,31,0.06)]">
                  <div className="relative flex items-start gap-3 px-4 py-5 md:px-5">
                    <div className="mt-0.5 shrink-0">
                      <AppIcon kind="layers" size={38} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <h2
                        className="text-[24px] font-medium leading-[1.06] tracking-[-0.028em] text-[#1D1D1F] sm:text-[30px]"
                        style={{ fontFamily: appleFont }}
                      >
                        Fund Documents
                      </h2>
                      <p
                        className="mt-2 max-w-2xl text-[14px] font-normal leading-[1.4] tracking-normal text-[#1D1D1F]/60 sm:text-[15px]"
                        style={{ fontFamily: appleFont }}
                      >
                        Download and review each document, then confirm it below.
                      </p>
                    </div>
                    <span className="absolute bottom-0 left-5 right-5 h-px bg-[#000000]/[0.10]" />
                  </div>

                  {FUND_DOCUMENTS.map((doc) => {
                    const isChecked = docAcknowledged[doc.id];
                    const isOpen = openFundDocument === doc.id;
                    const iconKind = getDocumentIconKind(doc.id);
                    const docNumber = String(
                      FUND_DOCUMENTS.findIndex((item) => item.id === doc.id) + 1
                    ).padStart(2, '0');
                    const isLastDocument = doc.id === FUND_DOCUMENTS[FUND_DOCUMENTS.length - 1].id;

                    return (
                      <div
                        key={doc.id}
                        className={`relative transition ${isChecked ? 'bg-[#F5F5F7]' : 'bg-[#FFFFFF]'}`}
                      >
                        <div className="flex items-start gap-3 px-4 py-4 md:px-5">
                          <button
                            type="button"
                            aria-expanded={isOpen}
                            onClick={() => setOpenFundDocument((current) => current === doc.id ? null : doc.id)}
                            className="flex min-w-0 flex-1 items-start gap-3 rounded-[14px] text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0066CC]/35"
                          >
                            <span className="mt-0.5 shrink-0">
                              <AppIcon kind={iconKind} size={34} />
                            </span>
                            <span className="min-w-0 flex-1">
                              <span
                                className="mb-1 block text-[11px] font-semibold tracking-[0.08em] text-[#1D1D1F]/45"
                                style={{ fontFamily: appleFont }}
                              >
                                DOC {docNumber}
                              </span>
                              <span
                                className="block text-[17px] font-medium leading-[1.06] tracking-[-0.028em] text-[#1D1D1F]"
                                style={{ fontFamily: appleFont }}
                              >
                                {doc.name}
                              </span>
                              <span
                                className="mt-1 block text-[14px] leading-[1.4] tracking-normal text-[#1D1D1F]/60"
                                style={{ fontFamily: appleFont }}
                              >
                                {isChecked ? 'Reviewed' : doc.description}
                              </span>
                            </span>
                          </button>

                          <div className="flex shrink-0 items-center gap-2">
                            <label className={`flex h-9 cursor-pointer items-center gap-2 rounded-full px-3 text-[12px] font-medium tracking-[-0.01em] transition ${
                              isChecked ? 'bg-[#0066CC] text-white' : 'bg-[#F5F5F7] text-[#1D1D1F]/70'
                            }`}>
                              <input
                                type="checkbox"
                                checked={isChecked}
                                onChange={() => handleDocToggle(doc.id)}
                                className="h-4 w-4 shrink-0 accent-[#0066CC]"
                                aria-label={`Mark ${doc.name} reviewed`}
                              />
                              <span className="hidden md:inline">
                                {isChecked ? 'Reviewed' : 'Mark'}
                              </span>
                            </label>

                            <button
                              type="button"
                              aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${doc.name}`}
                              aria-expanded={isOpen}
                              onClick={() => setOpenFundDocument((current) => current === doc.id ? null : doc.id)}
                              className="flex h-9 w-9 items-center justify-center rounded-full bg-[#F5F5F7] text-[#1D1D1F]/55 transition hover:bg-[#ececef] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0066CC]/35"
                            >
                              <ChevronDown
                                aria-hidden="true"
                                size={17}
                                strokeWidth={1.65}
                                className={`transition-transform ${isOpen ? 'rotate-180' : ''}`}
                              />
                            </button>
                          </div>
                        </div>

                        {isOpen ? (
                          <div className="mx-4 mb-4 rounded-[14px] bg-[#F5F5F7] px-4 py-4 md:ml-[74px] md:mr-5">
                            <p className="text-[11px] font-medium uppercase tracking-[1.6px] text-[#0066CC]/85">
                              {doc.fullName}
                            </p>
                            <p className="mt-2 text-[14px] leading-[1.45] tracking-normal text-[#1D1D1F]/65">
                              {doc.description}
                            </p>
                            <div className="mt-4 flex flex-wrap gap-2">
                              <button
                                type="button"
                                onClick={() => handleReadDocument(doc.url, doc.name)}
                                className="inline-flex h-9 items-center gap-1.5 rounded-full bg-white px-3.5 text-[12px] font-medium text-[#0066CC] transition hover:bg-[#ececef] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0066CC]/35"
                                aria-label={`Read ${doc.name}`}
                              >
                                <FileSearch2 aria-hidden="true" size={14} strokeWidth={1.65} />
                                Read
                              </button>
                              <button
                                type="button"
                                onClick={() => handleDownload(doc.url, `${doc.fullName}.docx`)}
                                className="inline-flex h-9 items-center gap-1.5 rounded-full bg-[#1D1D1F] px-3.5 text-[12px] font-medium text-white transition hover:bg-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0066CC]/35"
                                aria-label={`Download ${doc.name}`}
                              >
                                <FileDown aria-hidden="true" size={14} strokeWidth={1.65} />
                                Download
                              </button>
                            </div>
                          </div>
                        ) : null}
                        {!isLastDocument ? (
                          <span className="absolute bottom-0 left-16 right-0 h-px bg-[#000000]/[0.10] md:left-[74px]" />
                        ) : null}
                      </div>
                    );
                  })}
                </div>

                <div className="mt-3 rounded-[16px] bg-[#FFFFFF] px-5 py-4 shadow-[0_0_0_0.5px_rgba(29,29,31,0.06)]">
                  <div className="flex items-center gap-3">
                    <div className="h-2 flex-1 overflow-hidden rounded-full bg-[#1D1D1F]/10">
                      <div
                        className="h-full rounded-full bg-[#0066CC] transition-all duration-300"
                        style={{ width: `${reviewProgress}%` }}
                      />
                    </div>
                    <span className="shrink-0 text-[11px] font-semibold uppercase tracking-[1.5px] text-[#1D1D1F]/58">
                      {reviewedCount}/{FUND_DOCUMENTS.length} reviewed
                    </span>
                  </div>
                </div>
              </section>
            </div>

            <aside
              id="signature"
              className="scroll-mt-28 rounded-[30px] bg-[#FFFFFF] p-5 text-[#1D1D1F] shadow-[0_20px_60px_rgba(29,29,31,0.10),inset_0_0_0_0.5px_rgba(29,29,31,0.10)] sm:p-6 lg:sticky lg:top-28 lg:self-start"
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-[11px] font-medium uppercase tracking-[1.6px] text-[#0066CC]/85">
                    Step 03
                  </p>
                  <h2 className="mt-3 text-[30px] font-medium leading-[1.06] tracking-[-0.028em] text-[#1D1D1F] sm:text-[32px]">
                    Digital Signature
                  </h2>
                  <p className="mt-3 text-[15px] font-light leading-[1.45] text-[#1D1D1F]/60">
                    Use your full legal name to complete the agreement.
                  </p>
                </div>
                <AppleLineIcon icon={Signature} size={52} iconSize={24} className="shrink-0" />
              </div>

              <div className="mt-6 rounded-[22px] bg-[#F5F5F7] p-4 shadow-[inset_0_0_0_0.5px_rgba(29,29,31,0.08)]">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[11px] font-medium uppercase tracking-[1.5px] text-[#1D1D1F]/55">
                    Review status
                  </span>
                  <span className="text-[13px] font-medium text-[#1D1D1F]">
                    {reviewedCount}/{FUND_DOCUMENTS.length}
                  </span>
                </div>
                <div className="mt-3 h-2 overflow-hidden rounded-full bg-[#D2D2D7]">
                  <div
                    className="h-full rounded-full bg-[#0066CC] transition-all duration-300"
                    style={{ width: `${reviewProgress}%` }}
                  />
                </div>
              </div>

              <div className="mt-4 rounded-[22px] bg-[#F5F5F7] p-4 shadow-[inset_0_0_0_0.5px_rgba(29,29,31,0.08)]">
                <label className="flex items-center gap-3">
                  <UserRound aria-hidden="true" size={18} strokeWidth={1.65} className="text-[#1D1D1F]/60" />
                  <span className="shrink-0 text-[13px] font-medium text-[#1D1D1F]">
                    Full Legal Name
                  </span>
                </label>
                <input
                  type="text"
                  value={signerName}
                  onChange={(e) => {
                    setSignerName(e.target.value);
                    if (nameError) setNameError('');
                  }}
                  placeholder="required"
                  className="mt-4 h-12 w-full rounded-2xl border border-[#1D1D1F]/[0.08] bg-[#FFFFFF] px-4 text-[15px] font-medium text-[#1D1D1F] outline-none transition placeholder:text-[#1D1D1F]/35 focus:border-[#0066CC]/45 focus:bg-white focus:ring-4 focus:ring-[#0066CC]/12"
                />
                {nameError ? (
                  <p className="mt-2 text-[12px] font-medium text-[#BF1D1D]">
                    {nameError}
                  </p>
                ) : null}
              </div>

              <div className="mt-4 rounded-[22px] bg-[#F5F5F7] p-4 text-[#1D1D1F] shadow-[inset_0_0_0_0.5px_rgba(29,29,31,0.08)] transition">
                <label className="flex cursor-pointer items-start gap-3">
                  <input
                    type="checkbox"
                    checked={agreedToTerms}
                    onChange={(e) => {
                      setAgreedToTerms(e.target.checked);
                      if (termsError) setTermsError('');
                    }}
                    className="mt-0.5 h-5 w-5 shrink-0 accent-[#0066CC]"
                  />
                  <span className="text-[13px] leading-[1.58] text-[#1D1D1F]/72">
                    I have read, understood, and agree to the terms of this
                    Non-Disclosure Agreement. I acknowledge that I have reviewed
                    all fund documents and that this constitutes my legal
                    electronic signature.
                  </span>
                </label>
                {termsError ? (
                  <p className="mt-2 text-[12px] font-medium text-[#BF1D1D]">
                    {termsError}
                  </p>
                ) : null}
              </div>

              {userEmail ? (
                <div className="mt-4 flex items-center justify-center gap-1.5 text-[#1D1D1F]/55">
                  <UserRound aria-hidden="true" size={14} strokeWidth={1.65} />
                  <p className="text-[12px]">
                    Signing as <span className="font-medium text-[#1D1D1F]">{userEmail}</span>
                  </p>
                </div>
              ) : null}

              {!canSubmit && signerName.trim().length >= 2 ? (
                <div className="mt-4 rounded-2xl bg-[#F5F5F7] px-4 py-3 text-[13px] leading-[1.55] text-[#1D1D1F]/68 shadow-[inset_0_0_0_0.5px_rgba(29,29,31,0.08)]">
                  {!allDocsAcknowledged ? 'Please acknowledge all fund documents above. ' : ''}
                  {!agreedToTerms ? 'Please agree to the NDA terms.' : ''}
                </div>
              ) : null}

              <button
                type="button"
                onClick={handleSignNDA}
                disabled={!canSubmit}
                className="mt-5 flex h-[52px] w-full items-center justify-center gap-2 rounded-full bg-[#0066CC] px-6 text-[16px] font-medium text-white transition hover:bg-[#005BB5] active:scale-[0.98] disabled:pointer-events-none disabled:opacity-35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0066CC]/40 focus-visible:ring-offset-2 focus-visible:ring-offset-white"
              >
                {isSubmitting ? 'Signing...' : 'Sign and Continue'}
                <ArrowRight aria-hidden="true" size={15} strokeWidth={1.75} />
              </button>

              <p className="mx-auto mt-4 max-w-[320px] text-center text-[11px] leading-[1.6] text-[#1D1D1F]/48">
                By signing, you agree that your digital signature has the same
                legal validity as a handwritten signature under applicable
                electronic signature laws.
              </p>

              <div className="mt-5 flex items-center justify-center gap-2 text-[#1D1D1F]/48">
                <LockKeyhole aria-hidden="true" size={13} strokeWidth={1.65} />
                <span className="text-[10px] font-semibold uppercase tracking-[1.6px]">
                  256 bit encryption
                </span>
              </div>
            </aside>
          </div>
        </AppleSection>
      </main>

      <HushhTechFooter />
    </div>
  );
};

export default SignNDAPage;
