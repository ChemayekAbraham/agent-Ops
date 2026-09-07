import { useEffect, useState } from 'react';
import { Eye, FolderOpen } from 'lucide-react';
import PersonalLayout from '@/components/layout/PersonalLayout';
import { supabase } from '@/integrations/supabase/client';
import DocumentViewer from '@/components/documents/DocumentViewer';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

const DOCUMENTS_BUCKET = 'hr-documents';

const headCell = 'text-[11px] font-semibold uppercase tracking-wider text-muted-foreground';

interface MyDocumentRow {
  id: string;
  title: string | null;
  storage_path: string | null;
  version: number | null;
  uploaded_at: string | null;
  doc_type_name: string | null;
}

function formatDate(value: string | null): string {
  if (!value) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

/** Read-only self-service list of documents HR has filed for the signed-in person. */
export default function MyDocuments() {
  const [rows, setRows] = useState<MyDocumentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewerDoc, setViewerDoc] = useState<MyDocumentRow | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const { data, error: queryError } = await supabase
        .from('hr_documents')
        .select('id, title, storage_path, version, uploaded_at, hr_doc_types(name)')
        .is('superseded_by', null)
        .order('uploaded_at', { ascending: false });

      if (!alive) return;
      if (queryError) {
        setError('Could not load your documents. Please try again.');
      } else {
        setRows(
          (data ?? []).map((row: any) => ({
            id: row.id,
            title: row.title,
            storage_path: row.storage_path,
            version: row.version,
            uploaded_at: row.uploaded_at,
            doc_type_name: row.hr_doc_types?.name ?? null,
          }))
        );
      }
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, []);

  const handleOpen = (row: MyDocumentRow) => {
    setError(null);
    if (!row.storage_path) {
      setError('This document has no file attached. Please contact HR.');
      return;
    }
    setViewerDoc(row);
  };

  return (
    <PersonalLayout title="My documents">
      <Card className="overflow-hidden border-border/70 shadow-sm">
        <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0 border-b border-border/60 bg-muted/30 px-4 py-3">
          <div className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <FolderOpen className="h-4 w-4" />
            </span>
            <div>
              <CardTitle className="text-sm font-semibold tracking-tight">Filed for you</CardTitle>
              <p className="text-[11px] text-muted-foreground">Newest first</p>
            </div>
          </div>
          {!loading && rows.length > 0 && (
            <Badge
              variant="outline"
              className="rounded-full border-primary/30 bg-primary/10 px-2.5 py-0.5 text-[11px] font-semibold text-primary"
            >
              {rows.length}
            </Badge>
          )}
        </CardHeader>
        <CardContent className="p-0">
          {error && (
            <p role="alert" className="border-b border-border/60 bg-destructive/5 px-4 py-3 text-sm font-medium text-destructive">
              {error}
            </p>
          )}

          {loading && (
            <div className="space-y-2.5 p-4">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-10 w-full rounded-lg" />
              ))}
            </div>
          )}

          {!loading && rows.length === 0 && (
            <div className="flex flex-col items-center gap-2 px-4 py-12 text-center">
              <span className="flex h-10 w-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
                <FolderOpen className="h-5 w-5" />
              </span>
              <p className="text-sm font-medium">No documents yet</p>
              <p className="max-w-xs text-xs text-muted-foreground">
                Contracts, letters and certificates filed by HR appear here.
              </p>
            </div>
          )}

          {!loading && rows.length > 0 && (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader className="[&_tr]:border-b [&_tr]:border-border/60">
                  <TableRow className="bg-muted/40 hover:bg-muted/40">
                    <TableHead className={headCell}>Document</TableHead>
                    <TableHead className={headCell}>Type</TableHead>
                    <TableHead className={headCell}>Version</TableHead>
                    <TableHead className={headCell}>Uploaded</TableHead>
                    <TableHead className={cn(headCell, 'text-right')}>Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => (
                    <TableRow
                      key={row.id}
                      className="border-border/50 transition-colors hover:bg-primary/[0.04]"
                    >
                      <TableCell className="py-3 text-sm font-medium text-foreground">
                        {row.title ?? 'Untitled'}
                      </TableCell>
                      <TableCell className="py-3 text-xs text-muted-foreground">
                        {row.doc_type_name ?? '—'}
                      </TableCell>
                      <TableCell className="py-3 text-xs tabular-nums text-muted-foreground">
                        {row.version ?? '—'}
                      </TableCell>
                      <TableCell className="py-3 text-xs tabular-nums text-muted-foreground">
                        {formatDate(row.uploaded_at)}
                      </TableCell>
                      <TableCell className="py-3 text-right">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 rounded-full border-primary/30 bg-primary/5 px-3 text-xs font-semibold text-primary transition-colors hover:bg-primary hover:text-primary-foreground"
                          onClick={() => handleOpen(row)}
                        >
                          <Eye className="mr-1 h-3.5 w-3.5" />
                          Open
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <DocumentViewer
        open={viewerDoc !== null}
        onClose={() => setViewerDoc(null)}
        bucket={DOCUMENTS_BUCKET}
        path={viewerDoc?.storage_path?.replace(/^\/+/, '') ?? ''}
        title={viewerDoc?.title ?? 'Document'}
      />
    </PersonalLayout>
  );
}
