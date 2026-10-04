import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import {
  HardDrive, Loader2, RefreshCw, Search, FileText, Image as ImageIcon,
  IdCard, ReceiptText, Clock, AlertTriangle, Download,
} from 'lucide-react';
import { format } from 'date-fns';
import { DriveArchiveLink } from '@/components/documents/DriveArchiveLink';
import { getSignedUrl } from '@/lib/storageUtils';
import { toast } from 'sonner';

type ArchiveRow = {
  id: string;
  user_id: string | null;
  doc_type: string;
  source_bucket: string;
  source_path: string;
  file_name: string | null;
  file_size: number | null;
  drive_file_link: string | null;
  status: string;
  created_at: string;
};

type Filter = 'all' | 'tenant_id' | 'receipt';

const DOC_LABEL: Record<string, string> = {
  tenant_id: 'Tenant ID',
  receipt: 'Receipt',
  contract: 'Contract',
};

function formatBytes(n: number | null | undefined) {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Manager / ops review panel that lists every tenant ID and receipt mirrored to
 * the Google Drive vault. Each row links to the backed-up copy on Drive once the
 * mirror completes; rows still in flight show a "Mirroring…" state instead.
 *
 * Reads `drive_archive_log` (RLS already grants ops/manager full visibility).
 */
export function DriveDocumentReviewPanel() {
  const [rows, setRows] = useState<ArchiveRow[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [zipping, setZipping] = useState(false);

  const load = useCallback(async () => {
    const { data } = await supabase
      .from('drive_archive_log')
      .select('id, user_id, doc_type, source_bucket, source_path, file_name, file_size, drive_file_link, status, created_at')
      .in('doc_type', ['tenant_id', 'receipt'])
      .order('created_at', { ascending: false })
      .limit(300);
    const list = (data as ArchiveRow[]) ?? [];
    setRows(list);

    const ids = Array.from(new Set(list.map((r) => r.user_id).filter(Boolean))) as string[];
    if (ids.length) {
      const { data: profs } = await supabase
        .from('profiles')
        .select('id, full_name, phone')
        .in('id', ids);
      const map: Record<string, string> = {};
      for (const p of profs ?? []) map[p.id] = p.full_name || p.phone || 'Unknown user';
      setNames(map);
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const refresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (filter !== 'all' && r.doc_type !== filter) return false;
      if (!q) return true;
      const name = (r.file_name || '').toLowerCase();
      const uploader = (r.user_id ? names[r.user_id] || '' : '').toLowerCase();
      return name.includes(q) || uploader.includes(q);
    });
  }, [rows, filter, search, names]);

  const counts = useMemo(() => ({
    all: rows.length,
    tenant_id: rows.filter((r) => r.doc_type === 'tenant_id').length,
    receipt: rows.filter((r) => r.doc_type === 'receipt').length,
  }), [rows]);

  const toggleRow = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const allFilteredSelected = filtered.length > 0 && filtered.every((r) => selected.has(r.id));
  const toggleAll = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allFilteredSelected) {
        filtered.forEach((r) => next.delete(r.id));
      } else {
        filtered.forEach((r) => next.add(r.id));
      }
      return next;
    });
  };

  const selectedRows = useMemo(
    () => rows.filter((r) => selected.has(r.id)),
    [rows, selected],
  );

  const downloadZip = async () => {
    if (selectedRows.length === 0) return;
    setZipping(true);
    try {
      const [{ default: JSZip }] = await Promise.all([import('jszip')]);
      const zip = new JSZip();
      const usedNames = new Set<string>();
      let ok = 0;
      let failed = 0;

      for (const r of selectedRows) {
        try {
          const publicUrl = supabase.storage.from(r.source_bucket).getPublicUrl(r.source_path).data.publicUrl;
          const url = await getSignedUrl(publicUrl);
          const res = await fetch(url);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const blob = await res.blob();

          const base = r.file_name || r.source_path.split('/').pop() || `${r.doc_type}-${r.id}`;
          const folder = r.doc_type === 'tenant_id' ? 'Tenant IDs' : 'Receipts';
          let name = `${folder}/${base}`;
          let i = 1;
          while (usedNames.has(name)) {
            const dot = base.lastIndexOf('.');
            const stem = dot > 0 ? base.slice(0, dot) : base;
            const ext = dot > 0 ? base.slice(dot) : '';
            name = `${folder}/${stem}-${i}${ext}`;
            i += 1;
          }
          usedNames.add(name);
          zip.file(name, blob);
          ok += 1;
        } catch (e) {
          console.warn('[DriveDocumentReview] failed to fetch', r.source_path, e);
          failed += 1;
        }
      }

      if (ok === 0) {
        toast.error('Could not download any of the selected documents.');
        return;
      }

      const out = await zip.generateAsync({ type: 'blob' });
      const href = URL.createObjectURL(out);
      const a = document.createElement('a');
      a.href = href;
      a.download = `welile-documents-${format(new Date(), 'yyyy-MM-dd-HHmm')}.zip`;
      a.click();
      URL.revokeObjectURL(href);
      toast.success(`Exported ${ok} document${ok === 1 ? '' : 's'}${failed ? ` • ${failed} failed` : ''}`);
    } catch (e: any) {
      toast.error(e?.message || 'Failed to build ZIP');
    } finally {
      setZipping(false);
    }
  };

  return (
    <Card className="border-border/40 rounded-2xl">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <HardDrive className="h-4 w-4 text-primary shrink-0" />
            <div className="min-w-0">
              <CardTitle className="text-sm">Drive Document Review</CardTitle>
              <CardDescription className="text-xs">
                Tenant IDs &amp; receipts mirrored to the Google Drive vault.
              </CardDescription>
            </div>
          </div>
          <Button size="sm" variant="ghost" onClick={refresh} disabled={refreshing} className="shrink-0 h-8">
            {refreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="pt-0 space-y-3">
        {/* Filters */}
        <div className="flex flex-wrap items-center gap-1.5">
          {([
            ['all', 'All', counts.all],
            ['tenant_id', 'Tenant IDs', counts.tenant_id],
            ['receipt', 'Receipts', counts.receipt],
          ] as [Filter, string, number][]).map(([key, label, n]) => (
            <Button
              key={key}
              size="sm"
              variant={filter === key ? 'default' : 'outline'}
              onClick={() => setFilter(key)}
              className="h-7 text-xs"
            >
              {label} <span className="ml-1 opacity-70">{n}</span>
            </Button>
          ))}
        </div>

        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by file name or uploader…"
            className="pl-8 h-9 text-xs"
          />
        </div>

        {/* Bulk selection bar */}
        {!loading && filtered.length > 0 && (
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={toggleAll}
              className="flex items-center gap-2 text-[11px] text-muted-foreground hover:text-foreground"
            >
              <Checkbox checked={allFilteredSelected} className="h-3.5 w-3.5" />
              {allFilteredSelected ? 'Clear selection' : 'Select all'}
              {selected.size > 0 && <span className="opacity-70">({selected.size} selected)</span>}
            </button>
            <Button
              size="sm"
              variant="outline"
              onClick={downloadZip}
              disabled={selectedRows.length === 0 || zipping}
              className="h-7 text-xs gap-1.5"
            >
              {zipping ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
              Download ZIP
            </Button>
          </div>
        )}

        {loading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground py-4">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading documents…
          </div>
        ) : filtered.length === 0 ? (
          <p className="text-xs text-muted-foreground italic py-4">No documents found.</p>
        ) : (
          <ul className="space-y-1.5 max-h-[28rem] overflow-y-auto pr-1">
            {filtered.map((r) => {
              const isImg = r.source_bucket === 'house-images' || /\.(png|jpe?g|webp|gif)$/i.test(r.file_name || '');
              const TypeIcon = r.doc_type === 'tenant_id' ? IdCard : ReceiptText;
              const FileIcon = isImg ? ImageIcon : FileText;
              return (
                <li key={r.id} className="flex items-start gap-2 rounded-md border border-border bg-background p-2">
                  <Checkbox
                    checked={selected.has(r.id)}
                    onCheckedChange={() => toggleRow(r.id)}
                    className="h-3.5 w-3.5 mt-0.5 shrink-0"
                  />
                  <FileIcon className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <p className="text-[11px] font-semibold truncate">{r.file_name || r.source_path.split('/').pop()}</p>
                    <div className="flex items-center gap-1.5 flex-wrap mt-0.5">
                      <Badge variant="outline" className="text-[9px] h-4 px-1.5 gap-1">
                        <TypeIcon className="h-2.5 w-2.5" /> {DOC_LABEL[r.doc_type] ?? r.doc_type}
                      </Badge>
                      {r.user_id && (
                        <span className="text-[10px] text-muted-foreground truncate max-w-[10rem]">
                          {names[r.user_id] ?? '…'}
                        </span>
                      )}
                      <span className="text-[10px] text-muted-foreground">
                        {format(new Date(r.created_at), 'MMM d • HH:mm')}
                      </span>
                      {r.file_size ? (
                        <span className="text-[10px] text-muted-foreground">{formatBytes(r.file_size)}</span>
                      ) : null}
                    </div>
                    <div className="mt-1">
                      {r.status === 'success' && r.drive_file_link ? (
                        <DriveArchiveLink href={r.drive_file_link} />
                      ) : r.status === 'failed' ? (
                        <span className="inline-flex items-center gap-1 text-[10px] text-destructive">
                          <AlertTriangle className="h-3 w-3" /> Backup failed
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                          <Clock className="h-3 w-3" /> Mirroring to Drive…
                        </span>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export default DriveDocumentReviewPanel;