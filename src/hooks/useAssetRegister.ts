import { safeUUID } from '@/lib/safeUUID';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { cfoReportRetry } from './cfoReportRetry';
import {
  ASSET_EVIDENCE_BUCKET, ASSET_EVIDENCE_MAX_BYTES, ASSET_EVIDENCE_MIME,
  type Asset, type AssetDetail, type AssetInput, type AssetListFilters, type AssetListPage,
  type AssetReferenceData, type AssetSummary, type DuplicateMatch, type ImportCommitResult,
} from '@/lib/assetRegister/types';

/**
 * CFO Asset Register (Stage 1) data access.
 *
 * Every read and write goes through the `asset_register_*` SECURITY DEFINER RPCs (role gate + staff MFA,
 * server validation, append-only audit). This hook never computes a figure, never generates an asset code
 * and never touches the ledger, wallets or payments. Evidence objects live in the private `asset-evidence`
 * bucket and are only ever shown through short-lived signed URLs.
 */

type RpcError = { message: string; code?: string; details?: string };
type RpcFn = (fn: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: RpcError | null }>;
// Keep the method bound to the client (see usePayables). The RPCs are not in the generated types until the
// migration is applied, so they are called through this narrow untyped wrapper.
const rpc: RpcFn = (fn, args) =>
  (supabase.rpc as unknown as (f: string, a?: Record<string, unknown>) => Promise<{ data: unknown; error: RpcError | null }>)
    .call(supabase, fn, args);

const STALE_TIME = 60 * 1000;
const KEY = 'asset-register';

async function call<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await rpc(fn, args);
  if (error) throw error;
  return data as T;
}

export function useAssetSummary(enabled = true) {
  return useQuery({
    queryKey: [KEY, 'summary'],
    enabled,
    queryFn: () => call<AssetSummary>('asset_register_summary'),
    staleTime: STALE_TIME,
    retry: cfoReportRetry,
  });
}

export function useAssetList(filters: AssetListFilters, offset = 0, limit = 25, enabled = true) {
  const search = filters.search.trim();
  return useQuery({
    queryKey: [KEY, 'list', search, filters.category, filters.status, filters.condition, filters.department, offset, limit],
    enabled,
    queryFn: () => call<AssetListPage>('asset_register_list', {
      p_search: search || null,
      p_category: filters.category,
      p_status: filters.status,
      p_condition: filters.condition,
      p_department: filters.department,
      p_limit: limit,
      p_offset: offset,
    }),
    staleTime: STALE_TIME,
    retry: cfoReportRetry,
    placeholderData: (prev) => prev,
  });
}

export function useAssetDetail(id: string | null) {
  return useQuery({
    queryKey: [KEY, 'detail', id],
    enabled: !!id,
    queryFn: () => call<AssetDetail>('asset_register_get', { p_id: id }),
    staleTime: STALE_TIME,
    // ASSET_NOT_FOUND (P0002) is final — e.g. a scanned label for an unknown id — so don't retry it.
    retry: (n, err) => (err as { code?: string } | null)?.code !== 'P0002' && cfoReportRetry(n, err),
  });
}

export function useAssetReferenceData(enabled = true) {
  return useQuery({
    queryKey: [KEY, 'reference'],
    enabled,
    queryFn: () => call<AssetReferenceData>('asset_register_reference_data'),
    staleTime: 10 * 60 * 1000,
    retry: cfoReportRetry,
  });
}

function useInvalidateRegister() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: [KEY] });
}

export function useCreateAsset() {
  const invalidate = useInvalidateRegister();
  return useMutation({
    mutationFn: (input: Partial<AssetInput>) => call<Asset>('asset_register_create', { p_asset: input }),
    onSuccess: () => invalidate(),
  });
}

export function useUpdateAsset() {
  const invalidate = useInvalidateRegister();
  return useMutation({
    mutationFn: (args: { id: string; expectedUpdatedAt: string; changes: Partial<AssetInput>; reason?: string | null }) =>
      call<Asset>('asset_register_update', {
        p_id: args.id,
        p_expected_updated_at: args.expectedUpdatedAt,
        p_changes: args.changes,
        p_reason: args.reason ?? null,
      }),
    onSuccess: () => invalidate(),
  });
}

/** Import preview: server-side duplicate matches for already-validated rows. Read only. */
export function checkAssetDuplicates(rows: Array<Record<string, unknown>>): Promise<DuplicateMatch[]> {
  if (!rows.length) return Promise.resolve([]);
  return call<DuplicateMatch[]>('asset_register_check_duplicates', { p_rows: rows });
}

export function useCommitAssetImport() {
  const invalidate = useInvalidateRegister();
  return useMutation({
    mutationFn: (args: { fileName: string; fileSha256: string; rows: Array<Record<string, unknown>> }) =>
      call<ImportCommitResult>('asset_register_import_commit', {
        p_file_name: args.fileName,
        p_file_sha256: args.fileSha256,
        p_rows: args.rows,
      }),
    onSuccess: (res) => { if (res.status === 'committed') invalidate(); },
  });
}

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf',
};

export function evidenceFileProblem(file: File): string | null {
  if (!(ASSET_EVIDENCE_MIME as readonly string[]).includes(file.type)) return 'Only JPG, PNG, WebP images or PDF files can be attached.';
  if (file.size > ASSET_EVIDENCE_MAX_BYTES) return 'Files must be 10 MB or smaller.';
  return null;
}

/** Uploads a photo or evidence file to the private bucket, then attaches it through the audited RPC. */
export function useAttachAssetEvidence() {
  const invalidate = useInvalidateRegister();
  return useMutation({
    mutationFn: async (args: { assetId: string; kind: 'photo' | 'evidence'; file: File }) => {
      const problem = evidenceFileProblem(args.file);
      if (problem) throw new Error(problem);
      const path = `assets/${args.assetId}/${safeUUID()}.${EXT_BY_MIME[args.file.type]}`;
      const { error: upErr } = await supabase.storage
        .from(ASSET_EVIDENCE_BUCKET)
        .upload(path, args.file, { contentType: args.file.type, upsert: false });
      if (upErr) throw upErr;
      return call<Asset>('asset_register_add_evidence', { p_id: args.assetId, p_kind: args.kind, p_path: path });
    },
    onSuccess: () => invalidate(),
  });
}

/** Short-lived (5 minute) signed URL for a private evidence object. */
export function useAssetEvidenceUrl(path: string | null) {
  return useQuery({
    queryKey: [KEY, 'signed-url', path],
    enabled: !!path,
    queryFn: async () => {
      const { data, error } = await supabase.storage.from(ASSET_EVIDENCE_BUCKET).createSignedUrl(path as string, 300);
      if (error) throw error;
      return data.signedUrl;
    },
    staleTime: 4 * 60 * 1000,
    gcTime: 5 * 60 * 1000,
    retry: false,
  });
}
