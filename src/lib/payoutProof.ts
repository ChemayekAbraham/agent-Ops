import { supabase } from '@/integrations/supabase/client';

/**
 * Proof-of-payment helpers for merchant payouts.
 *
 * The authoritative reference is the storage object PATH
 * (`payout_proof_path` in `payment-proofs`). Signed URLs expire, so every
 * read re-signs from the path. `payout_proof` is kept only for backward
 * compatibility and for legacy rows that hold plain text instead of a URL.
 */

export const PROOF_BUCKET = 'payment-proofs';

export type ProofState = 'attached' | 'missing' | 'legacy';

export type ProofSource = {
  payout_proof?: string | null;
  payout_proof_path?: string | null;
  payout_proof_bucket?: string | null;
  payout_proof_type?: string | null;
};

const isUrl = (v: string) => /^https?:\/\//i.test(v.trim());

/** Extract the storage object path out of a signed / public storage URL. */
export function extractProofPath(value: string | null | undefined): string | null {
  if (!value || !isUrl(value)) return null;
  const m = value.match(/\/storage\/v1\/object\/(?:sign|public|authenticated)\/([^/]+)\/(.+)$/i);
  if (!m) return null;
  return decodeURIComponent(m[2].split('?')[0]);
}

/** Classify a withdrawal row's proof for display in the Receipt Archive. */
export function classifyProof(row: ProofSource): ProofState {
  if (row.payout_proof_path) return 'attached';
  const raw = (row.payout_proof ?? '').trim();
  if (!raw) return 'missing';
  if (isUrl(raw)) return extractProofPath(raw) ? 'attached' : 'legacy';
  return 'legacy';
}

/** Resolve the storage path for a row, falling back to URL extraction. */
export function resolveProofPath(row: ProofSource): string | null {
  return row.payout_proof_path || extractProofPath(row.payout_proof);
}

export const proofBucketOf = (row: ProofSource) => row.payout_proof_bucket || PROOF_BUCKET;

/** Always generate a FRESH signed URL from the stored object path. */
export async function getFreshProofUrl(
  row: ProofSource,
  opts: { download?: boolean; expiresIn?: number } = {},
): Promise<string> {
  const path = resolveProofPath(row);
  if (!path) throw new Error('No uploaded proof available for this record.');
  const { data, error } = await supabase.storage
    .from(proofBucketOf(row))
    .createSignedUrl(path, opts.expiresIn ?? 60 * 10, opts.download ? { download: true } : undefined);
  if (error || !data?.signedUrl) {
    throw new Error(error?.message || 'Proof file could not be found in storage.');
  }
  return data.signedUrl;
}

export const isPdfProof = (row: ProofSource) => {
  const t = (row.payout_proof_type ?? '').toLowerCase();
  if (t.includes('pdf')) return true;
  return (resolveProofPath(row) ?? '').toLowerCase().endsWith('.pdf');
};