/**
 * Step-3 additional-parties logic — the inline §5 completion dashboard.
 * The primary investor invites the parties their account type requires and tracks
 * each party's status, all inside Step-3 (no new wizard step). Party completion is
 * enforced later at the Step-5 review/submit gate, not here.
 */
import { useCallback, useEffect, useState } from 'react';
import config from '../../../../resources/config/config';
import {
  createInvite,
  resendInvite,
  revokeInvite,
} from '../../../../services/onboarding/inviteService';
import { getAccountTypeConfig, type PartyRole } from '../../../../services/onboarding/accountTypeConfig';
import type { UIAccountType } from '../../../../types/onboarding';

export interface PartyRow {
  partyId: string;
  role: PartyRole;
  displayName: string | null;
  email: string | null;
  status: string;
  inviteId: string | null;
  inviteStatus: string | null;
  inviteExpiresAt: string | null;
}

const PARTY_SELECT = 'id, party_role, display_name, invite_email, status';
const INVITE_SELECT = 'id, party_id, status, expires_at, created_at';

export function useStep3Parties(accountType: UIAccountType | null) {
  const [rows, setRows] = useState<PartyRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [links, setLinks] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    if (!config.gcpBackendClient) return;
    const { data: { user } } = await config.gcpBackendClient.auth.getUser();
    if (!user) return;
    const [{ data: parties }, { data: invites }] = await Promise.all([
      config.gcpBackendClient.from('onboarding_parties').select(PARTY_SELECT).eq('primary_user_id', user.id),
      config.gcpBackendClient.from('onboarding_invites').select(INVITE_SELECT).eq('primary_user_id', user.id),
    ]);
    const latestByParty = new Map<string, { id: string; status: string; expires_at: string | null }>();
    for (const inv of invites || []) {
      const existing = latestByParty.get(inv.party_id);
      if (!existing || String(inv.created_at) > String((existing as { created_at?: string }).created_at ?? '')) {
        latestByParty.set(inv.party_id, inv as never);
      }
    }
    setRows(
      (parties || []).map((p) => {
        const inv = latestByParty.get(p.id);
        return {
          partyId: p.id,
          role: p.party_role as PartyRole,
          displayName: p.display_name,
          email: p.invite_email,
          status: p.status,
          inviteId: inv?.id ?? null,
          inviteStatus: inv?.status ?? null,
          inviteExpiresAt: inv?.expires_at ?? null,
        };
      }),
    );
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const sendInvite = async (role: PartyRole, email: string, displayName?: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await createInvite({ role, email, displayName });
      setLinks((prev) => ({ ...prev, [res.party_id]: res.invite_url }));
      await refresh();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to send invite');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const resend = async (inviteId: string, partyId: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await resendInvite(inviteId);
      setLinks((prev) => ({ ...prev, [partyId]: res.invite_url }));
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to resend invite');
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (inviteId: string) => {
    setBusy(true);
    setError(null);
    try {
      await revokeInvite(inviteId);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to revoke invite');
    } finally {
      setBusy(false);
    }
  };

  const requiredParties = getAccountTypeConfig(accountType).requiredParties;

  return { rows, requiredParties, busy, error, links, sendInvite, resend, revoke, refresh };
}
