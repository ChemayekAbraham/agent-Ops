import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  AlertTriangle, ArrowRightCircle, CheckCircle2, ChevronDown, ChevronRight, FileText,
  Loader2, RefreshCw, RotateCcw, XCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { formatDynamic as formatUGX } from '@/lib/currencyFormat';
import {
  BUDGET_ROUTE_LABEL, fetchBudgetReviewQueue, fetchLines, getBudgetDocumentUrl,
  type BudgetLine, type BudgetQueueRow, type BudgetReviewStage,
} from '@/hooks/useDepartmentBudgets';

interface Props {
  /** Budget cycle to scope the queue to; null shows every cycle. */
  cycleId: string | null;
  /** 'cfo' = full queue (post-COO for ops departments); 'coo' = the four ops departments only. */
  stage: BudgetReviewStage;
}

/** Stages where the reviewer of this screen may still act on the submission. */
const OPEN_STATUSES: Record<BudgetReviewStage, string[]> = {
  cfo: ['submitted', 'under_review'],
  coo: ['pending_coo', 'coo_under_review'],
};

/**
 * Shared department-budget review surface used by the CFO and, scoped to the four
 * operations departments, by the COO. Every figure — submission total, approved
 * total — is summed live from budget_submission_lines server-side; nothing is
 * hard-coded and no accounting/ledger logic is touched.
 */
export default function BudgetReviewQueue({ cycleId, stage }: Props) {
  const [rows, setRows] = useState<BudgetQueueRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [lines, setLines] = useState<BudgetLine[]>([]);
  const [lineEdits, setLineEdits] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [comment, setComment] = useState('');

  const isCoo = stage === 'coo';

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await fetchBudgetReviewQueue(cycleId, stage));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not load submissions');
    } finally {
      setLoading(false);
    }
  }, [cycleId, stage]);

  useEffect(() => { load(); }, [load]);

  const loadLines = useCallback(async (submissionId: string) => {
    const fetched = await fetchLines(submissionId);
    setLines(fetched);
    setLineEdits(Object.fromEntries(fetched.map(l => [
      l.id,
      String((isCoo ? l.coo_approved_amount : l.approved_amount) ?? l.line_total ?? 0),
    ])));
  }, [isCoo]);

  const toggle = async (s: BudgetQueueRow) => {
    if (expanded === s.id) { setExpanded(null); return; }
    setExpanded(s.id);
    setComment('');
    try {
      await loadLines(s.id);
      if (isCoo && s.status === 'pending_coo') {
        await supabase.rpc('budget_coo_start_review', { p_submission_id: s.id });
        await load();
      } else if (!isCoo && s.status === 'submitted') {
        await supabase.rpc('budget_start_review', { p_submission_id: s.id });
        await load();
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not load budget lines');
    }
  };

  const decideLine = async (line: BudgetLine, decision: 'approved' | 'rejected') => {
    setBusy(line.id);
    try {
      const { error } = await supabase.rpc(
        isCoo ? 'budget_coo_decide_line' : 'budget_decide_line',
        {
          p_line_id: line.id,
          p_decision: decision,
          p_approved_amount: decision === 'approved' ? Number(lineEdits[line.id] ?? 0) : 0,
          p_note: null,
        },
      );
      if (error) throw error;
      await loadLines(line.submission_id);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Decision failed');
    } finally {
      setBusy(null);
    }
  };

  const cfoFinalize = async (s: BudgetQueueRow, decision: 'approved' | 'rejected') => {
    setBusy(s.id);
    try {
      const { error } = await supabase.rpc('budget_finalize_submission', {
        p_submission_id: s.id, p_decision: decision, p_comment: comment.trim() || null,
      });
      if (error) throw error;
      toast.success(decision === 'approved' ? 'Budget approved' : 'Budget rejected');
      setComment('');
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not finalise');
    } finally {
      setBusy(null);
    }
  };

  const cooForward = async (s: BudgetQueueRow) => {
    setBusy(s.id);
    try {
      const { error } = await supabase.rpc('budget_coo_forward_submission', {
        p_submission_id: s.id, p_comment: comment.trim() || null,
      });
      if (error) throw error;
      toast.success('Approved and forwarded to the CFO');
      setComment('');
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not forward to the CFO');
    } finally {
      setBusy(null);
    }
  };

  const sendBack = async (s: BudgetQueueRow, decision: 'rejected' | 'revision_requested') => {
    if (comment.trim().length < 10) {
      toast.error('Give the department at least 10 characters of guidance');
      return;
    }
    setBusy(s.id);
    try {
      const { error } = isCoo
        ? await supabase.rpc('budget_coo_return_submission', {
            p_submission_id: s.id, p_decision: decision, p_comment: comment.trim(),
          })
        : decision === 'rejected'
          ? await supabase.rpc('budget_finalize_submission', {
              p_submission_id: s.id, p_decision: 'rejected', p_comment: comment.trim(),
            })
          : await supabase.rpc('budget_request_revision', {
              p_submission_id: s.id, p_comment: comment.trim(),
            });
      if (error) throw error;
      toast.success(decision === 'rejected'
        ? 'Rejected — the department can revise and resubmit'
        : 'Revision requested — a new draft version was created for the department');
      setComment('');
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not send back to the department');
    } finally {
      setBusy(null);
    }
  };

  const awaiting = useMemo(
    () => rows.filter(r => OPEN_STATUSES[stage].includes(r.status)),
    [rows, stage],
  );
  const requested = useMemo(() => rows.reduce((sum, r) => sum + r.total_amount, 0), [rows]);
  const approved = useMemo(
    () => rows.reduce((sum, r) => sum + (isCoo ? r.coo_approved_total : r.cfo_approved_total), 0),
    [rows, isCoo],
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {isCoo
            ? 'Tenant Ops, Agent Ops, Landlord Ops and Partner Ops budgets. Your approval forwards them to the CFO.'
            : 'Budgets that have reached the CFO. Operations departments appear only after COO approval.'}
        </p>
        <Button size="sm" variant="outline" className="h-8 gap-1.5 text-xs" onClick={load}>
          <RefreshCw className="h-3.5 w-3.5" /> Refresh
        </Button>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <Kpi label="Awaiting review" value={String(awaiting.length)} />
        <Kpi label="Requested" value={formatUGX(requested)} />
        <Kpi label={isCoo ? 'COO approved' : 'CFO approved'} value={formatUGX(approved)} />
      </div>

      {loading && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      )}

      {!loading && rows.length === 0 && (
        <p className="text-xs text-muted-foreground">No department budgets in this queue yet.</p>
      )}

      {rows.map(s => {
        const open = OPEN_STATUSES[stage].includes(s.status);
        const lineDecision = (l: BudgetLine) => (isCoo ? l.coo_status : l.status);
        return (
          <Card key={s.id}>
            <button onClick={() => toggle(s)} className="flex w-full items-center gap-2 p-3 text-left">
              {expanded === s.id ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="font-medium">{s.department_name}</span>
                  {s.cycle_title && (
                    <Badge variant="outline" className="text-[10px] font-normal">
                      {s.cycle_title}
                    </Badge>
                  )}
                  <span className="font-mono text-muted-foreground">{s.reference}</span>
                  <Badge variant="outline" className="text-[10px]">v{s.version}</Badge>
                  <Badge variant="secondary" className="text-[10px]">
                    {s.status === 'pending_coo' ? 'Pending COO approval' : s.status.replace(/_/g, ' ')}
                  </Badge>
                  <Badge variant="outline" className="text-[10px]">{BUDGET_ROUTE_LABEL[s.route]}</Badge>
                  {s.is_late && (
                    <Badge variant="destructive" className="gap-1 text-[10px]">
                      <AlertTriangle className="h-3 w-3" /> late
                    </Badge>
                  )}
                </div>
                <p className="mt-1 truncate text-xs text-muted-foreground">
                  {s.title ?? 'Untitled'} · {s.line_count} line{s.line_count === 1 ? '' : 's'} ·
                  {' '}total {formatUGX(s.total_amount)}
                  {s.coo_approved_total > 0 && ` · COO ${formatUGX(s.coo_approved_total)}`}
                  {s.cfo_approved_total > 0 && ` · CFO ${formatUGX(s.cfo_approved_total)}`}
                  {s.submitted_at && ` · submitted ${format(new Date(s.submitted_at), 'dd MMM yyyy')}`}
                </p>
              </div>
            </button>

            {expanded === s.id && (
              <CardContent className="space-y-3 border-t border-border pt-3">
                {s.purpose && <p className="text-xs text-muted-foreground">{s.purpose}</p>}
                {!isCoo && s.route === 'coo' && s.coo_reviewed_at && (
                  <p className="text-xs text-muted-foreground">
                    COO approved {format(new Date(s.coo_reviewed_at), 'dd MMM yyyy HH:mm')}
                    {s.coo_comment ? ` — ${s.coo_comment}` : ''}
                    {' '}· COO recommended {formatUGX(s.coo_approved_total)}
                  </p>
                )}
                {isCoo && s.cfo_comment && (
                  <p className="text-xs text-muted-foreground">CFO note: {s.cfo_comment}</p>
                )}

                {lines.map(l => (
                  <div key={l.id} className="space-y-2 rounded-lg border border-border p-3 text-xs">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium">{l.description}</span>
                      <Badge variant="outline" className="text-[10px]">{l.account_code ?? 'uncategorised'}</Badge>
                    </div>
                    <p className="text-muted-foreground">
                      Qty {Number(l.quantity)} × {formatUGX(Number(l.unit_amount))} = {formatUGX(Number(l.line_total ?? 0))}
                      {l.period_month && ` · ${format(new Date(l.period_month), 'MMM yyyy')}`}
                    </p>
                    {l.justification && <p className="text-muted-foreground">Description: {l.justification}</p>}
                    {!isCoo && l.coo_status !== 'pending' && (
                      <p className="text-muted-foreground">
                        COO: {l.coo_status.replace(/_/g, ' ')}
                        {l.coo_approved_amount != null && ` at ${formatUGX(Number(l.coo_approved_amount))}`}
                        {l.coo_note ? ` — ${l.coo_note}` : ''}
                      </p>
                    )}
                    {l.document_path && (
                      <Button size="sm" variant="ghost" className="h-7 gap-1 px-2 text-[11px]"
                        onClick={async () => {
                          try { window.open(await getBudgetDocumentUrl(l.document_path!), '_blank'); }
                          catch { toast.error('Could not open supporting document'); }
                        }}>
                        <FileText className="h-3.5 w-3.5" /> View supporting document
                      </Button>
                    )}
                    <div className="flex flex-wrap items-end gap-2">
                      <div>
                        <Label className="text-[11px]">Approved amount (UGX)</Label>
                        <Input className="h-8 w-40 text-xs" type="number" min="0" disabled={!open}
                          value={lineEdits[l.id] ?? ''}
                          onChange={e => setLineEdits(p => ({ ...p, [l.id]: e.target.value }))} />
                      </div>
                      <Button size="sm" className="h-8 gap-1 text-xs" disabled={busy === l.id || !open}
                        onClick={() => decideLine(l, 'approved')}>
                        <CheckCircle2 className="h-3.5 w-3.5" /> Approve line
                      </Button>
                      <Button size="sm" variant="outline" className="h-8 gap-1 text-xs text-destructive"
                        disabled={busy === l.id || !open} onClick={() => decideLine(l, 'rejected')}>
                        <XCircle className="h-3.5 w-3.5" /> Reject line
                      </Button>
                      <Badge variant="secondary" className="text-[10px]">{lineDecision(l).replace(/_/g, ' ')}</Badge>
                    </div>
                  </div>
                ))}

                {open && (
                  <>
                    <div>
                      <Label className="text-xs">{isCoo ? 'COO comment' : 'CFO comment'}</Label>
                      <Textarea rows={2} value={comment} onChange={e => setComment(e.target.value)}
                        placeholder="Guidance for the department (at least 10 characters to reject or request a revision)" />
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {isCoo ? (
                        <Button size="sm" className="gap-1.5 text-xs" disabled={busy === s.id}
                          onClick={() => cooForward(s)}>
                          <ArrowRightCircle className="h-3.5 w-3.5" /> Approve &amp; forward to CFO
                        </Button>
                      ) : (
                        <Button size="sm" className="gap-1.5 text-xs" disabled={busy === s.id}
                          onClick={() => cfoFinalize(s, 'approved')}>
                          <CheckCircle2 className="h-3.5 w-3.5" /> Approve budget
                        </Button>
                      )}
                      <Button size="sm" variant="outline" className="gap-1.5 text-xs" disabled={busy === s.id}
                        onClick={() => sendBack(s, 'revision_requested')}>
                        <RotateCcw className="h-3.5 w-3.5" /> Request revision
                      </Button>
                      <Button size="sm" variant="outline" className="gap-1.5 text-xs text-destructive"
                        disabled={busy === s.id} onClick={() => sendBack(s, 'rejected')}>
                        <XCircle className="h-3.5 w-3.5" /> Reject
                      </Button>
                      {s.pending_lines > 0 && (
                        <span className="self-center text-[11px] text-muted-foreground">
                          {s.pending_lines} line item{s.pending_lines === 1 ? '' : 's'} still undecided
                        </span>
                      )}
                    </div>
                  </>
                )}
              </CardContent>
            )}
          </Card>
        );
      })}
    </div>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border p-3">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className="mt-0.5 font-mono text-sm font-semibold">{value}</p>
    </div>
  );
}
