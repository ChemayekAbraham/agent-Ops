import { useEffect, useMemo, useState } from 'react';
import { useFullDatabaseBackup } from '@/hooks/useFullDatabaseBackup';
import { Button } from '@/components/ui/button';
import { Database, Loader2, ExternalLink, CheckCircle2, Mail } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

interface BackupResult {
  signedUrl: string;
  fileName: string;
  sizeBytes: number;
  tableCount: number;
  rowCount: number;
  generatedAt: string;
}

export default function RunBackupNowButton() {
  // Full paged backup of every table (replaces weekly-database-backup, which stops at 1,000 rows/table).
  const backup = useFullDatabaseBackup();
  const running = backup.phase === 'starting' || backup.phase === 'running';
  const elapsed = backup.elapsed;
  const result: BackupResult | null = useMemo(
    () =>
      backup.phase === 'finished' && backup.run
        ? {
            signedUrl: '', // full backup is stored privately in db-backups; no emailed link
            fileName: backup.folder ?? '',
            sizeBytes: backup.run.size_bytes ?? 0,
            tableCount: backup.run.table_count ?? 0,
            rowCount: backup.run.row_count ?? 0,
            generatedAt: new Date().toISOString(),
          }
        : null,
    [backup.phase, backup.run, backup.folder],
  );
  const [showResend, setShowResend] = useState(false);
  const [resending, setResending] = useState(false);
  const [recipients, setRecipients] = useState('joshwanda17@gmail.com, pexpert46@gmail.com, weliletechnologies@gmail.com');
  const [note, setNote] = useState('Re-sent because the previous email did not arrive in the inbox.');

  const handleRun = () => {
    void backup.start();
  };

  useEffect(() => {
    if (backup.phase === 'finished') toast.success('Full backup completed');
    if (backup.phase === 'error') toast.error(backup.error || 'Backup failed');
  }, [backup.phase, backup.error]);

  const handleResend = async () => {
    const list = recipients.split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
    if (list.length === 0) {
      toast.error('Add at least one recipient email');
      return;
    }
    setResending(true);
    try {
      const { data, error } = await supabase.functions.invoke('resend-database-backup-link', {
        body: { recipients: list, note: note.trim() || undefined },
      });
      if (error) throw error;
      if (!data?.success) throw new Error(data?.error || 'Resend failed');
      const okCount = (data.sent || []).filter((s: any) => s.ok).length;
      const failed = (data.sent || []).filter((s: any) => !s.ok);
      if (failed.length === 0) {
        toast.success(`Signed link emailed to ${okCount} recipient${okCount === 1 ? '' : 's'}`);
      } else {
        toast.warning(`Sent to ${okCount}, failed for ${failed.map((f: any) => f.email).join(', ')}`);
      }
    } catch (e: any) {
      console.error(e);
      toast.error(e?.message || 'Resend failed');
    } finally {
      setResending(false);
    }
  };

  return (
    <div className="space-y-3 p-4 rounded-xl border-2 bg-card">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="h-10 w-10 rounded-lg flex items-center justify-center bg-primary/10 text-primary">
            <Database className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <p className="font-semibold text-sm">Database Backup</p>
            <p className="text-xs text-muted-foreground">Run a fresh backup now (also runs weekly)</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-2"
            onClick={() => setShowResend(v => !v)}
          >
            <Mail className="h-4 w-4" />
            {showResend ? 'Hide resend' : 'Resend link'}
          </Button>
          <Button onClick={handleRun} disabled={running} size="sm" className="gap-2">
            {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Database className="h-4 w-4" />}
            {running ? 'Running…' : 'Run backup now'}
          </Button>
        </div>
      </div>

      {running && (
        <div className="text-xs text-muted-foreground flex items-center gap-2">
          <Loader2 className="h-3 w-3 animate-spin" />
          Generating dump, uploading, and signing link… {elapsed}s elapsed (typical 30–90s)
        </div>
      )}

      {result && (
        <div className="rounded-lg border bg-emerald-500/5 border-emerald-500/30 p-3 space-y-2">
          <div className="flex items-center gap-2 text-emerald-700 text-sm font-semibold">
            <CheckCircle2 className="h-4 w-4" />
            Backup ready
          </div>
          <div className="text-xs text-muted-foreground grid grid-cols-2 gap-x-4 gap-y-1">
            <span>File: <span className="font-mono">{result.fileName}</span></span>
            <span>Size: {(result.sizeBytes / (1024 * 1024)).toFixed(2)} MB</span>
            <span>Tables: {result.tableCount}</span>
            <span>Rows: {result.rowCount.toLocaleString()}</span>
          </div>
          {result.signedUrl && (
          <a
            href={result.signedUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 text-sm font-semibold text-primary hover:underline"
          >
            <ExternalLink className="h-4 w-4" />
            Download signed link (valid 7 days)
          </a>
          )}
        </div>
      )}

      {showResend && (
        <div className="rounded-lg border bg-muted/30 p-3 space-y-2">
          <p className="text-xs font-semibold text-foreground">Resend latest signed link</p>
          <p className="text-xs text-muted-foreground">
            Re-signs the most recent successful backup and emails it with a spam-safe subject
            (“Your requested Welile file link”) and a plain body — no attachments, single link.
          </p>
          <Input
            value={recipients}
            onChange={(e) => setRecipients(e.target.value)}
            placeholder="comma-separated emails"
            className="text-sm"
          />
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Optional note included in the email body"
            rows={2}
            className="text-sm"
          />
          <div className="flex justify-end">
            <Button onClick={handleResend} disabled={resending} size="sm" className="gap-2">
              {resending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />}
              {resending ? 'Sending…' : 'Send signed link'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}