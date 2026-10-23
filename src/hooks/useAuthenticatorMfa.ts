import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';

/**
 * Staff authenticator-app (TOTP) step-up. Logic only: the enrol and challenge screens are UI.
 * Design: docs/security/mfa-enforcement-design.md, hand-off: docs/security/mfa-ui-handoff.md.
 *
 * IMPORTANT for whoever renders this: when the server mode is 'admin' or 'all', a staff session that
 * has not completed the second step can read NO table. Call this hook and show the enrol or challenge
 * screen BEFORE loading roles, profile or any data. Everything here uses the auth API and one RPC
 * (my_staff_mfa_status), which keep working at the password-only level.
 *
 * stage:
 *   'loading'      status not known yet
 *   'not_required' nothing to do (not staff, or the server is not enforcing for this account)
 *   'prompt'       not enforced yet but this staff member has no authenticator: offer to set one up
 *   'enrol'        required and no authenticator: show the QR code, then verifyEnrol(code)
 *   'challenge'    required, authenticator exists, session is password-only: ask for the code
 *   'verified'     session is already at the authenticator level
 */
export type AuthenticatorStage = 'loading' | 'not_required' | 'prompt' | 'enrol' | 'challenge' | 'verified';

interface MfaStatus {
  mode: 'off' | 'shadow' | 'admin' | 'all';
  is_staff: boolean;
  is_admin: boolean;
  enrolled: boolean;
  required: boolean;
  prompt: boolean;
}

interface EnrolData {
  factorId: string;
  qrSvg: string; // data URI (svg) to show as an image
  secret: string; // manual-entry key
}

export function useAuthenticatorMfa(userId: string | undefined) {
  const [stage, setStage] = useState<AuthenticatorStage>('loading');
  const [status, setStatus] = useState<MfaStatus | null>(null);
  const [enrol, setEnrol] = useState<EnrolData | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!userId) {
      setStage('loading');
      return;
    }
    const { data: raw, error: statusErr } = await (supabase as any).rpc('my_staff_mfa_status');
    if (statusErr || !raw) {
      // Fail open for display only: the server still enforces. Never block the app on a status failure.
      setStage('not_required');
      return;
    }
    const s = raw as MfaStatus;
    setStatus(s);

    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (aal?.currentLevel === 'aal2') {
      setStage('verified');
      return;
    }
    if (s.required) {
      setStage(s.enrolled ? 'challenge' : 'enrol');
      return;
    }
    setStage(s.prompt ? 'prompt' : 'not_required');
  }, [userId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** Create a pending authenticator and return the QR code to display. */
  const startEnrol = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      // Remove an abandoned, never-verified factor first so enrolment can be retried.
      const { data: list } = await supabase.auth.mfa.listFactors();
      for (const f of (list?.all ?? []) as Array<{ id: string; status: string; factor_type: string }>) {
        if (f.factor_type === 'totp' && f.status !== 'verified') await supabase.auth.mfa.unenroll({ factorId: f.id });
      }
      const { data, error: enrolErr } = await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Welile authenticator' });
      if (enrolErr || !data) throw enrolErr ?? new Error('Could not start set-up');
      const e = { factorId: data.id, qrSvg: data.totp.qr_code, secret: data.totp.secret };
      setEnrol(e);
      return e;
    } catch (err) {
      setError((err as Error).message || 'Could not start set-up');
      return null;
    } finally {
      setBusy(false);
    }
  }, []);

  /** Confirm the first 6-digit code from the authenticator app; upgrades this session. */
  const verifyEnrol = useCallback(
    async (code: string) => {
      if (!enrol) return { ok: false };
      setBusy(true);
      setError(null);
      const { error: vErr } = await supabase.auth.mfa.challengeAndVerify({ factorId: enrol.factorId, code: code.replace(/\D/g, '') });
      setBusy(false);
      if (vErr) {
        setError(vErr.message || 'That code was not accepted. Check the time on your phone and try again.');
        return { ok: false };
      }
      setEnrol(null);
      await supabase.auth.refreshSession(); // new token carries aal2
      await refresh();
      return { ok: true };
    },
    [enrol, refresh],
  );

  /** Ask for the 6-digit code at sign-in when an authenticator already exists. */
  const verifyChallenge = useCallback(
    async (code: string) => {
      setBusy(true);
      setError(null);
      const { data: list } = await supabase.auth.mfa.listFactors();
      const factor = list?.totp?.[0];
      if (!factor) {
        setBusy(false);
        setError('No authenticator found for this account. Ask a super admin to reset it.');
        return { ok: false };
      }
      const { error: vErr } = await supabase.auth.mfa.challengeAndVerify({ factorId: factor.id, code: code.replace(/\D/g, '') });
      setBusy(false);
      if (vErr) {
        setError(vErr.message || 'That code was not accepted.');
        return { ok: false };
      }
      await supabase.auth.refreshSession();
      await refresh();
      return { ok: true };
    },
    [refresh],
  );

  return { stage, status, enrol, busy, error, startEnrol, verifyEnrol, verifyChallenge, refresh };
}
