import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { invokeEdgeFunction } from '@/lib/invokeEdgeFunction';
import { formatUGX } from '@/lib/creditFeeCalculations';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import {
  Loader2, ClipboardCheck, CheckCircle2, HelpCircle, Clock, Paperclip, RefreshCw, Search,
} from 'lucide-react';

type ReviewStatus = 'pending' | 'accepted' | 'clarification_requested';
type TabKey = 'pending' | 'accepted' | 'clarification_requested' | 'all';

interface ReportRow {
  id: string;
  requisition_id: string;
  requester_id: string;
  amount_used: number;
  summary: string;
  submitted_at: string | null;
  attachment_paths: string[] | null;
  review_status: ReviewStatus;
  reviewed_at: string | null;
  review_note: string | null;
  requisition: {
    requisition_code: string;
    title: string;
    category: string | null;
    amount: number;
    approved_amount: number | null;
    requester_name: string | null;
    cfo_decided_at: string | null;
  } | null;
}

const STATUS_META: Record<ReviewStatus, { label: string; className: string }> = {
  pending: { label: 'Pending review', className: 'bg-amber-500/10 text-amber-700 border-amber-500/30' },
  accepted: { label: 'Reviewed / Accepted', className: 'bg-emerald-500/10 text-emerald-700 border-emerald-500/30' },
  clarification_requested: { label: 'Clarification requested', className: 'bg-sky-500/10 text-sky-700 border-sky-500/30' },
};

function fmtDate(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}

const approvedOf = (r: ReportRow) => Number(r.requisition?.approved_amount ?? r.requisition?.amount ?? 0);

/**
 * CFO accountability review of requisition usage reports already submitted by
 * requesters. Read + review-state only: this never touches the requisition
 * approval flow, wallets or the ledger.
 */
export function RequisitionUsageReportsReview() {
  const { user } = useAuth();
  const [rows, setRows] = useState<ReportRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<TabKey>('pending');
  const [search, setSearch] = useState('');
  const [detail, setDetail] = useState<ReportRow | null>(null);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState<'accept' | 'clarify' | null>(null);
  const [viewingPath, setViewingPath] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('staff_requisition_usage_reports')
      .select(`
        id, requisition_id, requester_id, amount_used, summary, submitted_at,
        attachment_paths, review_status, reviewed_at, review_note,
        requisition:staff_requisitions!staff_requisition_usage_reports_requisition_id_fkey (
          requisition_code, title, category, amount, approved_amount, requester_name, cfo_decided_at
        )
      `)
      .order('submitted_at', { ascending: false })
      .limit(500);
    setLoading(false);
    if (error) {
      toast.error('Could not load usage reports', { description: error.message });
      return;
    }
    setRows((data ?? []) as unknown as ReportRow[]);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const counts = useMemo(() => ({
    pending: rows.filter((r) => r.review_status === 'pending').length,
    accepted: rows.filter((r) => r.review_status === 'accepted').length,
    clarification_requested: rows.filter((r) => r.review_status === 'clarification_requested').length,
    all: rows.length,
  }), [rows]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows
      .filter((r) => (tab === 'all' ? true : r.review_status === tab))
      .filter((r) => {
        if (!q) return true;
        return [
          r.requisition?.requester_name,
          r.requisition?.requisition_code,
          r.requisition?.title,
          r.summary,
        ].some((v) => (v || '').toLowerCase().includes(q));
      });
  }, [rows, tab, search]);

  const openReceipt = async (row: ReportRow, path: string) => {
    setViewingPath(path);
    const { data, error } = await invokeEdgeFunction<{ url: string }>('staff-requisition-attachment-url', {
      body: { requisition_id: row.requisition_id, path },
      errorTitle: 'Could not open receipt',
    });
    setViewingPath(null);
    if (!error && data?.url) window.open(data.url, '_blank');
  };

  const decide = async (mode: 'accept' | 'clarify') => {
    if (!detail) return;
    if (mode === 'clarify' && note.trim().length < 10) {
      toast.error('Please write at least 10 characters explaining what is unclear.');
      return;
    }
    setSaving(mode);
    const { error } = await supabase
      .from('staff_requisition_usage_reports')
      .update({
        review_status: mode === 'accept' ? 'accepted' : 'clarification_requested',
        reviewed_by: user?.id ?? null,
        reviewed_at: new Date().toISOString(),
        review_note: note.trim() || null,
      })
      .eq('id', detail.id);
    setSaving(null);
    if (error) {
      toast.error('Could not save your decision', { description: error.message });
      return;
    }
    toast.success(mode === 'accept' ? 'Report accepted' : 'Clarification requested');
    setDetail(null);
    setNote('');
    void load();
  };

  return (
    <Card className="rounded-2xl">
      <CardContent className="space-y-4 p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="flex items-center gap-2 text-sm font-semibold">
              <ClipboardCheck className="h-4 w-4 text-muted-foreground" /> Accountability — requisition usage reports
            </p>
            <p className="text-sm text-muted-foreground">
              What requesters reported spending after approval, with their receipts.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            {loading ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-1 h-4 w-4" />}
            Refresh
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Tabs value={tab} onValueChange={(v) => setTab(v as TabKey)}>
            <TabsList>
              <TabsTrigger value="pending">Pending ({counts.pending})</TabsTrigger>
              <TabsTrigger value="accepted">Accepted ({counts.accepted})</TabsTrigger>
              <TabsTrigger value="clarification_requested">Clarification ({counts.clarification_requested})</TabsTrigger>
              <TabsTrigger value="all">All ({counts.all})</TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="relative min-w-[200px] flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-9"
              placeholder="Search person, code or title"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading reports…
          </div>
        ) : visible.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">No reports here yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">Requester</th>
                  <th className="py-2 pr-3 font-medium">Requisition</th>
                  <th className="py-2 pr-3 text-right font-medium">Approved</th>
                  <th className="py-2 pr-3 text-right font-medium">Used</th>
                  <th className="py-2 pr-3 text-right font-medium">Remaining</th>
                  <th className="py-2 pr-3 font-medium">Submitted</th>
                  <th className="py-2 pr-3 font-medium">Receipt</th>
                  <th className="py-2 pr-3 font-medium">Status</th>
                  <th className="py-2 font-medium" />
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => {
                  const approved = approvedOf(r);
                  const remaining = approved - Number(r.amount_used);
                  const receipts = r.attachment_paths?.length ?? 0;
                  return (
                    <tr key={r.id} className="border-b last:border-0 align-top">
                      <td className="py-3 pr-3 font-medium">{r.requisition?.requester_name || '—'}</td>
                      <td className="py-3 pr-3">
                        <p className="font-medium">{r.requisition?.title || '—'}</p>
                        <p className="text-xs text-muted-foreground">
                          {r.requisition?.requisition_code}
                          {r.requisition?.category ? ` • ${r.requisition.category}` : ''}
                        </p>
                      </td>
                      <td className="py-3 pr-3 text-right tabular-nums">{formatUGX(approved)}</td>
                      <td className="py-3 pr-3 text-right tabular-nums">{formatUGX(Number(r.amount_used))}</td>
                      <td className={`py-3 pr-3 text-right tabular-nums ${remaining < 0 ? 'text-red-600' : ''}`}>
                        {formatUGX(remaining)}
                      </td>
                      <td className="py-3 pr-3 text-xs text-muted-foreground">{fmtDate(r.submitted_at)}</td>
                      <td className="py-3 pr-3">
                        {receipts === 0 ? (
                          <span className="text-xs text-muted-foreground">None</span>
                        ) : (
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7"
                            disabled={viewingPath === r.attachment_paths![0]}
                            onClick={() => void openReceipt(r, r.attachment_paths![0])}
                          >
                            <Paperclip className="mr-1 h-3.5 w-3.5" />
                            {receipts > 1 ? `${receipts} files` : 'Open'}
                          </Button>
                        )}
                      </td>
                      <td className="py-3 pr-3">
                        <Badge variant="outline" className={STATUS_META[r.review_status].className}>
                          {STATUS_META[r.review_status].label}
                        </Badge>
                      </td>
                      <td className="py-3">
                        <Button
                          size="sm"
                          variant="secondary"
                          className="h-7"
                          onClick={() => { setDetail(r); setNote(r.review_note ?? ''); }}
                        >
                          View report
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>

      <Dialog open={!!detail} onOpenChange={(o) => { if (!o) { setDetail(null); setNote(''); } }}>
        <DialogContent className="max-w-lg">
          {detail && (
            <>
              <DialogHeader>
                <DialogTitle>{detail.requisition?.title || 'Usage report'}</DialogTitle>
                <DialogDescription>
                  {detail.requisition?.requisition_code} • {detail.requisition?.requester_name || 'Requester'}
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4">
                <div className="grid grid-cols-3 gap-3 text-sm">
                  <div>
                    <p className="text-xs text-muted-foreground">Approved</p>
                    <p className="font-semibold tabular-nums">{formatUGX(approvedOf(detail))}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Used</p>
                    <p className="font-semibold tabular-nums">{formatUGX(Number(detail.amount_used))}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Remaining</p>
                    <p className="font-semibold tabular-nums">
                      {formatUGX(approvedOf(detail) - Number(detail.amount_used))}
                    </p>
                  </div>
                </div>

                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground">
                    Approved on {fmtDate(detail.requisition?.cfo_decided_at ?? null)} • reported {fmtDate(detail.submitted_at)}
                  </p>
                  <div className="rounded-xl border bg-muted/30 p-3 text-sm whitespace-pre-wrap">
                    {detail.summary}
                  </div>
                </div>

                {(detail.attachment_paths?.length ?? 0) > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {detail.attachment_paths!.map((path, i) => (
                      <Button
                        key={path}
                        variant="outline"
                        size="sm"
                        disabled={viewingPath === path}
                        onClick={() => void openReceipt(detail, path)}
                      >
                        {viewingPath === path
                          ? <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                          : <Paperclip className="mr-1 h-4 w-4" />}
                        Receipt {i + 1}
                      </Button>
                    ))}
                  </div>
                )}

                <div className="flex items-center gap-2 text-sm">
                  <Badge variant="outline" className={STATUS_META[detail.review_status].className}>
                    {detail.review_status === 'pending'
                      ? <Clock className="mr-1 h-3.5 w-3.5" />
                      : detail.review_status === 'accepted'
                        ? <CheckCircle2 className="mr-1 h-3.5 w-3.5" />
                        : <HelpCircle className="mr-1 h-3.5 w-3.5" />}
                    {STATUS_META[detail.review_status].label}
                  </Badge>
                  {detail.reviewed_at && (
                    <span className="text-xs text-muted-foreground">on {fmtDate(detail.reviewed_at)}</span>
                  )}
                </div>

                <div className="space-y-2">
                  <Label htmlFor="review-note">Your note {detail.review_status === 'pending' ? '(required to request clarification)' : ''}</Label>
                  <Textarea
                    id="review-note"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="What is missing or unclear, or a note on acceptance"
                    rows={3}
                  />
                </div>
              </div>

              <DialogFooter className="gap-2">
                <Button
                  variant="outline"
                  onClick={() => void decide('clarify')}
                  disabled={saving !== null}
                >
                  {saving === 'clarify'
                    ? <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                    : <HelpCircle className="mr-1 h-4 w-4" />}
                  Request clarification
                </Button>
                <Button onClick={() => void decide('accept')} disabled={saving !== null}>
                  {saving === 'accept'
                    ? <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                    : <CheckCircle2 className="mr-1 h-4 w-4" />}
                  Accept report
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}

export default RequisitionUsageReportsReview;
