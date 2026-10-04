import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { FileUp, Loader2, Paperclip, Trash2, FileText, Image as ImageIcon, Download, ListChecks } from 'lucide-react';
import { toast } from 'sonner';
import { archiveToDrive } from '@/lib/archiveToDrive';
import { DriveArchiveLink, useDriveArchiveLinks } from '@/components/documents/DriveArchiveLink';
import { format } from 'date-fns';

const MAX_BYTES = 10 * 1024 * 1024; // 10MB per file
const ACCEPT = 'image/*,application/pdf';

type DocRow = {
  id: string;
  stage_key: string;
  file_path: string;
  file_name: string;
  file_size: number | null;
  content_type: string | null;
  note: string | null;
  created_at: string;
};

type Props = {
  advanceId: string;
  tenantId: string;
  /** Current stage key (e.g. "tenant_ops") so uploads are routed to the right reviewer. */
  stageKey: string;
  stageLabel: string;
  /** Hide upload affordance once advance is rejected/completed. */
  disabled?: boolean;
};

function formatBytes(n: number | null | undefined) {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function BusinessAdvanceDocumentUploadPanel({ advanceId, tenantId, stageKey, stageLabel, disabled = false }: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [docs, setDocs] = useState<DocRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from('business_advance_documents')
      .select('id, stage_key, file_path, file_name, file_size, content_type, note, created_at')
      .eq('advance_id', advanceId)
      .order('created_at', { ascending: false });
    if (!error && data) setDocs(data as DocRow[]);
    setLoading(false);
  }, [advanceId]);

  useEffect(() => { load(); }, [load]);

  const driveLinks = useDriveArchiveLinks(
    'business-advance-documents',
    docs.map((d) => d.file_path),
  );

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    if (disabled) return;
    setUploading(true);

    let okCount = 0;
    for (const file of Array.from(files)) {
      if (file.size > MAX_BYTES) {
        toast.error(`${file.name} is too large`, { description: 'Maximum file size is 10 MB.' });
        continue;
      }
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      const path = `${tenantId}/${advanceId}/${stageKey}/${Date.now()}-${safeName}`;

      const { error: upErr } = await supabase.storage
        .from('business-advance-documents')
        .upload(path, file, { contentType: file.type || 'application/octet-stream', upsert: false });

      if (upErr) {
        toast.error(`Upload failed: ${file.name}`, { description: upErr.message });
        continue;
      }

      const { error: dbErr } = await supabase.from('business_advance_documents').insert({
        advance_id: advanceId,
        tenant_id: tenantId,
        uploaded_by: tenantId,
        stage_key: stageKey,
        file_path: path,
        file_name: file.name,
        file_size: file.size,
        content_type: file.type || null,
        note: note.trim() || null,
      });

      if (dbErr) {
        // best-effort cleanup
        await supabase.storage.from('business-advance-documents').remove([path]);
        toast.error(`Could not record ${file.name}`, { description: dbErr.message });
        continue;
      }

      // Offsite backup: mirror the contract/document into the Google Drive vault.
      archiveToDrive('business-advance-documents', path, 'contract');
      okCount += 1;
    }

    if (okCount > 0) {
      toast.success(`${okCount} document${okCount > 1 ? 's' : ''} sent`, {
        description: `Our ${stageLabel} team will see it right away.`,
      });
      setNote('');
      await load();
    }

    setUploading(false);
    if (inputRef.current) inputRef.current.value = '';
  };

  const openSigned = async (path: string, fileName: string) => {
    const { data, error } = await supabase.storage
      .from('business-advance-documents')
      .createSignedUrl(path, 60);
    if (error || !data?.signedUrl) {
      toast.error('Could not open file', { description: error?.message });
      return;
    }
    const a = document.createElement('a');
    a.href = data.signedUrl;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const removeDoc = async (doc: DocRow) => {
    const ok = window.confirm(`Remove "${doc.file_name}"? Reviewers will no longer see it.`);
    if (!ok) return;
    const { error: rmErr } = await supabase.storage
      .from('business-advance-documents')
      .remove([doc.file_path]);
    if (rmErr) {
      toast.error('Could not remove file', { description: rmErr.message });
      return;
    }
    await supabase.from('business_advance_documents').delete().eq('id', doc.id);
    setDocs((prev) => prev.filter((d) => d.id !== doc.id));
    toast.success('Document removed');
  };

  return (
    <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 space-y-2.5">
      <div className="flex items-center gap-1.5 font-bold uppercase tracking-wider text-[10px] text-primary">
        <ListChecks className="h-3 w-3" /> Submit a document
      </div>
      <p className="text-[11px] text-foreground/80 leading-snug">
        Were you asked for a missing photo, ID page or receipt for{' '}
        <span className="font-semibold">{stageLabel}</span>? Upload it here and our reviewers
        will see it instantly.
      </p>

      <Textarea
        value={note}
        onChange={(e) => setNote(e.target.value.slice(0, 300))}
        placeholder="Optional note for the reviewer (e.g. 'This is my new National ID')"
        rows={2}
        className="text-xs"
        disabled={disabled || uploading}
      />

      <Input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        multiple
        className="hidden"
        onChange={(e) => handleFiles(e.target.files)}
      />

      <Button
        size="sm"
        onClick={() => inputRef.current?.click()}
        disabled={disabled || uploading}
        className="h-9 w-full text-xs font-semibold"
      >
        {uploading ? (
          <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> Uploading…</>
        ) : (
          <><FileUp className="h-3.5 w-3.5 mr-1.5" /> Choose photos or PDFs</>
        )}
      </Button>
      <p className="text-[10px] text-muted-foreground">
        Images or PDFs · up to 10 MB each · multiple files allowed
      </p>

      {/* Existing uploads */}
      <div className="pt-1">
        <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-1">
          <Paperclip className="h-3 w-3" /> Your uploads ({docs.length})
        </div>
        {loading ? (
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" /> Loading…
          </div>
        ) : docs.length === 0 ? (
          <p className="text-[11px] text-muted-foreground italic">No documents uploaded yet.</p>
        ) : (
          <ul className="space-y-1.5">
            {docs.map((d) => {
              const isImg = (d.content_type || '').startsWith('image/');
              const Icon = isImg ? ImageIcon : FileText;
              return (
                <li
                  key={d.id}
                  className="flex items-start gap-2 rounded-md border border-border bg-background p-2"
                >
                  <Icon className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <p className="text-[11px] font-semibold truncate">{d.file_name}</p>
                    <div className="flex items-center gap-1.5 flex-wrap mt-0.5">
                      <Badge variant="outline" className="text-[9px] h-4 px-1.5 uppercase tracking-wide">
                        {d.stage_key.replace(/_/g, ' ')}
                      </Badge>
                      <span className="text-[10px] text-muted-foreground">
                        {format(new Date(d.created_at), 'MMM d • HH:mm')}
                      </span>
                      {d.file_size ? (
                        <span className="text-[10px] text-muted-foreground">{formatBytes(d.file_size)}</span>
                      ) : null}
                    </div>
                    {d.note && (
                      <p className="text-[10px] text-muted-foreground italic mt-0.5 line-clamp-2">"{d.note}"</p>
                    )}
                    {driveLinks[d.file_path] && (
                      <div className="mt-1">
                        <DriveArchiveLink href={driveLinks[d.file_path]} />
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-0.5 shrink-0">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      onClick={() => openSigned(d.file_path, d.file_name)}
                      title="Open / download"
                    >
                      <Download className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 text-destructive hover:text-destructive"
                      onClick={() => removeDoc(d)}
                      title="Remove"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

export default BusinessAdvanceDocumentUploadPanel;