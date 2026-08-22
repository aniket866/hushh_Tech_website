import React, { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { useAuthSession } from "../../auth/AuthSessionProvider";

interface NDARecord {
  record_id: string;
  signed_at: string;
  nda_version: string | null;
  pdf_available: boolean;
  highlighted?: boolean;
}

interface NDAAdminResponse {
  success?: boolean;
  records?: NDARecord[];
}

const NDA_ADMIN_FETCH_URL = "/functions/v1/nda-admin-fetch";
const USER_REFERENCE_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

const NDAAdminPage: React.FC = () => {
  const { status, session, user, signOut } = useAuthSession();
  const [searchParams] = useSearchParams();
  const requestedHighlight = searchParams.get("highlight")?.trim() ?? "";
  const highlightUserId = USER_REFERENCE_PATTERN.test(requestedHighlight)
    ? requestedHighlight
    : null;
  const accessToken = session?.access_token ?? null;
  // This is only an early user-interface gate. The GCP service verifies the
  // signed Firebase custom claim again before reading any NDA record.
  const hasFundAdminClaim = user?.app_metadata?.fund_admin === true;

  const [ndaRecords, setNdaRecords] = useState<NDARecord[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchNDARecords = useCallback(async () => {
    if (!accessToken || !hasFundAdminClaim) return;

    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch(NDA_ADMIN_FETCH_URL, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          ...(highlightUserId ? { highlightUserId } : {}),
        }),
      });
      const data = (await response
        .json()
        .catch(() => null)) as NDAAdminResponse | null;

      if (!response.ok || data?.success !== true) {
        if (response.status === 401) throw new Error("Sign in again.");
        if (response.status === 403) throw new Error("Access denied.");
        throw new Error("Records unavailable.");
      }

      setNdaRecords(Array.isArray(data.records) ? data.records : []);
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Records unavailable.",
      );
    } finally {
      setIsLoading(false);
    }
  }, [accessToken, hasFundAdminClaim, highlightUserId]);

  useEffect(() => {
    if (status === "authenticated" && accessToken && hasFundAdminClaim) {
      void fetchNDARecords();
    }
  }, [accessToken, fetchNDARecords, hasFundAdminClaim, status]);

  const formatDate = (dateString: string | null): string => {
    if (!dateString) return "N/A";
    const date = new Date(dateString);
    if (Number.isNaN(date.getTime())) return "N/A";
    return date.toLocaleString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  if (status === "booting" || isLoading) {
    return (
      <div style={styles.container}>
        <p style={styles.loading}>Loading records…</p>
      </div>
    );
  }

  if (status !== "authenticated" || !accessToken) {
    return (
      <div style={styles.container}>
        <div style={styles.messageBox}>
          <h1 style={styles.title}>NDA Admin</h1>
          <p style={styles.subtitle}>Sign in required.</p>
          <a href="/login?redirect=%2Fnda-admin" style={styles.linkButton}>
            Sign in
          </a>
        </div>
      </div>
    );
  }

  if (!hasFundAdminClaim) {
    return (
      <div style={styles.container}>
        <div style={styles.messageBox}>
          <h1 style={styles.title}>NDA Admin</h1>
          <p style={styles.error}>Access denied.</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div style={styles.container}>
        <div style={styles.messageBox}>
          <p style={styles.error}>{error}</p>
          <button onClick={() => void fetchNDARecords()} style={styles.button}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <h1 style={styles.pageTitle}>Signed NDAs</h1>
      <p style={styles.recordCount}>Total: {ndaRecords.length}</p>

      <div style={styles.tableWrapper}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Record</th>
              <th style={styles.th}>Signed</th>
              <th style={styles.th}>Version</th>
              <th style={styles.th}>PDF</th>
            </tr>
          </thead>
          <tbody>
            {ndaRecords.length === 0 ? (
              <tr>
                <td colSpan={4} style={styles.noData}>
                  No records found
                </td>
              </tr>
            ) : (
              ndaRecords.map((record) => (
                <tr
                  key={record.record_id}
                  style={{
                    ...styles.tr,
                    backgroundColor: record.highlighted ? "#ffffcc" : "white",
                  }}
                >
                  <td style={styles.tdMono}>{record.record_id}</td>
                  <td style={styles.td}>{formatDate(record.signed_at)}</td>
                  <td style={styles.td}>{record.nda_version || "v1.0"}</td>
                  <td style={styles.td}>
                    {record.pdf_available ? "Available" : "Not available"}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <button onClick={() => void signOut()} style={styles.logoutButton}>
        Sign out
      </button>
    </div>
  );
};

const styles: { [key: string]: React.CSSProperties } = {
  container: {
    minHeight: "100vh",
    backgroundColor: "white",
    padding: "40px 20px",
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  },
  messageBox: {
    maxWidth: "400px",
    margin: "100px auto",
    textAlign: "center",
  },
  title: {
    fontSize: "24px",
    fontWeight: "bold",
    color: "black",
    marginBottom: "8px",
  },
  subtitle: {
    fontSize: "14px",
    color: "black",
    marginBottom: "24px",
  },
  button: {
    width: "100%",
    padding: "12px 24px",
    fontSize: "16px",
    fontWeight: "bold",
    backgroundColor: "black",
    color: "white",
    border: "none",
    borderRadius: "4px",
    cursor: "pointer",
  },
  linkButton: {
    display: "block",
    padding: "12px 24px",
    fontSize: "16px",
    fontWeight: "bold",
    backgroundColor: "black",
    color: "white",
    borderRadius: "4px",
    textDecoration: "none",
  },
  error: {
    color: "black",
    fontSize: "14px",
    marginBottom: "16px",
    fontWeight: "bold",
  },
  loading: {
    textAlign: "center",
    fontSize: "16px",
    color: "black",
    marginTop: "100px",
  },
  pageTitle: {
    fontSize: "28px",
    fontWeight: "bold",
    color: "black",
    textAlign: "center",
    marginBottom: "8px",
  },
  recordCount: {
    fontSize: "14px",
    color: "black",
    textAlign: "center",
    marginBottom: "24px",
  },
  tableWrapper: {
    overflowX: "auto",
    WebkitOverflowScrolling: "touch",
    width: "100%",
    maxWidth: "1200px",
    margin: "0 auto",
  },
  table: {
    width: "100%",
    minWidth: "860px",
    borderCollapse: "collapse",
    border: "1px solid black",
  },
  th: {
    backgroundColor: "black",
    color: "white",
    padding: "12px 8px",
    textAlign: "left",
    fontSize: "14px",
    fontWeight: "bold",
    borderBottom: "1px solid black",
  },
  tr: { borderBottom: "1px solid black" },
  td: {
    padding: "10px 8px",
    fontSize: "14px",
    color: "black",
    borderBottom: "1px solid black",
    borderRight: "1px solid black",
  },
  tdMono: {
    padding: "10px 8px",
    fontSize: "12px",
    color: "black",
    fontFamily: "monospace",
    borderBottom: "1px solid black",
    borderRight: "1px solid black",
  },
  noData: {
    padding: "40px",
    textAlign: "center",
    color: "black",
    fontSize: "14px",
  },
  logoutButton: {
    display: "block",
    margin: "24px auto",
    padding: "10px 20px",
    fontSize: "14px",
    backgroundColor: "white",
    color: "black",
    border: "1px solid black",
    borderRadius: "4px",
    cursor: "pointer",
  },
};

export default NDAAdminPage;
