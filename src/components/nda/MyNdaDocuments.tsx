import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Check, Download, FileText, ShieldCheck } from "lucide-react";

import { useAuthSession } from "../../auth/AuthSessionProvider";
import { appleFont } from "../hushh-tech-ui/HushhAppleUI";
import { FUND_DOCUMENTS } from "../../services/nda/ndaDocuments";
import { getNDARecord, type NDARecord } from "../../services/nda/ndaService";

interface MyNdaDocumentsProps {
  /**
   * Overrides the outer <section> classes. Defaults to the soft grey card used
   * on the profile page so both surfaces render identically.
   */
  className?: string;
}

const DEFAULT_SECTION_CLASS =
  "mb-12 rounded-[24px] bg-[#F5F5F7] p-5 shadow-[inset_0_0_0_0.5px_rgba(29,29,31,0.08)]";

/**
 * "My NDA & Documents" — the user's signed NDA + the fund documents they
 * reviewed. Self-contained: it fetches the caller's own `nda_signatures` row
 * (RLS-scoped, returns null when unsigned) and renders the loading / signed /
 * not-signed states.
 *
 * Reused by the payment-gated profile page AND the auth-only `/my-documents`
 * page, so ANY signed-in user can always retrieve the NDA they signed —
 * independent of payment status. Single source of truth for this surface.
 */
export default function MyNdaDocuments({ className }: MyNdaDocumentsProps) {
  const navigate = useNavigate();
  const { status, user } = useAuthSession();
  const [ndaRecord, setNdaRecord] = useState<NDARecord | null>(null);
  const [ndaLoading, setNdaLoading] = useState(true);
  const [ndaError, setNdaError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let active = true;
    if (status === "booting") return;
    if (status !== "authenticated" || !user) {
      setNdaLoading(false);
      return;
    }
    setNdaLoading(true);
    setNdaError(null);
    getNDARecord(user.id)
      .then((rec) => {
        if (active) setNdaRecord(rec);
      })
      .catch((error: unknown) => {
        if (active) setNdaError(error instanceof Error ? error.message : "Unable to load your agreement.");
      })
      .finally(() => {
        if (active) setNdaLoading(false);
      });
    return () => {
      active = false;
    };
  }, [status, user, retry]);

  return (
    <section className={className ?? DEFAULT_SECTION_CLASS}>
      <div className="mb-4 flex items-center gap-2.5">
        <ShieldCheck className="h-5 w-5 text-[#0066CC]" />
        <h2
          className="text-[24px] font-medium leading-[1.06] tracking-[-0.028em] text-[#1D1D1F]"
          style={{ fontFamily: appleFont }}
        >
          My NDA &amp; Documents.
        </h2>
      </div>

      {ndaError ? (
        <div role="alert">
          <p>{ndaError}</p>
          <button type="button" onClick={() => setRetry((value) => value + 1)}>Retry agreement lookup</button>
        </div>
      ) : ndaLoading ? (
        <div className="flex items-center gap-3 py-6 text-[14px] text-[#1D1D1F]/55">
          <div className="h-5 w-5 animate-spin rounded-full border-b-2 border-[#0066CC]" />
          Loading your agreement…
        </div>
      ) : ndaRecord ? (
        <>
          <div className="rounded-[18px] bg-white p-4 shadow-[inset_0_0_0_0.5px_rgba(29,29,31,0.08)] sm:p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Check className="h-4 w-4 shrink-0 text-[#34C759]" />
                  <span className="text-[15px] font-semibold text-[#1D1D1F]">
                    Non-Disclosure Agreement signed
                  </span>
                </div>
                <p className="mt-1 text-[13px] text-[#1D1D1F]/55">
                  {ndaRecord.signerName ? `Signed by ${ndaRecord.signerName}` : "Signed"}
                  {ndaRecord.signedAt
                    ? ` · ${new Date(ndaRecord.signedAt).toLocaleDateString("en-US", { dateStyle: "medium" })}`
                    : ""}
                  {ndaRecord.ndaVersion ? ` · ${ndaRecord.ndaVersion}` : ""}
                </p>
              </div>
              {ndaRecord.pdfUrl ? (
                <a
                  href={ndaRecord.pdfUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-[#0066CC] px-4 py-2 text-[13px] font-medium text-white transition hover:opacity-90"
                >
                  <Download className="h-4 w-4" /> Download
                </a>
              ) : (
                <span className="shrink-0 text-[12px] text-[#1D1D1F]/45">PDF unavailable</span>
              )}
            </div>
          </div>

          <div className="mt-4">
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-[#1D1D1F]/45">
              Documents you reviewed
            </div>
            <div className="overflow-hidden rounded-[18px] bg-white shadow-[inset_0_0_0_0.5px_rgba(29,29,31,0.08)]">
              {FUND_DOCUMENTS.map((doc, idx) => (
                <div
                  key={doc.id}
                  className="flex items-center gap-3 px-4 py-3"
                  style={{ borderTop: idx === 0 ? "none" : "0.5px solid rgba(29,29,31,0.08)" }}
                >
                  <FileText className="h-4 w-4 shrink-0 text-[#1D1D1F]/40" />
                  <div className="min-w-0">
                    <div className="truncate text-[14px] font-medium text-[#1D1D1F]">{doc.name}</div>
                    <div className="truncate text-[12px] text-[#1D1D1F]/50">{doc.description}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      ) : (
        <div className="rounded-[18px] bg-white p-6 text-center shadow-[inset_0_0_0_0.5px_rgba(29,29,31,0.08)]">
          <p className="text-[14px] text-[#1D1D1F]/60">
            You haven&rsquo;t signed the Non-Disclosure Agreement yet.
          </p>
          <button
            type="button"
            onClick={() => navigate("/sign-nda")}
            className="mt-4 inline-flex items-center gap-1.5 rounded-full bg-[#0066CC] px-5 py-2.5 text-[14px] font-medium text-white transition hover:opacity-90"
          >
            <ShieldCheck className="h-4 w-4" /> Sign the NDA
          </button>
        </div>
      )}
    </section>
  );
}
