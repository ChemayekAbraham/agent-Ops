import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import {
  Archive,
  Download,
  Share2,
  Trash2,
  FileText,
  Loader2,
  HardDrive,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { toast } from 'sonner';
import {
  listArchivedPdfs,
  getArchivedPdf,
  deleteArchivedPdf,
  downloadArchivedBlob,
  shareArchivedBlob,
  getVaultUsage,
  requestPersistentStorage,
  type PdfVaultMeta,
} from '@/lib/pdfVault';

/**
 * Offline PDF vault drawer.
 *
 * Lists every PDF we've generated on this device — even when the user is
 * fully offline. Lets them re-download or share via the native share sheet.
 * Backed by IndexedDB so records survive Safari's 7-day ITP eviction.
 */
export function ArchivedPdfsDrawer() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<PdfVaultMeta[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [usage, setUsage] = useState<{
    totalBytes: number;
    count: number;
    quotaBytes: number | null;
    usagePct: number | null;
  } | null>(null);

  const refresh = async () => {
    setLoading(true);
    const [list, u] = await Promise.all([listArchivedPdfs(), getVaultUsage()]);
    setItems(list);
    setUsage(u);
    setLoading(false);
  };

  useEffect(() => {
    if (open) {
      refresh();
      requestPersistentStorage().catch(() => {});
    }
  }, [open]);

  const handleDownload = async (m: PdfVaultMeta) => {
    setBusyKey(m.key);
    const blob = await getArchivedPdf(m.key);
    setBusyKey(null);
    if (!blob) {
      toast.error('Stored copy is missing — it may have been evicted.');
      refresh();
      return;
    }
    downloadArchivedBlob(blob, m.filename);
    toast.success('Re-downloaded from offline vault');
  };

  const handleShare = async (m: PdfVaultMeta) => {
    setBusyKey(m.key);
    const blob = await getArchivedPdf(m.key);
    setBusyKey(null);
    if (!blob) {
      toast.error('Stored copy is missing.');
      refresh();
      return;
    }
    await shareArchivedBlob(blob, m.filename, m.label);
  };

  const handleDelete = async (m: PdfVaultMeta) => {
    if (!confirm(`Delete "${m.label}" from your offline vault? This only removes it from this device.`)) return;
    await deleteArchivedPdf(m.key);
    refresh();
    toast.success('Removed from vault');
  };

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="outline" className="gap-2 flex-1 sm:flex-none min-w-[120px]">
          <Archive className="h-4 w-4" />
          Archived PDFs
          {items.length > 0 && (
            <Badge variant="secondary" className="text-[10px] px-1.5">
              {items.length}
            </Badge>
          )}
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Archive className="h-5 w-5 text-primary" />
            Offline PDF Vault
          </SheetTitle>
          <SheetDescription>
            Every PDF generated on this device, kept on-device so you never
            lose a record — even fully offline.
          </SheetDescription>
        </SheetHeader>

        {usage && (
          <div className="mt-4 rounded-lg border bg-muted/30 p-3 text-xs space-y-1">
            <div className="flex items-center gap-2 text-muted-foreground">
              <HardDrive className="h-3.5 w-3.5" />
              <span>
                {usage.count} file{usage.count === 1 ? '' : 's'} ·{' '}
                {(usage.totalBytes / 1024 / 1024).toFixed(2)} MB used
                {usage.quotaBytes
                  ? ` of ${(usage.quotaBytes / 1024 / 1024).toFixed(0)} MB available`
                  : ''}
              </span>
            </div>
            <p className="text-[10px] text-muted-foreground italic">
              Auto-prunes after 90 days or above 200 MB (oldest first).
            </p>
          </div>
        )}

        <div className="mt-4 space-y-2">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : items.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">
              No archived PDFs yet. Anything you export from this page will be
              kept here automatically.
            </p>
          ) : (
            items.map((m) => (
              <div
                key={m.key}
                className="rounded-lg border p-3 space-y-2 bg-card hover:bg-muted/30 transition-colors"
              >
                <div className="flex items-start gap-2">
                  <FileText className="h-4 w-4 text-primary mt-0.5 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate">{m.label}</p>
                    <p className="text-[10px] text-muted-foreground">
                      {formatDistanceToNow(new Date(m.generatedAt), { addSuffix: true })} ·{' '}
                      {(m.sizeBytes / 1024).toFixed(0)} KB
                    </p>
                  </div>
                </div>
                <div className="flex gap-1.5">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleDownload(m)}
                    disabled={busyKey === m.key}
                    className="flex-1 h-8 gap-1.5 text-xs"
                  >
                    <Download className="h-3.5 w-3.5" />
                    Download
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleShare(m)}
                    disabled={busyKey === m.key}
                    className="flex-1 h-8 gap-1.5 text-xs"
                  >
                    <Share2 className="h-3.5 w-3.5" />
                    Share
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleDelete(m)}
                    className="h-8 w-8 p-0 text-destructive hover:text-destructive"
                    aria-label="Delete from vault"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            ))
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}