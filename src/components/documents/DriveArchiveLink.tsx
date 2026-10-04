import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { HardDrive } from 'lucide-react';

type LinkMap = Record<string, string>;

/**
 * Looks up Google Drive offsite-backup links for a set of uploaded files,
 * keyed by their Cloud storage `source_path`. Because the Drive mirror runs as
 * a fire-and-forget background job, links may not exist immediately after an
 * upload — so we poll a few times until every requested path resolves.
 */
export function useDriveArchiveLinks(bucket: string, paths: string[]): LinkMap {
  const [links, setLinks] = useState<LinkMap>({});
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const key = paths.slice().sort().join('|');

  const fetchLinks = useCallback(async () => {
    if (!bucket || paths.length === 0) return;
    const { data } = await supabase
      .from('drive_archive_log')
      .select('source_path, drive_file_link, status')
      .eq('source_bucket', bucket)
      .in('source_path', paths)
      .eq('status', 'success');
    if (!data) return;
    const next: LinkMap = {};
    for (const row of data) {
      if (row.drive_file_link) next[row.source_path] = row.drive_file_link;
    }
    setLinks(next);
    return next;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bucket, key]);

  useEffect(() => {
    let attempts = 0;
    let cancelled = false;
    const run = async () => {
      const next = await fetchLinks();
      attempts += 1;
      const allResolved = next && paths.every((p) => next[p]);
      if (cancelled || allResolved || attempts >= 6) return;
      pollRef.current = setTimeout(run, 8000);
    };
    run();
    return () => {
      cancelled = true;
      if (pollRef.current) clearTimeout(pollRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bucket, key]);

  return links;
}

type Props = {
  /** Google Drive webViewLink, or undefined while the backup is still mirroring. */
  href?: string;
  className?: string;
};

/**
 * Renders a "View on Google Drive" link for a document that has been mirrored
 * to the company Drive vault. Renders nothing until the backup link exists.
 */
export function DriveArchiveLink({ href, className }: Props) {
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      title="View the backed-up copy on Google Drive"
      className={
        'inline-flex items-center gap-1 text-[10px] font-medium text-primary hover:underline ' +
        (className ?? '')
      }
    >
      <HardDrive className="h-3 w-3" /> View on Google Drive
    </a>
  );
}

export default DriveArchiveLink;