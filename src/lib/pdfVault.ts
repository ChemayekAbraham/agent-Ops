/**
 * PDF Vault — durable offline PDF archive backed by IndexedDB.
 *
 * Why this exists:
 *  - Every generated PDF (Recent emails export, agent report, receipt, etc.)
 *    is funneled through `archivePdfBlob()` so we keep a copy on-device
 *    even when the user is offline / clears Downloads / loses their phone.
 *  - Stored as native Blobs in IndexedDB (idb-keyval) — survives Safari's
 *    7-day ITP wipe of the Cache API, has ~50MB+ quota on iOS and
 *    effectively unlimited on Android / desktop.
 *  - Use `requestPersistentStorage()` once at app boot so iOS/Android won't
 *    evict the vault under storage pressure.
 *
 * NOT a wallet/balance write — UI-only artifact storage. Never store
 * source-of-truth data here.
 */
import { createStore, set, get, del, keys as idbKeys } from 'idb-keyval';

const META_STORE = createStore('welile-pdf-vault', 'meta');
const BLOB_STORE = createStore('welile-pdf-vault-blobs', 'blobs');

export type PdfCategory =
  | 'finops-emails'
  | 'finops-report'
  | 'agent-report'
  | 'agent-wallet'
  | 'tenant-ops'
  | 'trust-profile'
  | 'audit'
  | 'withdrawal-receipt'
  | 'merchandise-receipt'
  | 'delete-snapshot'
  | 'other';

export interface PdfVaultMeta {
  key: string;
  label: string;
  filename: string;
  category: PdfCategory;
  sizeBytes: number;
  generatedAt: number; // epoch ms
  userId?: string;
}

const MAX_TOTAL_BYTES = 200 * 1024 * 1024; // 200 MB cap
const MAX_AGE_DAYS = 90;

function makeKey(category: PdfCategory) {
  return `${category}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Ask the browser to mark our storage as persistent (best-effort). */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (typeof navigator === 'undefined' || !navigator.storage?.persist) return false;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

/** Save a generated PDF blob to the vault. Fire-and-forget safe. */
export async function archivePdfBlob(
  blob: Blob,
  meta: Omit<PdfVaultMeta, 'key' | 'sizeBytes' | 'generatedAt'> & {
    generatedAt?: number;
  },
): Promise<string | null> {
  try {
    const key = makeKey(meta.category);
    const record: PdfVaultMeta = {
      key,
      label: meta.label,
      filename: meta.filename,
      category: meta.category,
      sizeBytes: blob.size,
      generatedAt: meta.generatedAt ?? Date.now(),
      userId: meta.userId,
    };
    await set(key, blob, BLOB_STORE);
    await set(key, record, META_STORE);
    // Best-effort pruning; never block the caller.
    pruneVault().catch(() => {});
    return key;
  } catch (err) {
    // Quota / private mode — degrade silently. The original download
    // still went to the user.
    console.warn('[pdfVault] archive failed', err);
    return null;
  }
}

/** List all archived PDFs, newest first. */
export async function listArchivedPdfs(filter?: {
  category?: PdfCategory;
  userId?: string;
}): Promise<PdfVaultMeta[]> {
  try {
    const ks = await idbKeys(META_STORE);
    const records = await Promise.all(
      ks.map((k) => get<PdfVaultMeta>(k as string, META_STORE)),
    );
    return records
      .filter((r): r is PdfVaultMeta => !!r)
      .filter((r) => !filter?.category || r.category === filter.category)
      .filter((r) => !filter?.userId || r.userId === filter.userId)
      .sort((a, b) => b.generatedAt - a.generatedAt);
  } catch {
    return [];
  }
}

/** Retrieve a stored PDF Blob by key. */
export async function getArchivedPdf(key: string): Promise<Blob | null> {
  try {
    const b = await get<Blob>(key, BLOB_STORE);
    return b ?? null;
  } catch {
    return null;
  }
}

/** Delete one archived PDF. */
export async function deleteArchivedPdf(key: string): Promise<void> {
  try {
    await del(key, BLOB_STORE);
    await del(key, META_STORE);
  } catch {
    /* ignore */
  }
}

/** Re-trigger a browser download (mobile-Safari safe) for a stored blob. */
export function downloadArchivedBlob(blob: Blob, filename: string): void {
  try {
    const url = URL.createObjectURL(blob);
    const isIOS = typeof navigator !== 'undefined' && /iPad|iPhone|iPod/.test(navigator.userAgent);
    if (isIOS) {
      window.open(url, '_blank');
    } else {
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      link.rel = 'noopener';
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  } catch (err) {
    console.warn('[pdfVault] download failed', err);
  }
}

/** Use the native share sheet when available (iOS/Android), else download. */
export async function shareArchivedBlob(blob: Blob, filename: string, label: string): Promise<void> {
  try {
    const file = new File([blob], filename, { type: 'application/pdf' });
    const nav = navigator as Navigator & {
      canShare?: (data: { files: File[] }) => boolean;
      share?: (data: { files?: File[]; title?: string; text?: string }) => Promise<void>;
    };
    if (nav.canShare?.({ files: [file] }) && nav.share) {
      await nav.share({ files: [file], title: label, text: label });
      return;
    }
  } catch {
    /* fall through to download */
  }
  downloadArchivedBlob(blob, filename);
}

/** Storage usage estimate (best-effort). */
export async function getVaultUsage(): Promise<{
  totalBytes: number;
  count: number;
  quotaBytes: number | null;
  usagePct: number | null;
}> {
  const records = await listArchivedPdfs();
  const totalBytes = records.reduce((s, r) => s + r.sizeBytes, 0);
  let quotaBytes: number | null = null;
  try {
    const est = await navigator.storage?.estimate?.();
    quotaBytes = est?.quota ?? null;
  } catch {
    /* ignore */
  }
  return {
    totalBytes,
    count: records.length,
    quotaBytes,
    usagePct: quotaBytes ? Math.round((totalBytes / quotaBytes) * 100) : null,
  };
}

/** Auto-prune: drop anything older than MAX_AGE_DAYS or beyond MAX_TOTAL_BYTES (oldest first). */
export async function pruneVault(): Promise<{ removed: number }> {
  const all = await listArchivedPdfs();
  const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const tooOld = all.filter((r) => r.generatedAt < cutoff);
  let removed = 0;
  for (const r of tooOld) {
    await deleteArchivedPdf(r.key);
    removed++;
  }
  // Size cap — drop oldest until under cap.
  let remaining = (await listArchivedPdfs()).sort((a, b) => a.generatedAt - b.generatedAt);
  let total = remaining.reduce((s, r) => s + r.sizeBytes, 0);
  while (total > MAX_TOTAL_BYTES && remaining.length > 0) {
    const oldest = remaining.shift()!;
    await deleteArchivedPdf(oldest.key);
    total -= oldest.sizeBytes;
    removed++;
  }
  return { removed };
}

/**
 * One-call replacement for `doc.save(filename)` — archives the PDF to the
 * offline vault AND triggers a mobile-Safari-safe download.
 *
 * Usage:
 *   savePdfWithVault(doc, 'my-report.pdf', { label: 'My Report', category: 'agent-report' });
 */
export function savePdfWithVault(
  doc: { output: (type: 'blob') => Blob; save?: (name: string) => void },
  filename: string,
  meta: Omit<PdfVaultMeta, 'key' | 'sizeBytes' | 'generatedAt' | 'filename'>,
): void {
  let blob: Blob | null = null;
  try {
    blob = doc.output('blob');
  } catch {
    /* ignore */
  }
  if (blob) {
    archivePdfBlob(blob, { ...meta, filename }).catch(() => {});
    try {
      const url = URL.createObjectURL(blob);
      const isIOS = typeof navigator !== 'undefined' && /iPad|iPhone|iPod/.test(navigator.userAgent);
      if (isIOS) {
        window.open(url, '_blank');
      } else {
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        link.rel = 'noopener';
        link.style.display = 'none';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      }
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      return;
    } catch {
      /* fall back to doc.save */
    }
  }
  try {
    doc.save?.(filename);
  } catch {
    /* swallow */
  }
}