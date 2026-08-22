/**
 * /deployments — internal deployments dashboard.
 * Signed Firebase deployment admins can browse UAT and production revisions.
 * Styled to match the home / community Apple UI.
 */
import { useMemo, useState } from "react";
import HushhTechHeader from "../../components/hushh-tech-header/HushhTechHeader";
import SeoHead from "../../components/seo/SeoHead";
import {
  appleFont,
  appleDisplayFont,
  SmallSpinner,
} from "../../components/hushh-tech-ui/HushhAppleUI";
import { useDeploymentsDashboard, type Deployment } from "./logic";

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

const EnvChip = ({ env }: { env: "UAT" | "PROD" }) => {
  const prod = env === "PROD";
  return (
    <span
      className="inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.05em]"
      style={{
        background: prod ? "rgba(52,199,89,0.12)" : "rgba(0,102,204,0.10)",
        color: prod ? "#1D7A3A" : "#0066CC",
        fontFamily: appleFont,
      }}
    >
      {env}
    </span>
  );
};

const StatusChip = ({ live }: { live: boolean }) => (
  <span
    className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold"
    style={{
      background: live ? "rgba(52,199,89,0.12)" : "rgba(29,29,31,0.06)",
      color: live ? "#1D7A3A" : "rgba(29,29,31,0.55)",
      fontFamily: appleFont,
    }}
  >
    <span
      className="h-1.5 w-1.5 rounded-full"
      style={{ background: live ? "#34C759" : "#9AA1AC" }}
    />
    {live ? "Live" : "Superseded"}
  </span>
);

/* ── Access gate ── */
function AccessCard({ signedIn, onSignOut }: { signedIn: boolean; onSignOut: () => Promise<void> }) {
  return (
    <div className="flex min-h-[70vh] items-center justify-center px-5">
      <div
        className="w-full max-w-[400px] rounded-[24px] bg-white p-8 shadow-[0_2px_18px_rgba(29,29,31,0.06),inset_0_0_0_0.5px_rgba(29,29,31,0.08)]"
      >
        <div
          className="mb-1 text-[12px] font-bold uppercase tracking-[0.14em] text-[#0066CC]/85"
          style={{ fontFamily: appleFont }}
        >
          Internal
        </div>
        <h1
          className="mb-1.5 text-[26px] font-semibold tracking-[-0.025em] text-[#1D1D1F]"
          style={{ fontFamily: appleDisplayFont }}
        >
          Deployments
        </h1>
        <p className="mb-6 text-[13.5px] leading-[1.5] text-[#1D1D1F]/60" style={{ fontFamily: appleFont }}>
          {signedIn ? "Admin access required." : "Sign in required."}
        </p>
        {signedIn ? (
          <button
            type="button"
            onClick={() => void onSignOut()}
            className="w-full rounded-full bg-[#0066CC] px-5 py-3 text-[15px] font-medium text-white transition hover:opacity-90"
            style={{ fontFamily: appleFont }}
          >
            Sign out
          </button>
        ) : (
          <a
            href="/login?redirect=%2Fdeployments"
          className="w-full rounded-full bg-[#0066CC] px-5 py-3 text-[15px] font-medium text-white transition hover:opacity-90"
          style={{ fontFamily: appleFont }}
          >
            Sign in
          </a>
        )}
      </div>
    </div>
  );
}

/* ── Dashboard ── */
export default function DeploymentsPage() {
  const { authStatus, isAuthed, signOut, deployments, envErrors, loading, error, refresh } =
    useDeploymentsDashboard();
  const [envFilter, setEnvFilter] = useState<"All" | "UAT" | "PROD">("All");

  const visible = useMemo(
    () => (envFilter === "All" ? deployments : deployments.filter((d) => d.env === envFilter)),
    [deployments, envFilter],
  );

  const tabs: Array<"All" | "UAT" | "PROD"> = ["All", "UAT", "PROD"];

  return (
    <div
      className="min-h-screen bg-[#FFFFFF] text-[#1D1D1F] antialiased"
      style={{ fontFamily: appleFont }}
    >
      <SeoHead title="Deployments" description="Internal deployments dashboard." path="/deployments" />
      <HushhTechHeader showSearch={false} showTicker={false} />

      <main id="main-content">
        {!isAuthed ? (
          <AccessCard signedIn={authStatus === "authenticated"} onSignOut={signOut} />
        ) : (
          <section className="mx-auto w-full max-w-[1080px] px-5 pb-24 pt-12 md:pt-16">
            {/* Hero */}
            <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
              <div>
                <div
                  className="mb-3 text-[13px] font-bold uppercase tracking-[0.14em] text-[#0066CC]/85"
                  style={{ fontFamily: appleFont }}
                >
                  Internal
                </div>
                <h1
                  className="text-[clamp(30px,4.4vw,46px)] font-semibold leading-[1.05] tracking-[-0.025em] text-[#1D1D1F]"
                  style={{ fontFamily: appleDisplayFont }}
                >
                  Deployments
                </h1>
                <p className="mt-2 max-w-[560px] text-[15px] leading-[1.5] text-[#1D1D1F]/60">
                  Every UAT and PROD build. Open any build to see how the site looked at that point in time.
                </p>
              </div>
              <div className="flex items-center gap-2.5">
                <button
                  type="button"
                  onClick={refresh}
                  className="rounded-full border border-[#1D1D1F]/15 bg-white px-4 py-2 text-[13px] font-medium text-[#1D1D1F] transition hover:bg-[#F5F5F7]"
                >
                  Refresh
                </button>
                <button
                  type="button"
                  onClick={signOut}
                  className="rounded-full px-3 py-2 text-[13px] font-medium text-[#1D1D1F]/55 transition hover:text-[#1D1D1F]"
                >
                  Sign out
                </button>
              </div>
            </div>

            {/* Env filter pills */}
            <div className="mb-6 flex flex-wrap items-center gap-2">
              {tabs.map((t) => {
                const active = envFilter === t;
                const count = t === "All" ? deployments.length : deployments.filter((d) => d.env === t).length;
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setEnvFilter(t)}
                    className={`rounded-full px-4 py-2 text-[13px] font-medium transition ${
                      active
                        ? "bg-[#0066CC] text-white"
                        : "bg-[#F5F5F7] text-[#1D1D1F]/70 hover:bg-[#ECECEE]"
                    }`}
                    style={{ fontFamily: appleFont }}
                  >
                    {t}
                    {!loading && (
                      <span className={active ? "ml-1.5 text-white/70" : "ml-1.5 text-[#1D1D1F]/40"}>
                        {count}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            {/* States */}
            {error && (
              <div className="mb-5 rounded-[16px] bg-[#FF3B30]/10 px-4 py-3 text-[13.5px] font-medium text-[#B42318] shadow-[inset_0_0_0_1px_rgba(255,59,48,0.18)]">
                {error}
              </div>
            )}
            {envErrors.length > 0 && (
              <div className="mb-5 rounded-[16px] bg-[#FF9500]/10 px-4 py-3 text-[12.5px] leading-[1.5] text-[#9A6200] shadow-[inset_0_0_0_1px_rgba(255,149,0,0.22)]">
                {envErrors.map((e) => (
                  <div key={e.env}>
                    <b>{e.env}</b>: {e.error}
                  </div>
                ))}
              </div>
            )}

            {loading ? (
              <div className="py-20">
                <SmallSpinner label="Loading deployments" />
              </div>
            ) : visible.length === 0 ? (
              <div className="px-6 py-16 text-center text-[14px] text-[#1D1D1F]/55">
                No deployments found.
              </div>
            ) : (
              <div className="overflow-hidden rounded-[20px] bg-white shadow-[0_2px_12px_rgba(29,29,31,0.05),inset_0_0_0_0.5px_rgba(29,29,31,0.08)]">
                {visible.map((d, i) => (
                  <DeploymentRow key={`${d.env}-${d.revision}`} d={d} isLast={i === visible.length - 1} />
                ))}
              </div>
            )}
          </section>
        )}
      </main>
    </div>
  );
}

function DeploymentRow({ d, isLast }: { d: Deployment; isLast: boolean }) {
  return (
    <div
      className={`flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-4 ${
        isLast ? "" : "border-b border-[#1D1D1F]/[0.07]"
      }`}
    >
      <div className="flex w-[88px] shrink-0 items-center gap-2">
        <EnvChip env={d.env} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[14px] font-semibold tracking-[-0.01em] text-[#1D1D1F]">
            {formatDateTime(d.createdAt)}
          </span>
          <StatusChip live={d.isLive} />
        </div>
        <div
          className="mt-0.5 truncate text-[12px] text-[#1D1D1F]/50"
          style={{ fontFamily: "SFMono-Regular, Menlo, Consolas, monospace" }}
        >
          {d.revision}
        </div>
      </div>
      <div className="shrink-0">
        {d.buildUrl ? (
          <a
            href={d.buildUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 rounded-full bg-[#0066CC] px-3.5 py-2 text-[13px] font-medium text-white transition hover:opacity-90"
            style={{ fontFamily: appleFont }}
          >
            View this build
          </a>
        ) : (
          <span
            className="inline-flex items-center rounded-full bg-[#F5F5F7] px-3.5 py-2 text-[12px] font-medium text-[#1D1D1F]/40"
            style={{ fontFamily: appleFont }}
            title="This build has no per-build URL (not tagged or expired)."
          >
            No build URL
          </span>
        )}
      </div>
    </div>
  );
}
