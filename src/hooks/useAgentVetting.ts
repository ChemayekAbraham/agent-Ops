/**
 * The signed-in agent's vetting record and every action the vetting screen
 * takes. All writes go through SECURITY DEFINER RPCs (migrations
 * 20261027160000 / 20261027180000); the browser never writes agent_vetting.
 *
 * Codes reuse the existing flows: phone via `sms-otp`, email via
 * `email-verify-request`/`-confirm`, the parent's ID via `national-id-link-otp`.
 * Each confirm is followed by an RPC that stamps the step once the server can
 * see the code was accepted.
 */
import { useCallback, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { useEmailVerification } from '@/hooks/useEmailVerification';
import { uploadIdentityPhoto } from '@/hooks/useIdentityPhotos';
import { captureGps } from '@/lib/captureGps';
import { runPassportFaceCheck, type PassportFaceCheck } from '@/lib/passportFaceCheck';
import { parseAgentVetting, type AgentVetting } from '@/lib/agentVetting';

type RpcResult = { success?: boolean; message?: string; [k: string]: unknown };

export type ResidenceInput = {
  region?: string | null;
  district: string;
  sub_county?: string | null;
  parish?: string | null;
  village: string;
  town?: string | null;
  city?: string | null;
};

export type NextOfKinInput =
  | { useParent: true }
  | { useParent?: false; name: string; phone: string; relationship: string };

export type SubmitResult =
  | { success: true }
  | { success: false; message: string; missing: string[] };

export type ParentIdLinkState = {
  found: boolean;
  has_parent: boolean;
  request_id?: string;
  status?: 'awaiting_owner' | 'owner_approved' | 'active' | 'expired' | 'rejected_by_owner' | 'rejected_by_staff' | 'cancelled_by_requester';
  code_sent_at?: string | null;
  code_verified_at?: string | null;
  owner_confirmed_at?: string | null;
  decision_reason?: string | null;
  expires_at?: string | null;
  nin_masked?: string | null;
};

const rpc = (fn: string, args?: Record<string, unknown>) => (supabase.rpc as any)(fn, args);

/** RPCs answer `{ success: false, message }` for things the agent can fix; throw those as plain errors. */
async function callRpc(fn: string, args?: Record<string, unknown>): Promise<RpcResult> {
  const { data, error } = await rpc(fn, args);
  if (error) throw new Error(error.message);
  const r = (data ?? {}) as RpcResult;
  if (r.success === false) throw new Error(r.message ?? 'That did not work. Please try again.');
  return r;
}

/** Edge functions signal failure by status code, so the body carries the reason. */
async function fnError(err: unknown, fallback: string): Promise<Error> {
  const ctx = (err as { context?: Response })?.context;
  if (ctx && typeof ctx.json === 'function') {
    try {
      const body = await ctx.json();
      return new Error(body?.error ?? body?.message ?? fallback);
    } catch {
      /* fall through */
    }
  }
  return new Error(fallback);
}

export const agentVettingKey = (userId: string | undefined) => ['agent-vetting', userId] as const;

export function useAgentVetting() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const email = useEmailVerification();
  const [busy, setBusy] = useState<string | null>(null);

  const query = useQuery({
    queryKey: agentVettingKey(user?.id),
    enabled: !!user?.id,
    staleTime: 15_000,
    refetchOnWindowFocus: true,
    queryFn: async (): Promise<AgentVetting> => {
      const { data, error } = await rpc('get_my_agent_vetting');
      if (error) throw error;
      return parseAgentVetting(data);
    },
  });

  const refresh = useCallback(
    () => qc.invalidateQueries({ queryKey: agentVettingKey(user?.id) }),
    [qc, user?.id],
  );

  /** Runs one action with a busy flag and refetches the record afterwards, success or not. */
  const run = useCallback(
    async <T,>(name: string, fn: () => Promise<T>): Promise<T> => {
      setBusy(name);
      try {
        return await fn();
      } finally {
        setBusy(null);
        await refresh();
      }
    },
    [refresh],
  );

  // ---- Phone ---------------------------------------------------------------
  // The code goes to the phone on the profile. A different number goes through
  // the phone-change flow first; vetting never adopts a new number itself.
  const sendPhoneCode = useCallback(async () => {
    const phone = query.data?.phone.value;
    if (!phone) throw new Error('Add a phone number to your profile first.');
    setBusy('phone_send');
    try {
      const { data, error } = await supabase.functions.invoke('sms-otp', {
        body: { action: 'send', phone, category: 'agent_vetting' },
      });
      if (error) throw await fnError(error, 'Could not send the code.');
      if ((data as any)?.error) throw new Error((data as any).error);
    } finally {
      setBusy(null);
    }
  }, [query.data?.phone.value]);

  const confirmPhoneCode = useCallback(
    (code: string) =>
      run('phone_confirm', async () => {
        const phone = query.data?.phone.value;
        if (!phone) throw new Error('Add a phone number to your profile first.');
        const { data, error } = await supabase.functions.invoke('sms-otp', {
          body: { action: 'verify', phone, otp: code.trim(), category: 'agent_vetting' },
        });
        if (error) throw await fnError(error, 'That code is not right.');
        if ((data as any)?.error) throw new Error((data as any).error);
        await callRpc('agent_vetting_confirm_phone');
      }),
    [run, query.data?.phone.value],
  );

  // ---- Email ---------------------------------------------------------------
  // email-verify-confirm adopts the address on the profile; the RPC then stamps it.
  const sendEmailCode = useCallback((address: string) => email.requestCode(address), [email]);

  const confirmEmailCode = useCallback(
    (challengeId: string, code: string) =>
      run('email_confirm', async () => {
        await email.confirmCode(challengeId, code);
        await callRpc('agent_vetting_confirm_email');
      }),
    [run, email],
  );

  // ---- Residence -----------------------------------------------------------
  const saveResidence = useCallback(
    (r: ResidenceInput) =>
      run('residence', () =>
        callRpc('agent_vetting_save_residence', {
          p_region: r.region ?? null,
          p_district: r.district,
          p_sub_county: r.sub_county ?? null,
          p_parish: r.parish ?? null,
          p_village: r.village,
          p_town: r.town ?? null,
          p_city: r.city ?? null,
        }),
      ),
    [run],
  );

  // ---- Live location -------------------------------------------------------
  const captureLocation = useCallback(
    () =>
      run('location', async () => {
        const fix = await captureGps();
        return callRpc('agent_vetting_capture_gps', {
          p_lat: fix.latitude,
          p_lng: fix.longitude,
          p_accuracy_m: fix.accuracy,
        });
      }),
    [run],
  );

  // ---- National ID ---------------------------------------------------------
  // Own ID photos are taken with IdentityPhotoCapture (the withdraw flow's
  // component), which writes them to the profile. This only records the choice.
  const chooseIdSource = useCallback(
    (source: 'own' | 'parent') =>
      run('id_source', () => callRpc('agent_vetting_save_details', { p_id_source: source })),
    [run],
  );

  const parentIdLink = useQuery({
    queryKey: ['agent-vetting-parent-id-link', user?.id],
    enabled: !!user?.id && !!query.data?.parent_agent,
    staleTime: 10_000,
    // While waiting on the parent, check now and then so the screen moves on by itself.
    refetchInterval: (q) => {
      const s = (q.state.data as ParentIdLinkState | undefined)?.status;
      return s === 'awaiting_owner' || s === 'owner_approved' ? 15_000 : false;
    },
    queryFn: async (): Promise<ParentIdLinkState> => {
      const { data, error } = await rpc('agent_vetting_parent_id_link_state');
      if (error) throw error;
      return (data ?? { found: false, has_parent: false }) as ParentIdLinkState;
    },
  });

  /** Opens the link request to the parent's ID and texts the parent a code. */
  const requestParentIdLink = useCallback(
    () =>
      run('parent_link', async () => {
        const r = await callRpc('agent_vetting_request_parent_id_link');
        await callRpc('agent_vetting_save_details', { p_id_source: 'parent' });
        const { data, error } = await supabase.functions.invoke('national-id-link-otp', {
          body: { action: 'send', request_id: r.request_id },
        });
        if (error) throw await fnError(error, 'Could not send the code to your parent agent.');
        if ((data as any)?.error) throw new Error((data as any).error);
        await parentIdLink.refetch();
        return r;
      }),
    [run, parentIdLink],
  );

  /** The code the parent read out. The parent must still approve in their app. */
  const confirmParentIdCode = useCallback(
    (code: string) =>
      run('parent_link_confirm', async () => {
        const requestId = parentIdLink.data?.request_id;
        if (!requestId) throw new Error('Ask to use your parent agent\'s ID first.');
        const { data, error } = await supabase.functions.invoke('national-id-link-otp', {
          body: { action: 'verify', request_id: requestId, code: code.trim() },
        });
        if (error) throw await fnError(error, 'That code is not right.');
        if ((data as any)?.error) throw new Error((data as any).error);
        await parentIdLink.refetch();
      }),
    [run, parentIdLink],
  );

  // ---- Passport photo ------------------------------------------------------
  /** Grades the photo with PassGate, uploads it, and saves it. Returns the grade. */
  const savePassportPhoto = useCallback(
    (file: File) =>
      run('passport_photo', async (): Promise<PassportFaceCheck> => {
        if (!user?.id) throw new Error('Please sign in again.');
        const check = await runPassportFaceCheck(file, { source: 'agent_vetting', subjectUserId: user.id });
        if (check.status === 'no_face' || check.verdict === 'fail') {
          const advice = check.failures?.[0]?.advice;
          throw new Error(advice ?? 'We could not see your face clearly. Retake the photo facing the camera.');
        }
        const path = await uploadIdentityPhoto(user.id, 'selfie', file);
        await callRpc('agent_vetting_save_details', {
          p_passport_photo_path: path,
          p_passport_photo_check: check as unknown as Record<string, unknown>,
        });
        return check;
      }),
    [run, user?.id],
  );

  // ---- Next of kin ---------------------------------------------------------
  const saveNextOfKin = useCallback(
    (nok: NextOfKinInput) =>
      run('next_of_kin', () =>
        callRpc(
          'agent_vetting_save_details',
          nok.useParent === true
            ? { p_nok_use_parent: true }
            : { p_nok_name: nok.name, p_nok_phone: nok.phone, p_nok_relationship: nok.relationship },
        ),
      ),
    [run],
  );

  // ---- Submit --------------------------------------------------------------
  /**
   * Takes the second location reading and submits. Unfinished steps come back
   * as a list (not an error) so the screen can show them all at once.
   */
  const submit = useCallback(
    () =>
      run('submit', async (): Promise<SubmitResult> => {
        const fix = await captureGps();
        const { data, error } = await rpc('submit_agent_vetting', {
          p_lat: fix.latitude,
          p_lng: fix.longitude,
          p_accuracy_m: fix.accuracy,
        });
        if (error) throw new Error(error.message);
        const r = (data ?? {}) as RpcResult;
        if (r.success) return { success: true };
        return {
          success: false,
          message: r.message ?? 'Some steps are not finished yet.',
          missing: Array.isArray(r.missing) ? (r.missing as string[]) : [],
        };
      }),
    [run],
  );

  return {
    vetting: query.data,
    isLoading: query.isLoading,
    error: query.error as Error | null,
    refresh,
    /** Name of the action in flight, e.g. 'submit', or null. */
    busy,
    sendPhoneCode,
    confirmPhoneCode,
    sendEmailCode,
    confirmEmailCode,
    emailSending: email.sending,
    emailAttemptsLeft: email.attemptsLeft,
    saveResidence,
    captureLocation,
    chooseIdSource,
    parentIdLink: parentIdLink.data,
    requestParentIdLink,
    confirmParentIdCode,
    savePassportPhoto,
    saveNextOfKin,
    submit,
  };
}
