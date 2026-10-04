import { supabase } from '@/integrations/supabase/client';

export type DriveDocType = 'tenant_id' | 'contract' | 'receipt';

/**
 * Fire-and-forget offsite backup: mirror a file that was just uploaded to Cloud
 * storage into the company Google Drive vault, organized as
 * `Welile Document Vault / Year / Month / {Tenant IDs|Contracts|Receipts}`.
 *
 * Cloud storage stays the primary store — this is purely a redundant archive,
 * so it NEVER throws and never blocks the user-facing flow. Failures are logged
 * server-side in `drive_archive_log` and to the console only.
 */
export function archiveToDrive(
  bucket: string,
  path: string,
  docType: DriveDocType,
): void {
  // Intentionally not awaited by callers.
  void (async () => {
    try {
      const { error } = await supabase.functions.invoke('drive-archive', {
        body: { operation: 'archive', bucket, path, doc_type: docType },
      });
      if (error) console.warn('[archiveToDrive] backup failed', bucket, path, error.message);
    } catch (e) {
      console.warn('[archiveToDrive] backup error', e);
    }
  })();
}
