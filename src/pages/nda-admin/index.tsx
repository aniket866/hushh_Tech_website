/**
 * NDA Admin Page
 * 
 * Simple password-protected admin page to view all NDA signed agreements.
 * Password: 123456
 * Design: Simple black/white table with no colors.
 * 
 * Uses GcpBackend Edge Function to bypass RLS and fetch all NDA records.
 */

import React, { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import config from '../../resources/config/config';

interface NDARecord {
  user_id: string;
  full_name: string;
  email: string;
  nda_signed_at: string;
  nda_version: string;
  nda_signer_ip: string;
  nda_signer_name: string;
  nda_pdf_url: string | null;
}

const ADMIN_PASSWORD = '123456';
const NDA_ADMIN_FETCH_URL = `${config.GCP_API_BASE_URL}/functions/v1/nda-admin-fetch`;

const NDAAdminPage: React.FC = () => {
  const [searchParams] = useSearchParams();
  const highlightUserId = searchParams.get('highlight');
  
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [password, setPassword] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [ndaRecords, setNdaRecords] = useState<NDARecord[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Check if already authenticated in session
  useEffect(() => {
    const auth = sessionStorage.getItem('nda_admin_auth');
    if (auth === 'true') {
      setIsAuthenticated(true);
    }
  }, []);

  // Fetch NDA records when authenticated
  useEffect(() => {
    if (isAuthenticated) {
      fetchNDARecords();
    }
  }, [isAuthenticated]);

  const handleLogin = () => {
    if (password === ADMIN_PASSWORD) {
      setIsAuthenticated(true);
      sessionStorage.setItem('nda_admin_auth', 'true');
      setPasswordError('');
    } else {
      setPasswordError('Incorrect password');
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleLogin();
    }
  };

  const fetchNDARecords = async () => {
    setIsLoading(true);
    setError(null);

    try {
      if (!config.FIREBASE_API_KEY) {
        throw new Error('VITE_FIREBASE_API_KEY is not configured');
      }

      // Call the edge function with password for authentication
      const response = await fetch(NDA_ADMIN_FETCH_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.FIREBASE_API_KEY}`,
        },
        body: JSON.stringify({
          password: ADMIN_PASSWORD,
          highlightUserId: highlightUserId || undefined,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(errorData.error || `HTTP ${response.status}`);
      }

      const data = await response.json();

      if (!data.success) {
        throw new Error(data.error || 'Failed to fetch NDA records');
      }

      setNdaRecords(data.records || []);
    } catch (err) {
      console.error('Error fetching NDA records:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch NDA records');
    } finally {
      setIsLoading(false);
    }
  };

  const formatDate = (dateString: string | null): string => {
    if (!dateString) return 'N/A';
    try {
      return new Date(dateString).toLocaleString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return dateString;
    }
  };

  // Password login screen
  if (!isAuthenticated) {
    return (
      <div style={styles.container}>
        <div style={styles.loginBox}>
          <h1 style={styles.title}>NDA Admin</h1>
          <p style={styles.subtitle}>Enter password to access NDA records</p>
          
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyPress={handleKeyPress}
            placeholder="Password"
            style={styles.input}
            autoFocus
          />
          
          {passwordError && (
            <p style={styles.error}>{passwordError}</p>
          )}
          
          <button onClick={handleLogin} style={styles.button}>
            Login
          </button>
        </div>
      </div>
    );
  }

  // Loading state
  if (isLoading) {
    return (
      <div style={styles.container}>
        <p style={styles.loading}>Loading NDA records...</p>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div style={styles.container}>
        <p style={styles.error}>Error: {error}</p>
        <button onClick={fetchNDARecords} style={styles.button}>
          Retry
        </button>
      </div>
    );
  }

  // Main admin table
  return (
    <div style={styles.container}>
      <h1 style={styles.pageTitle}>NDA Agreements Signed</h1>
      <p style={styles.recordCount}>Total: {ndaRecords.length} records</p>
      
      <div style={styles.tableWrapper}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Name</th>
              <th style={styles.th}>Email</th>
              <th style={styles.th}>Signed At</th>
              <th style={styles.th}>Version</th>
              <th style={styles.th}>IP Address</th>
              <th style={styles.th}>PDF</th>
              <th style={styles.th}>User ID</th>
            </tr>
          </thead>
          <tbody>
            {ndaRecords.length === 0 ? (
              <tr>
                <td colSpan={7} style={styles.noData}>No NDA records found</td>
              </tr>
            ) : (
              ndaRecords.map((record) => (
                <tr 
                  key={record.user_id}
                  style={{
                    ...styles.tr,
                    backgroundColor: highlightUserId === record.user_id ? '#ffffcc' : 'white',
                  }}
                >
                  <td style={styles.td}>{record.nda_signer_name || record.full_name || 'N/A'}</td>
                  <td style={styles.td}>{record.email || 'N/A'}</td>
                  <td style={styles.td}>{formatDate(record.nda_signed_at)}</td>
                  <td style={styles.td}>{record.nda_version || 'v1.0'}</td>
                  <td style={styles.td}>{record.nda_signer_ip || 'N/A'}</td>
                  <td style={styles.td}>
                    {record.nda_pdf_url ? (
                      <a 
                        href={record.nda_pdf_url} 
                        target="_blank" 
                        rel="noopener noreferrer"
                        style={styles.pdfLink}
                      >
                        📄 View PDF
                      </a>
                    ) : (
                      <span style={styles.noPdf}>No PDF</span>
                    )}
                  </td>
                  <td style={styles.tdMono}>{record.user_id}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      
      <button 
        onClick={() => {
          sessionStorage.removeItem('nda_admin_auth');
          setIsAuthenticated(false);
        }} 
        style={styles.logoutButton}
      >
        Logout
      </button>
    </div>
  );
};

// Simple inline styles - black/white only
const styles: { [key: string]: React.CSSProperties } = {
  container: {
    minHeight: '100vh',
    backgroundColor: 'white',
    padding: '40px 20px',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  },
  loginBox: {
    maxWidth: '400px',
    margin: '100px auto',
    textAlign: 'center',
  },
  title: {
    fontSize: '24px',
    fontWeight: 'bold',
    color: 'black',
    marginBottom: '8px',
  },
  subtitle: {
    fontSize: '14px',
    color: 'black',
    marginBottom: '24px',
  },
  input: {
    width: '100%',
    padding: '12px 16px',
    fontSize: '16px',
    border: '1px solid black',
    borderRadius: '4px',
    marginBottom: '16px',
    boxSizing: 'border-box',
  },
  button: {
    width: '100%',
    padding: '12px 24px',
    fontSize: '16px',
    fontWeight: 'bold',
    backgroundColor: 'black',
    color: 'white',
    border: 'none',
    borderRadius: '4px',
    cursor: 'pointer',
  },
  error: {
    color: 'black',
    fontSize: '14px',
    marginBottom: '16px',
    fontWeight: 'bold',
  },
  loading: {
    textAlign: 'center',
    fontSize: '16px',
    color: 'black',
    marginTop: '100px',
  },
  pageTitle: {
    fontSize: '28px',
    fontWeight: 'bold',
    color: 'black',
    textAlign: 'center',
    marginBottom: '8px',
  },
  recordCount: {
    fontSize: '14px',
    color: 'black',
    textAlign: 'center',
    marginBottom: '24px',
  },
  tableWrapper: {
    overflowX: 'auto',
    WebkitOverflowScrolling: 'touch',
    width: '100%',
    maxWidth: '1200px',
    margin: '0 auto',
  },
  table: {
    width: '100%',
    minWidth: '860px',
    borderCollapse: 'collapse',
    border: '1px solid black',
  },
  th: {
    backgroundColor: 'black',
    color: 'white',
    padding: '12px 8px',
    textAlign: 'left',
    fontSize: '14px',
    fontWeight: 'bold',
    borderBottom: '1px solid black',
  },
  tr: {
    borderBottom: '1px solid black',
  },
  td: {
    padding: '10px 8px',
    fontSize: '14px',
    color: 'black',
    borderBottom: '1px solid black',
    borderRight: '1px solid black',
  },
  tdMono: {
    padding: '10px 8px',
    fontSize: '12px',
    color: 'black',
    fontFamily: 'monospace',
    borderBottom: '1px solid black',
  },
  noData: {
    padding: '40px',
    textAlign: 'center',
    color: 'black',
    fontSize: '14px',
  },
  logoutButton: {
    display: 'block',
    margin: '24px auto',
    padding: '10px 20px',
    fontSize: '14px',
    backgroundColor: 'white',
    color: 'black',
    border: '1px solid black',
    borderRadius: '4px',
    cursor: 'pointer',
  },
  pdfLink: {
    color: 'black',
    textDecoration: 'underline',
    fontWeight: 'bold',
    cursor: 'pointer',
    fontSize: '13px',
  },
  noPdf: {
    color: '#999',
    fontSize: '12px',
    fontStyle: 'italic',
  },
};

export default NDAAdminPage;
