/**
 * Files attached to a forwarded concern.
 *
 * The files belong to the concern, not to the call, so everyone who can see the
 * concern at any stage — the officer who forwarded it, every recipient and
 * reviewer, and the named overseers — sees the same list. Nothing is deleted:
 * files stay on the concern through forwarding, reassignment and completion.
 */
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Download, Eye, FileText, ImageIcon, Paperclip, Upload } from 'lucide-react';
import { toast } from 'sonner';
import {
  concernAttachmentUrl,
  useConcernAttachments,
  useUploadConcernAttachments,
  type ConcernAttachment,
} from '@/hooks/useConcernAttachments';

const readableSize = (bytes: number | null) => {
  if (!bytes || bytes <= 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const stamp = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
    : '—';

const typeLabel = (a: ConcernAttachment) => {
  const t = (a.mime_type ?? '').toLowerCase();
  if (t.startsWith('image/')) return t.replace('image/', '').toUpperCase();
  if (t.includes('pdf')) return 'PDF';
  const ext = a.file_name.includes('.') ? a.file_name.split('.').pop() : null;
  return (ext ?? 'File').toUpperCase();
};

export function ConcernAttachmentsPanel({
  concernId,
  canUpload = true,
}: {
  concernId: string;
  canUpload?: boolean;
}) {
  const list = useConcernAttachments(concernId);
  const upload = useUploadConcernAttachments();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const files = list.data ?? [];

  const pick = async (picked: FileList | null) => {
    if (!picked || picked.length === 0) return;
    try {
      await upload.mutateAsync({ concern_id: concernId, files: Array.from(picked) });
      toast.success(picked.length > 1 ? `${picked.length} files attached.` : 'File attached.');
    } catch (e: any) {
      toast.error(e?.message ?? 'Could not attach that file.');
    } finally {
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const open = async (a: ConcernAttachment, download: boolean) => {
    setBusy(a.id);
    try {
      const url = await concernAttachmentUrl(a.storage_path);
      if (download) {
        const link = document.createElement('a');
        link.href = url;
        link.download = a.file_name;
        link.click();
      } else {
        window.open(url, '_blank', 'noopener,noreferrer');
      }
    } catch (e: any) {
      toast.error(e?.message ?? 'Could not open that file.');
    } finally {
      setBusy(null);
    }
  };

  const showPreview = async (a: ConcernAttachment) => {
    if (previews[a.id]) {
      setPreviews((p) => {
        const next = { ...p };
        delete next[a.id];
        return next;
      });
      return;
    }
    setBusy(a.id);
    try {
      const url = await concernAttachmentUrl(a.storage_path);
      setPreviews((p) => ({ ...p, [a.id]: url }));
    } catch (e: any) {
      toast.error(e?.message ?? 'Could not load that image.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="rounded-xl border border-border/70 bg-muted/20 p-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-[11px] font-bold">
          <Paperclip className="h-3.5 w-3.5 text-primary" />
          Files on this concern
          <span className="font-semibold text-muted-foreground">({files.length})</span>
        </p>
        {canUpload && (
          <>
            <input
              ref={inputRef}
              type="file"
              multiple
              accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx,.csv,.txt"
              className="hidden"
              onChange={(e) => void pick(e.target.files)}
            />
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1.5 text-[11px] font-semibold"
              onClick={() => inputRef.current?.click()}
              disabled={upload.isPending}
            >
              <Upload className="h-3.5 w-3.5" />
              {upload.isPending ? 'Attaching…' : 'Attach file'}
            </Button>
          </>
        )}
      </div>

      {list.isLoading ? (
        <Skeleton className="mt-2 h-10 w-full" />
      ) : files.length === 0 ? (
        <p className="mt-1.5 text-[11px] text-muted-foreground">
          No photos or documents attached yet. Photos and files up to 10MB each.
        </p>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {files.map((a) => {
            const isImage = a.kind === 'image' || (a.mime_type ?? '').startsWith('image/');
            return (
              <li key={a.id} className="rounded-lg border border-border/70 bg-background p-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex min-w-0 items-start gap-2">
                    <div className="mt-0.5 shrink-0 rounded-md bg-primary/10 p-1.5">
                      {isImage ? (
                        <ImageIcon className="h-3.5 w-3.5 text-primary" />
                      ) : (
                        <FileText className="h-3.5 w-3.5 text-primary" />
                      )}
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-[11px] font-semibold">{a.file_name}</p>
                      <p className="text-[10px] text-muted-foreground">
                        {typeLabel(a)} · {readableSize(a.size_bytes)} · {stamp(a.created_at)} ·{' '}
                        {a.uploaded_by_name ?? 'Staff member'}
                      </p>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {isImage && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-1.5 text-[11px]"
                        onClick={() => void showPreview(a)}
                        disabled={busy === a.id}
                      >
                        <Eye className="h-3.5 w-3.5" />
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-1.5 text-[11px]"
                      onClick={() => void open(a, !isImage)}
                      disabled={busy === a.id}
                      title={isImage ? 'Open in a new tab' : 'Download'}
                    >
                      <Download className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
                {previews[a.id] && (
                  <img
                    src={previews[a.id]}
                    alt={a.file_name}
                    className="mt-2 max-h-64 w-full rounded-lg border border-border/70 object-contain"
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
