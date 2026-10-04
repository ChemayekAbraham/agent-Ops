import { useEffect, useRef, useState } from 'react';
import { Download, Loader2, X } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface DocumentViewerProps {
  open: boolean;
  onClose: () => void;
  bucket: string;
  path: string;
  title: string;
}

function getViewerType(type: string | null): 'pdf' | 'image' | 'other' {
  if (!type) return 'other';
  if (type === 'application/pdf' || type.endsWith('/pdf')) return 'pdf';
  if (type.startsWith('image/')) return 'image';
  return 'other';
}

function sanitizeFilename(title: string): string {
  return title.replace(/[^\w\s.-]/g, '').trim() || 'document';
}

/** Reusable in-app document viewer. Downloads the object directly and renders it in a modal. */
export default function DocumentViewer({
  open,
  onClose,
  bucket,
  path,
  title,
}: DocumentViewerProps) {
  const [blob, setBlob] = useState<Blob | null>(null);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const revokedRef = useRef(false);

  const clearObjectUrl = () => {
    if (objectUrl && !revokedRef.current) {
      URL.revokeObjectURL(objectUrl);
      revokedRef.current = true;
    }
    setObjectUrl(null);
    setBlob(null);
  };

  useEffect(() => {
    return () => {
      clearObjectUrl();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!open) {
      clearObjectUrl();
      setError(null);
      return;
    }

    let alive = true;
    revokedRef.current = false;
    setLoading(true);
    setError(null);
    setBlob(null);
    setObjectUrl(null);

    void (async () => {
      try {
        const { data, error: downloadError } = await supabase.storage
          .from(bucket)
          .download(path);

        if (!alive) return;

        if (downloadError || !data) {
          setError('Could not open this document. Please contact HR.');
          setLoading(false);
          return;
        }

        const url = URL.createObjectURL(data);
        if (!alive) {
          URL.revokeObjectURL(url);
          return;
        }
        setBlob(data);
        setObjectUrl(url);
      } catch {
        if (alive) {
          setError('Could not open this document. Please contact HR.');
        }
      } finally {
        if (alive) {
          setLoading(false);
        }
      }
    })();

    return () => {
      alive = false;
    };
  }, [open, bucket, path]);

  const handleDownload = () => {
    if (!objectUrl || !blob) return;
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = `${sanitizeFilename(title)}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const viewerType = getViewerType(blob?.type ?? null);

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="max-w-5xl w-[95%] p-0 flex flex-col max-h-[90vh] h-[85vh]">
        <DialogHeader className="px-5 pt-5 pb-2">
          <DialogTitle className="truncate pr-8">{title}</DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-hidden px-5">
          {loading && (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
              <Loader2 className="h-8 w-8 animate-spin" />
              <p className="text-sm">Opening document…</p>
            </div>
          )}

          {!loading && error && (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-destructive">
              <p className="text-sm font-medium">{error}</p>
            </div>
          )}

          {!loading && !error && objectUrl && viewerType === 'pdf' && (
            <iframe
              src={objectUrl}
              title={title}
              className="h-full w-full rounded-md border border-border"
            />
          )}

          {!loading && !error && objectUrl && viewerType === 'image' && (
            <div className="flex h-full w-full items-center justify-center overflow-auto rounded-md border border-border bg-muted/50">
              <img
                src={objectUrl}
                alt={title}
                className="max-h-full max-w-full object-contain"
              />
            </div>
          )}

          {!loading && !error && objectUrl && viewerType === 'other' && (
            <div className="flex h-full flex-col items-center justify-center gap-4 text-muted-foreground">
              <p className="text-sm">{title}</p>
              <Button variant="outline" size="sm" onClick={handleDownload}>
                <Download className="mr-2 h-4 w-4" />
                Download
              </Button>
            </div>
          )}
        </div>

        <DialogFooter className="px-5 pb-5 pt-2">
          <Button variant="outline" onClick={onClose}>
            <X className="mr-2 h-4 w-4" />
            Close
          </Button>
          <Button onClick={handleDownload} disabled={!blob || !objectUrl}>
            <Download className="mr-2 h-4 w-4" />
            Download
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
