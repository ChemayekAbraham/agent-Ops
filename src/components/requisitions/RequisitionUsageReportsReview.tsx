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
  receipt_total: number | null;
  discrepancy_flag: boolean;
  discrepancy_reasons: string[] | null;
  receipt_mismatch_explanation: string | null;
  unspent_explanation: string | null;
  overspend_explanation: string | null;
  refund_status: 'made' | 'pending' | 'not_required' | null;
  refund_evidence_paths: string[] | null;
  refund_not_required_reason: string | null;
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

interface ReviewEntry { id: string; decision: string; note: string; verified_receipt_total: number | null; created_at: string }
const DECISION_LABEL: Record<string, string> = {
  verify_amount: 'Verified receipt total', accept_discrepancy: 'Accepted discrepancy',
  request_clarification: 'Requested clarification', require_refund: 'Required refund',
};
const REASON_LABEL: Record<string, string> = {
  receipt_total_unverified: 'Receipt total not entered — verify manually',
  receipt_vs_used_mismatch: 'Receipts differ from amount used',
  unspent_balance: 'Unspent balance', overspend: 'Spent above approval',
};
const REFUND_LABEL = { made: 'Refund made', pending: 'Refund pending', not_required: 'Not required per policy' } as const;

/**
 * CFO accountability review of requisition usage reports already submitted by
 * requesters. Read + review-state only: this never touches the requisition
 * approval flow, wallets or the ledger.
 */
export function RequisitionUsageReportsReview() {
  const { user } = useAuth();
  const [rows, setRows] = useState<ReportRow[]>([]);
  const [deferCounts, setDeferCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<TabKey>('pending');
  const [search, setSearch] = useState('');
  const [detail, setDetail] = useState<ReportRow | null>(null);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState<'accept' | 'clarify' | null>(null);
  const [viewingPath, setViewingPath] = useState<string | null>(null);
  const [verifiedTotal, setVerifiedTotal] = useState('');
  const [reviews, setReviews] = useState<ReviewEntry[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('staff_requisition_usage_reports')
      .select(`
        id, requisition_id, requester_id, amount_used, summary, submitted_at,
        attachment_paths, review_status, reviewed_at, review_note,
        receipt_total, discrepancy_flag, discrepancy_reasons, receipt_mismatch_explanation,
        unspent_explanation, overspend_explanation, refund_status, refund_evidence_paths, refund_not_required_reason,
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
    const ids = (data ?? []).map((r: any) => r.requisition_id);
    if (ids.length) {
      const { data: defs } = await supabase
        .from('staff_requisition_usage_report_deferrals')
        .select('requisition_id')
        .in('requisition_id', ids);
      const c: Record<string, number> = {};
      (defs || []).forEach((d) => { c[d.requisition_id] = (c[d.requisition_id] || 0) + 1; });
      setDeferCounts(c);
    }
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

  const recordReview = async (decision: 'verify_amount' | 'accept_discrepancy' | 'request_clarification' | 'require_refund') => {
    if (!detail) return false;
    const verified = verifiedTotal === '' ? null : Number(verifiedTotal);
    const { error } = await (supabase.rpc as any)('review_requisition_usage_report', {
      p_report_id: detail.id, p_decision: decision, p_note: note.trim(), p_verified_receipt_total: verified,
    });
    if (error) { toast.error('Could not record the review', { description: error.message }); return false; }
    return true;
  };

  const decide = async (mode: 'accept' | 'clarify' | 'refund' | 'verify') => {
    if (!detail) return;
    if ((mode !== 'accept' || detail.discrepancy_flag) && note.trim().length < 10) {
      toast.error('Please write a note of at least 10 characters.');
      return;
    }
    if (mode === 'verify' && verifiedTotal === '') { toast.error('Enter the verified receipt total.'); return; }
    setSaving(mode === 'accept' ? 'accept' : 'clarify');
    if (mode === 'verify') {
      const ok = await recordReview('verify_amount');
      setSaving(null);
      if (ok) { toast.success('Verified receipt total recorded'); setVerifiedTotal(''); void loadReviews(detail.id); }
      return;
    }
    if (detail.discrepancy_flag || mode === 'refund') {
      const ok = await recordReview(mode === 'accept' ? 'accept_discrepancy' : mode === 'refund' ? 'require_refund' : 'request_clarification');
      if (!ok) { setSaving(null); return; }
    }
    let error: { message: string } | null = null;
    if (mode === 'accept' || !detail.discrepancy_flag && mode === 'clarify') {
      ({ error } = await supabase
        .from('staff_requisition_usage_reports')
        .update({
          review_status: mode === 'accept' ? 'accepted' : 'clarification_requested',
          reviewed_by: user?.id ?? null,
          reviewed_at: new Date().toISOString(),
          review_note: note.trim() || null,
        })
        .eq('id', detail.id));
    }
    setSaving(null);
    if (error) {
      toast.error('Could not save your decision', { description: error.message });
      return;
    }
    toast.success(mode === 'accept' ? 'Report accepted' : mode === 'refund' ? 'Refund required — requester asked to follow up' : 'Clarification requested');
    setDetail(null);
    setNote('');
    void load();
  };

  const loadReviews = useCallback(async (reportId: string) => {
    const { data } = await (supabase.from as any)('staff_requisition_usage_report_reviews')
      .select('id, decision, note, verified_receipt_total, created_at').eq('report_id', reportId).order('created_at');
    setReviews((data ?? []) as ReviewEntry[]);
  }, []);
  useEffect(() => { if (detail) void loadReviews(detail.id); else setReviews([]); }, [detail, loadReviews]);

  return (
    <Card className="rounded-2xl">
      <CardContent className="space-y-5 p-4 sm:p-6 lg:p-8">
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
          <div className="max-h-[80vh] min-h-[480px] overflow-auto rounded-xl border">
            <table className="w-full min-w-[1000px] text-base">
              <thead className="sticky top-0 z-10 bg-muted">
                <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="py-3 pr-4 first:pl-4 font-medium">Requester</th>
                  <th className="py-3 pr-4 first:pl-4 font-medium">Requisition</th>
                  <th className="py-3 pr-4 first:pl-4 text-right font-medium">Approved</th>
                  <th className="py-3 pr-4 first:pl-4 text-right font-medium">Used</th>
                  <th className="py-3 pr-4 first:pl-4 text-right font-medium">Remaining</th>
                  <th className="py-3 pr-4 first:pl-4 font-medium">Submitted</th>
                  <th className="py-3 pr-4 first:pl-4 font-medium">Receipt</th>
                  <th className="py-3 pr-4 first:pl-4 font-medium">Status</th>
                  <th className="py-3 pr-4 font-medium" />
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => {
                  const approved = approvedOf(r);
                  const remaining = approved - Number(r.amount_used);
                  const receipts = r.attachment_paths?.length ?? 0;
                  return (
                    <tr key={r.id} className="border-b align-top transition-colors last:border-0 hover:bg-muted/40">
                      <td className="py-5 pr-4 first:pl-4 font-medium">{r.requisition?.requester_name || '—'}</td>
                      <td className="py-5 pr-4 first:pl-4">
                        <p className="font-medium">{r.requisition?.title || '—'}</p>
                        <p className="text-xs text-muted-foreground">
                          {r.requisition?.requisition_code}
                          {r.requisition?.category ? ` • ${r.requisition.category}` : ''}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          Approved {fmtDate(r.requisition?.cfo_decided_at ?? null)} • Due {r.requisition?.cfo_decided_at ? fmtDate(new Date(new Date(r.requisition.cfo_decided_at).getTime() + 36 * 3600 * 1000).toISOString()) : '—'} • Deferred {deferCounts[r.requisition_id] || 0} of 2
                        </p>
                      </td>
                      <td className="py-5 pr-4 first:pl-4 text-right tabular-nums">{formatUGX(approved)}</td>
                      <td className="py-5 pr-4 first:pl-4 text-right tabular-nums">{formatUGX(Number(r.amount_used))}</td>
                      <td className={`py-5 pr-4 first:pl-4 text-right tabular-nums ${remaining < 0 ? 'text-red-600' : ''}`}>
                        {formatUGX(remaining)}
                      </td>
                      <td className="py-5 pr-4 first:pl-4 text-xs text-muted-foreground">{fmtDate(r.submitted_at)}</td>
                      <td className="py-5 pr-4 first:pl-4">
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
                      <td className="py-5 pr-4 first:pl-4">
                        <Badge variant="outline" className={STATUS_META[r.review_status].className}>
                          {STATUS_META[r.review_status].label}
                        </Badge>
                        {r.discrepancy_flag && (
                          <Badge variant="outline" className="ml-1 border-destructive/30 bg-destructive/10 text-destructive">Needs review</Badge>
                        )}
                      </td>
                      <td className="py-5 pr-4">
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

                {(() => {
                  const appr = approvedOf(detail);
                  const rec = detail.receipt_total;
                  return (
                    <div className="space-y-2 rounded-xl border p-3 text-sm" aria-label="Amount matching">
                      <div className="grid grid-cols-3 gap-2 text-center">
                        <div><p className="text-xs text-muted-foreground">Approved</p><p className="font-semibold">{formatUGX(appr)}</p></div>
                        <div><p className="text-xs text-muted-foreground">Used</p><p className="font-semibold">{formatUGX(Number(detail.amount_used))}</p></div>
                        <div><p className="text-xs text-muted-foreground">Receipts</p><p className="font-semibold">{rec == null ? 'Not entered' : formatUGX(Number(rec))}</p></div>
                      </div>
                      {rec != null && (
                        <p className="text-xs text-muted-foreground">
                          Receipts − used: {formatUGX(Number(rec) - Number(detail.amount_used))} · Approved − receipts: {formatUGX(appr - Number(rec))}
                        </p>
                      )}
                      {detail.discrepancy_flag && (
                        <div className="flex flex-wrap gap-1">
                          {(detail.discrepancy_reasons ?? []).map((r) => (
                            <Badge key={r} variant="outline" className="border-destructive/30 bg-destructive/10 text-destructive">{REASON_LABEL[r] ?? r}</Badge>
                          ))}
                        </div>
                      )}
                      {detail.receipt_mismatch_explanation && <p><span className="font-medium">Mismatch:</span> {detail.receipt_mismatch_explanation}</p>}
                      {detail.overspend_explanation && <p><span className="font-medium">Overspend:</span> {detail.overspend_explanation}</p>}
                      {detail.unspent_explanation && <p><span className="font-medium">Unspent balance:</span> {detail.unspent_explanation}</p>}
                      {detail.refund_status && <p><span className="font-medium">Refund:</span> {REFUND_LABEL[detail.refund_status]}{detail.refund_not_required_reason ? ` — ${detail.refund_not_required_reason}` : ''}</p>}
                      {(detail.refund_evidence_paths ?? []).map((p, i) => (
                        <Button key={p} variant="outline" size="sm" onClick={() => void openReceipt(detail, p)}><Paperclip className="mr-1 h-4 w-4" />Refund proof {i + 1}</Button>
                      ))}
                      <div className="flex flex-wrap items-end gap-2 pt-1">
                        <div className="space-y-1">
                          <Label htmlFor="verified-total" className="text-xs">Verified receipt total (UGX)</Label>
                          <Input id="verified-total" inputMode="numeric" className="h-8 w-40" value={verifiedTotal}
                            onChange={(e) => setVerifiedTotal(e.target.value.replace(/[^0-9.]/g, ''))} />
                        </div>
                        <Button size="sm" variant="outline" onClick={() => void decide('verify')} disabled={saving !== null}>Record verification</Button>
                      </div>
                      {reviews.length > 0 && (
                        <ul className="space-y-1 border-t pt-2 text-xs text-muted-foreground">
                          {reviews.map((v) => (
                            <li key={v.id}>{fmtDate(v.created_at)} · {DECISION_LABEL[v.decision] ?? v.decision}{v.verified_receipt_total != null ? ` (${formatUGX(Number(v.verified_receipt_total))})` : ''} — {v.note}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  );
                })()}

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
                {(detail.discrepancy_flag || (detail.unspent_explanation ?? '') !== '') && (
                  <Button variant="outline" onClick={() => void decide('refund')} disabled={saving !== null}>
                    Require refund
                  </Button>
                )}
                <Button onClick={() => void decide('accept')} disabled={saving !== null}>
                  {saving === 'accept'
                    ? <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                    : <CheckCircle2 className="mr-1 h-4 w-4" />}
                  {detail.discrepancy_flag ? 'Accept discrepancy' : 'Accept report'}
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
