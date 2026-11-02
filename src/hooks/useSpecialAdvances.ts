import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type {
  CorrectionDecision, CorrectionStatus, MakerCheckerStatus, ProvisionPreview, ProvisionReview, SpecialAdvance,
  SpecialAdvanceCorrection, SpecialAdvanceList, SpecialAdvanceQuote, SpecialAdvanceReconciliation, SpecialAdvanceRecovery,
  SpecialAdvanceStatement, SpecialAdvanceStatus, SpecialAdvanceWriteOff,
} from '@/lib/specialAdvances';
import {
  SPECIAL_ADVANCE_PROOF_BUCKET, SPECIAL_ADVANCE_PROOF_LINK_SECONDS, SPECIAL_ADVANCE_PROOF_PATH_RE, specialAdvanceProofPath,
} from '@/lib/specialAdvances';

/**
 * Special Advances data access. Every call goes through the CFO-only `special_advance_*` SECURITY DEFINER functions
 * (enabled cfo role + staff MFA, server calculation, issuance flag, idempotency, append-only audit). This hook never
 * computes a figure and never writes a table, the ledger or a wallet itself.
 */

type RpcError = { message: string; code?: string; details?: string };
// The functions are not in the generated types until the migrations are applied, so they are called through this
// narrow untyped wrapper (method kept bound to the client).
const rpc = (fn: string, args?: Record<string, unknown>) =>
  (supabase.rpc as unknown as (f: string, a?: Record<string, unknown>) => Promise<{ data: unknown; error: RpcError | null }>)
    .call(supabase, fn, args);

async function call<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await rpc(fn, args);
  if (error) throw error;
  return data as T;
}

const KEY = 'special-advances';
// Server refusals (auth, validation, eligibility) are final; retrying them only delays the message.
const noRetryOnRefusal = (n: number, err: unknown) => {
  const code = (err as { code?: string } | null)?.code ?? '';
  return !['42501', '22023', '23505', '55000', 'P0002', '40001'].includes(code) && n < 2;
};

/** Server quote (schedule + eligibility + flag). `request` null = nothing to quote yet. Read-only. */
export function useSpecialAdvanceQuote(request: Record<string, unknown> | null) {
  return useQuery({
    queryKey: [KEY, 'quote', request],
    enabled: !!request,
    queryFn: () => call<SpecialAdvanceQuote>('special_advance_quote', { p_request: request }),
    staleTime: 30 * 1000,
    retry: noRetryOnRefusal,
  });
}

export function useSpecialAdvanceList(status: SpecialAdvanceStatus | null, enabled = true) {
  return useQuery({
    queryKey: [KEY, 'list', status],
    enabled,
    queryFn: () => call<SpecialAdvanceList>('special_advance_list', { p_status: status, p_limit: 100, p_offset: 0 }),
    staleTime: 30 * 1000,
    retry: noRetryOnRefusal,
  });
}

export function useSpecialAdvanceStatement(id: string | null) {
  return useQuery({
    queryKey: [KEY, 'statement', id],
    enabled: !!id,
    queryFn: () => call<SpecialAdvanceStatement>('special_advance_statement', { p_id: id }),
    staleTime: 15 * 1000,
    retry: noRetryOnRefusal,
  });
}

export function useSpecialAdvanceReconciliation(enabled = true) {
  return useQuery({
    queryKey: [KEY, 'reconciliation'],
    enabled,
    queryFn: () => call<SpecialAdvanceReconciliation>('special_advance_reconciliation'),
    staleTime: 60 * 1000,
    retry: noRetryOnRefusal,
  });
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: [KEY] });
}

export function useCreateSpecialAdvance() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (request: Record<string, unknown>) => call<SpecialAdvance>('special_advance_create', { p_request: request }),
    onSuccess: invalidate,
  });
}

type Versioned = { id: string; updated_at: string };

export function useSpecialAdvanceDecision() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ action, advance, reason }: { action: 'approve' | 'reject' | 'cancel'; advance: Versioned; reason: string | null }) =>
      call<SpecialAdvance>(`special_advance_${action}`, { p_id: advance.id, p_expected_updated_at: advance.updated_at, p_reason: reason }),
    onSuccess: invalidate,
  });
}

export function useDisburseSpecialAdvance() {
  const invalidate = useInvalidate();
  return useMutation({
    // proof_path: required by the server for an external payout (CFO decision D1); see uploadSpecialAdvanceProof
    mutationFn: ({ advance, payout }: { advance: Versioned; payout: { payout_date: string; method: string; reference?: string | null; proof_path?: string | null } }) =>
      call<SpecialAdvanceStatement>('special_advance_disburse', { p_id: advance.id, p_expected_updated_at: advance.updated_at, p_payout: payout }),
    onSuccess: invalidate,
  });
}

export function useRecordSpecialAdvanceRepayment() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ advanceId, repayment }: {
      advanceId: string;
      // proof_path: required by the server for every repayment (CFO decision D2); see uploadSpecialAdvanceProof
      repayment: { amount: number; received_date: string; method: string; reference: string; note?: string | null; idempotency_key: string; proof_path?: string | null };
    }) => call<SpecialAdvanceStatement>('special_advance_record_repayment', { p_id: advanceId, p_repayment: repayment }),
    onSuccess: invalidate,
  });
}

/* ── Corrections (Phase B, CFO decisions D11; migration 20261102210000) ─────────────────────────────── */

/** The CFO correction queue (pending by default; null = every status). */
export function useSpecialAdvanceCorrections(status: CorrectionStatus | null = 'pending', enabled = true) {
  return useQuery({
    queryKey: [KEY, 'corrections', status],
    enabled,
    queryFn: () => call<SpecialAdvanceCorrection[]>('special_advance_list_corrections', { p_status: status, p_limit: 100 }),
    staleTime: 30 * 1000,
    retry: noRetryOnRefusal,
  });
}

/** Records a correction request (reason + proof, see buildCorrectionRequest). Posts nothing until a second CFO approves. */
export function useRequestSpecialAdvanceCorrection() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ advanceId, request }: { advanceId: string; request: Record<string, unknown> }) =>
      call<SpecialAdvanceCorrection>('special_advance_request_correction', { p_id: advanceId, p_request: request }),
    onSuccess: invalidate,
  });
}

/** approve / reject (a different CFO; reject needs a note) or withdraw (the requester). Approval posts the correction. */
export function useDecideSpecialAdvanceCorrection() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ correctionId, decision, note }: { correctionId: string; decision: CorrectionDecision; note?: string | null }) =>
      call<SpecialAdvanceCorrection>('special_advance_decide_correction', { p_correction_id: correctionId, p_decision: decision, p_note: note ?? null }),
    onSuccess: invalidate,
  });
}

/* ── Impairment, write-off and recovery (Phase C, CFO decisions D7-D10; migration 20261102220000) ───── */

/** What a provision review would post now (read-only). `request` may carry individual_rates. */
export function useSpecialAdvanceProvisionPreview(request: Record<string, unknown> | null, enabled = true) {
  return useQuery({
    queryKey: [KEY, 'provision-preview', request],
    enabled: enabled && !!request,
    queryFn: () => call<ProvisionPreview>('special_advance_provision_preview', { p_request: request }),
    staleTime: 30 * 1000,
    retry: noRetryOnRefusal,
  });
}

export function useSpecialAdvanceProvisionReviews(status: MakerCheckerStatus | null = 'pending', enabled = true) {
  return useQuery({
    queryKey: [KEY, 'provision-reviews', status],
    enabled,
    queryFn: () => call<ProvisionReview[]>('special_advance_list_provision_reviews', { p_status: status, p_limit: 20 }),
    staleTime: 30 * 1000,
    retry: noRetryOnRefusal,
  });
}

/** Records a pending provision review (see buildProvisionReviewRequest). Posts nothing until a second CFO approves. */
export function useRequestProvisionReview() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (request: Record<string, unknown>) => call<ProvisionReview>('special_advance_request_provision_review', { p_request: request }),
    onSuccess: invalidate,
  });
}

export function useDecideProvisionReview() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ reviewId, decision, note }: { reviewId: string; decision: CorrectionDecision; note?: string | null }) =>
      call<ProvisionReview>('special_advance_decide_provision_review', { p_review_id: reviewId, p_decision: decision, p_note: note ?? null }),
    onSuccess: invalidate,
  });
}

export function useSpecialAdvanceWriteOffs(status: MakerCheckerStatus | null = 'pending', enabled = true) {
  return useQuery({
    queryKey: [KEY, 'write-offs', status],
    enabled,
    queryFn: () => call<SpecialAdvanceWriteOff[]>('special_advance_list_write_offs', { p_status: status, p_limit: 100 }),
    staleTime: 30 * 1000,
    retry: noRetryOnRefusal,
  });
}

/** Records a pending write-off of the whole balance (see buildWriteOffRequest). Posts nothing until a second CFO approves. */
export function useRequestSpecialAdvanceWriteOff() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ advanceId, request }: { advanceId: string; request: Record<string, unknown> }) =>
      call<SpecialAdvanceWriteOff>('special_advance_request_write_off', { p_id: advanceId, p_request: request }),
    onSuccess: invalidate,
  });
}

export function useDecideSpecialAdvanceWriteOff() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ writeOffId, decision, note }: { writeOffId: string; decision: CorrectionDecision; note?: string | null }) =>
      call<SpecialAdvanceWriteOff>('special_advance_decide_write_off', { p_write_off_id: writeOffId, p_decision: decision, p_note: note ?? null }),
    onSuccess: invalidate,
  });
}

/** Money recovered after a write-off (D10: DR A1 / CR X4); needs reference + proof, like a repayment. */
export function useRecordSpecialAdvanceRecovery() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ advanceId, recovery }: {
      advanceId: string;
      recovery: { amount: number; received_date: string; method: string; reference: string; note?: string | null; idempotency_key: string; proof_path: string };
    }) => call<SpecialAdvanceRecovery>('special_advance_record_recovery', { p_id: advanceId, p_recovery: recovery }),
    onSuccess: invalidate,
  });
}

/**
 * True when this session is already authenticator-verified (aal2). Check it BEFORE uploading a proof file: the
 * proofs bucket refuses a password-only session (D14), and that refusal is a storage error, not MFA_REQUIRED, so
 * the step-up prompt would never be offered. Any failure to read the level counts as not verified.
 */
export async function hasAuthenticatorSession(): Promise<boolean> {
  try {
    const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    return data?.currentLevel === 'aal2';
  } catch {
    return false;
  }
}

/**
 * Uploads a proof file (receipt or statement) for one advance to the private proofs bucket and returns its path, to be
 * sent as `proof_path` with the payout or repayment. Upload alone moves no money; the server then checks the file
 * exists, belongs to this advance and is not used elsewhere. Files are never overwritten (upsert off).
 */
export async function uploadSpecialAdvanceProof(advanceId: string, file: File): Promise<string> {
  const path = specialAdvanceProofPath(advanceId, file, crypto.randomUUID());
  const { error } = await supabase.storage.from(SPECIAL_ADVANCE_PROOF_BUCKET).upload(path, file, { upsert: false, contentType: file.type });
  if (error) throw new Error(error.message);
  return path;
}

/**
 * A short-lived signed link to view one archived proof file (payout, repayment, correction, write-off or recovery).
 * Ask for it when the CFO clicks "View proof", never in advance; the private bucket's policies (CFO + authenticator,
 * D14) decide whether it is granted. Only a well-formed proof path is ever sent.
 */
export async function getSpecialAdvanceProofUrl(path: string): Promise<string> {
  if (!SPECIAL_ADVANCE_PROOF_PATH_RE.test(path)) throw new Error('This proof file reference is not valid.');
  const { data, error } = await supabase.storage.from(SPECIAL_ADVANCE_PROOF_BUCKET).createSignedUrl(path, SPECIAL_ADVANCE_PROOF_LINK_SECONDS);
  if (error || !data?.signedUrl) throw new Error(error?.message ?? 'The proof file could not be opened.');
  return data.signedUrl;
}
