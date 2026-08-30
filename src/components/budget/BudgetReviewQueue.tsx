import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from '@/components/ui/sheet';
import { Card, CardContent } from '@/components/ui/card';
import {
  AlertTriangle, ArrowRightCircle, Building2, CheckCircle2,
  ChevronRight, FileText, Loader2, RefreshCw, RotateCcw,
  XCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { formatDynamic as formatUGX } from '@/lib/currencyFormat';
import {
  fetchBudgetReviewQueue, fetchLines, getBudgetDocumentUrl,
  type BudgetLine, type BudgetQueueRow, type BudgetReviewStage,
} from '@/hooks/useDepartmentBudgets';


interface Props {
  /** Budget cycle to scope the queue to; null shows every cycle. */
  cycleId: string | null;
  /** 'cfo' = full queue (post-COO for ops departments); 'coo' = the four ops departments only. */
  stage: BudgetReviewStage;
  /** Show only submissions this reviewer may still act on (hides decided history). */
  onlyOpen?: boolean;
  /** Intro copy override for the section. */
  intro?: string;
  /** Empty-state copy override. */
  emptyLabel?: string;
}

/** Stages where the reviewer of this screen may still act on the submission. */
const OPEN_STATUSES: Record<BudgetReviewStage, string[]> = {
  cfo: ['submitted', 'under_review'],
  coo: ['pending_coo', 'coo_under_review'],
};

const STATUS_LABEL: Record<string, string> = {
  pending_coo: 'Pending COO Approval',
  coo_under_review: 'Under COO Review',
  submitted: 'Submitted',
  under_review: 'Under Review',
  approved: 'Approved',
  rejected: 'Rejected',
  revision_requested: 'Revision Requested',
  returned: 'Returned',
  released: 'Released',
  paid: 'Paid',
  cancelled: 'Cancelled',
  superseded: 'Superseded',
  draft: 'Draft',
};

/**
 * Shared department-budget review surface used by the CFO and, scoped to the four
 * operations departments, by the COO. Every figure — submission total, approved
 * total — is summed live from budget_submission_lines server-side; nothing is
 * hard-coded and no accounting/ledger logic is touched.
 *
 * When `onlyOpen` is true the component renders a polished executive approval queue:
 * strong header, pending-count badge, total requested, and structured rows that
 * surface Department, Reference, Items, Period, Urgency, Submission Date, Amount,
 * Justification and Supporting Documents.
 */
export default function BudgetReviewQueue({ cycleId, stage, onlyOpen, intro, emptyLabel }: Props) {
  const [rows, setRows] = useState<BudgetQueueRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [linesBySubmission, setLinesBySubmission] = useState<Record<string, BudgetLine[]>>({});
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
    if (linesBySubmission[submissionId]) return;
    const fetched = await fetchLines(submissionId);
    setLinesBySubmission(prev => ({ ...prev, [submissionId]: fetched }));
    setLineEdits(prev => ({
      ...prev,
      ...Object.fromEntries(fetched.map(l => [
        l.id,
        String((isCoo ? l.coo_approved_amount : l.approved_amount) ?? l.line_total ?? 0),
      ])),
    }));
  }, [isCoo, linesBySubmission]);

  const openReview = async (s: BudgetQueueRow) => {
    setReviewing(s.id);
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

  const closeReview = () => setReviewing(null);

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
      closeReview();
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
      closeReview();
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
      closeReview();
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
  const visibleRows = onlyOpen ? awaiting : rows;
  const requested = useMemo(
    () => visibleRows.reduce((sum, r) => sum + r.total_amount, 0),
    [visibleRows],
  );
  const approved = useMemo(
    () => visibleRows.reduce((sum, r) => sum + (isCoo ? r.coo_approved_total : r.cfo_approved_total), 0),
    [visibleRows, isCoo],
  );

  const activeSubmission = useMemo(
    () => rows.find(r => r.id === reviewing) ?? null,
    [rows, reviewing],
  );
  const activeLines = useMemo(
    () => activeSubmission ? (linesBySubmission[activeSubmission.id] ?? []) : [],
    [activeSubmission, linesBySubmission],
  );

  return (
    <div className="space-y-4">
      {onlyOpen ? (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-semibold tracking-tight text-foreground">
              Budgets Awaiting Approval
            </h2>
            <Badge variant="secondary" className="h-6 px-2.5 text-xs font-medium">
              {awaiting.length} pending
            </Badge>
          </div>
          <div className="text-left sm:text-right">
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Total requested
            </p>
            <p className="font-mono text-xl font-semibold tracking-tight text-foreground">
              {formatUGX(requested)}
            </p>
          </div>
        </div>
      ) : (
        <div className="flex items-start justify-between gap-3">
          <p className="max-w-2xl text-xs leading-relaxed text-muted-foreground">
            {intro ?? (isCoo
              ? 'Tenant Ops, Agent Ops, Landlord Ops and Partner Ops budgets. Your approval forwards them to the CFO.'
              : 'Budgets that have reached the CFO. Operations departments appear only after COO approval.')}
          </p>
          <Button size="sm" variant="outline" className="h-8 shrink-0 gap-1.5 text-xs" onClick={load}>
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </Button>
        </div>
      )}

      {onlyOpen && intro && (
        <p className="text-sm leading-relaxed text-muted-foreground">{intro}</p>
      )}

      {onlyOpen && (
        <div className="grid grid-cols-3 gap-3">
          <Kpi label="Awaiting review" value={String(awaiting.length)} />
          <Kpi label="Requested" value={formatUGX(requested)} />
          <Kpi label={isCoo ? 'COO approved' : 'CFO approved'} value={formatUGX(approved)} />
        </div>
      )}

      {loading && (
        <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading submissions…
        </div>
      )}

      {!loading && visibleRows.length === 0 && (
        <div className="rounded-lg border border-dashed border-border bg-muted/30 p-6 text-center">
          <p className="text-sm text-muted-foreground">
            {emptyLabel ?? 'No department budgets in this queue yet.'}
          </p>
        </div>
      )}

      {!loading && visibleRows.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/50">
                <TableHead className="text-[11px] uppercase tracking-wider">Department</TableHead>
                <TableHead className="text-[11px] uppercase tracking-wider">Budget Item</TableHead>
                <TableHead className="text-right text-[11px] uppercase tracking-wider">Amount (UGX)</TableHead>
                <TableHead className="text-[11px] uppercase tracking-wider">Required Period</TableHead>
                <TableHead className="text-[11px] uppercase tracking-wider">Priority</TableHead>
                <TableHead className="text-[11px] uppercase tracking-wider">Submitted</TableHead>
                <TableHead className="text-[11px] uppercase tracking-wider">Status</TableHead>
                <TableHead className="w-8" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleRows.map(s => (
                <TableRow
                  key={s.id}
                  role="button"
                  tabIndex={0}
                  className="cursor-pointer"
                  onClick={() => openReview(s)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openReview(s); }
                  }}
                >
                  <TableCell className="py-3">
                    <div className="flex items-center gap-2">
                      <Building2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-foreground">{s.department_name}</p>
                        <p className="truncate font-mono text-[11px] text-muted-foreground">
                          {s.reference} · v{s.version}
                        </p>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                    {s.title || `${s.line_count} line item${s.line_count === 1 ? '' : 's'}`}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-right font-mono text-sm font-semibold text-foreground">
                    {formatUGX(s.total_amount)}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                    {s.cycle_title ?? 'Not specified'}
                  </TableCell>
                  <TableCell>
                    {s.is_late ? (
                      <Badge variant="destructive" className="gap-1 text-[10px]">
                        <AlertTriangle className="h-3 w-3" /> Urgent
                      </Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">Standard</span>
                    )}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                    {s.submitted_at ? format(new Date(s.submitted_at), 'dd MMM yyyy') : '—'}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="text-[10px] font-normal">
                      {STATUS_LABEL[s.status] ?? s.status.replace(/_/g, ' ')}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}


      <Sheet open={!!reviewing} onOpenChange={open => !open && closeReview()}>
        <SheetContent side="center" className="flex max-h-[90vh] w-[95vw] flex-col sm:max-w-3xl">
          {activeSubmission && (
            <ReviewSheet
              submission={activeSubmission}
              lines={activeLines}
              isCoo={isCoo}
              busy={busy}
              comment={comment}
              setComment={setComment}
              lineEdits={lineEdits}
              setLineEdits={setLineEdits}
              onDecideLine={decideLine}
              onForward={cooForward}
              onFinalize={cfoFinalize}
              onSendBack={sendBack}
              onClose={closeReview}
            />
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

interface ReviewSheetProps {
  submission: BudgetQueueRow;
  lines: BudgetLine[];
  isCoo: boolean;
  busy: string | null;
  comment: string;
  setComment: (v: string) => void;
  lineEdits: Record<string, string>;
  setLineEdits: (v: Record<string, string> | ((p: Record<string, string>) => Record<string, string>)) => void;
  onDecideLine: (line: BudgetLine, decision: 'approved' | 'rejected') => Promise<void>;
  onForward: (s: BudgetQueueRow) => Promise<void>;
  onFinalize: (s: BudgetQueueRow, decision: 'approved' | 'rejected') => Promise<void>;
  onSendBack: (s: BudgetQueueRow, decision: 'rejected' | 'revision_requested') => Promise<void>;
  onClose: () => void;
}

function StatusBadge({ status }: { status: string }) {
  const label = STATUS_LABEL[status] ?? status.replace(/_/g, ' ');
  const variant: 'default' | 'secondary' | 'destructive' | 'outline' =
    ['approved', 'released', 'paid'].includes(status)
      ? 'default'
      : ['rejected', 'cancelled'].includes(status)
        ? 'destructive'
        : ['draft', 'superseded'].includes(status)
          ? 'outline'
          : 'secondary';
  return <Badge variant={variant} className="text-[10px] font-normal capitalize">{label}</Badge>;
}

function InfoItem({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</p>
      <div className="mt-0.5 text-sm font-medium text-foreground">{children}</div>
    </div>
  );
}

function ReviewSheet({
  submission: s, lines, isCoo, busy, comment, setComment, lineEdits, setLineEdits,
  onDecideLine, onForward, onFinalize, onSendBack, onClose,
}: ReviewSheetProps) {
  const open = OPEN_STATUSES[isCoo ? 'coo' : 'cfo'].includes(s.status);
  const lineDecision = (l: BudgetLine) => (isCoo ? l.coo_status : l.status);

  return (
    <>
      <SheetHeader>
        <SheetTitle className="pr-6 text-base">Budget Details</SheetTitle>
        <SheetDescription>
          {s.department_name} · {s.reference} · {formatUGX(s.total_amount)}
        </SheetDescription>
      </SheetHeader>

      <div className="mt-2 flex-1 space-y-5 overflow-y-auto pr-1">
        <Card className="rounded-2xl border border-border bg-card shadow-sm">
          <CardContent className="space-y-6 p-4 sm:p-5">
            {/* Header */}
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="text-sm font-semibold text-foreground">{s.department_name}</span>
                  <Badge variant="outline" className="text-[10px]">v{s.version}</Badge>
                </div>
                <p className="mt-1 truncate font-mono text-xs text-muted-foreground">{s.reference}</p>
              </div>
              <div className="text-left sm:text-right">
                <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Amount requested</p>
                <p className="mt-0.5 font-mono text-2xl font-semibold tracking-tight text-foreground">
                  {formatUGX(s.total_amount)}
                </p>
                <div className="mt-1.5">
                  <StatusBadge status={s.status} />
                </div>
              </div>
            </div>

            <div className="h-px bg-border" />

            {/* Key details */}
            <div className="grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-4">
              <InfoItem label="Required period">{s.cycle_title ?? '—'}</InfoItem>
              <InfoItem label="Priority">
                {s.is_late ? (
                  <Badge variant="destructive" className="gap-1 text-[10px]">
                    <AlertTriangle className="h-3 w-3" /> Urgent
                  </Badge>
                ) : (
                  <span className="text-sm text-muted-foreground">Standard</span>
                )}
              </InfoItem>
              <InfoItem label="Submitted">
                {s.submitted_at ? format(new Date(s.submitted_at), 'dd MMM yyyy') : '—'}
              </InfoItem>
              
              <InfoItem label="Line items">{s.line_count}</InfoItem>
              <InfoItem label={isCoo ? 'COO approved' : 'CFO approved'}>
                <span className="font-mono">{formatUGX(isCoo ? s.coo_approved_total : s.cfo_approved_total)}</span>
              </InfoItem>
              <InfoItem label="Undecided lines">{s.pending_lines}</InfoItem>
            </div>

            {/* Purpose */}
            {(s.title || s.purpose) && (
              <div className="rounded-xl bg-muted/40 p-3">
                {s.title && <p className="text-sm font-semibold text-foreground">{s.title}</p>}
                {s.purpose && (
                  <p className={`text-sm leading-relaxed text-muted-foreground ${s.title ? 'mt-1' : ''}`}>
                    {s.purpose}
                  </p>
                )}
              </div>
            )}

            {/* Reviewer comments */}
            {(s.coo_comment || s.cfo_comment) && (
              <div className="space-y-2 rounded-xl bg-muted/40 p-3">
                {s.coo_comment && (
                  <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-2">
                    <span className="shrink-0 text-xs font-semibold text-foreground">COO comment</span>
                    <span className="text-xs text-muted-foreground">{s.coo_comment}</span>
                  </div>
                )}
                {s.cfo_comment && (
                  <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-2">
                    <span className="shrink-0 text-xs font-semibold text-foreground">CFO comment</span>
                    <span className="text-xs text-muted-foreground">{s.cfo_comment}</span>
                  </div>
                )}
              </div>
            )}

            {/* Budget items */}
            <div>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Budget Items
              </h3>
              <div className="space-y-2">
                {lines.length === 0 && (
                  <p className="text-sm text-muted-foreground">Loading line items…</p>
                )}
                {lines.map(l => (
                  <div key={l.id} className="rounded-xl border border-border p-3 text-sm">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-foreground">{l.description}</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          Qty {Number(l.quantity)} × {formatUGX(Number(l.unit_amount))} ={' '}
                          <span className="font-mono font-medium text-foreground">{formatUGX(Number(l.line_total ?? 0))}</span>
                          {l.period_month && ` · ${format(new Date(l.period_month), 'MMM yyyy')}`}
                        </p>
                        {l.justification && (
                          <p className="mt-1 text-xs text-muted-foreground">{l.justification}</p>
                        )}
                        {l.document_path && (
                          <Button size="sm" variant="ghost" className="mt-1 h-7 gap-1 px-2 text-[11px] text-primary"
                            onClick={async () => {
                              try { window.open(await getBudgetDocumentUrl(l.document_path!), '_blank'); }
                              catch { toast.error('Could not open supporting document'); }
                            }}>
                            <FileText className="h-3.5 w-3.5" /> View supporting document
                          </Button>
                        )}
                      </div>
                      <div className="flex flex-wrap items-end gap-2">
                        <div>
                          <Label className="text-[11px]">Approved (UGX)</Label>
                          <Input className="h-8 w-32 text-xs" type="number" min="0" disabled={!open}
                            value={lineEdits[l.id] ?? ''}
                            onChange={e => setLineEdits(p => ({ ...p, [l.id]: e.target.value }))} />
                        </div>
                        <Button size="sm" className="h-8 gap-1 text-xs" disabled={busy === l.id || !open}
                          onClick={() => onDecideLine(l, 'approved')}>
                          <CheckCircle2 className="h-3.5 w-3.5" /> Approve
                        </Button>
                        <Button size="sm" variant="outline" className="h-8 gap-1 text-xs text-destructive"
                          disabled={busy === l.id || !open} onClick={() => onDecideLine(l, 'rejected')}>
                          <XCircle className="h-3.5 w-3.5" /> Reject
                        </Button>
                        <Badge variant="secondary" className="text-[10px]">
                          {lineDecision(l).replace(/_/g, ' ')}
                        </Badge>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Actions */}
            {open && (
              <div className="rounded-xl border border-border p-3 space-y-3">
                <div>
                  <Label className="text-xs">{isCoo ? 'COO comment' : 'CFO comment'}</Label>
                  <Textarea rows={2} value={comment} onChange={e => setComment(e.target.value)}
                    placeholder="Guidance for the department (at least 10 characters to reject or request a revision)" />
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {isCoo ? (
                    <Button size="sm" className="gap-1.5 text-xs" disabled={busy === s.id}
                      onClick={() => onForward(s)}>
                      <ArrowRightCircle className="h-3.5 w-3.5" /> Approve &amp; forward to CFO
                    </Button>
                  ) : (
                    <Button size="sm" className="gap-1.5 text-xs" disabled={busy === s.id}
                      onClick={() => onFinalize(s, 'approved')}>
                      <CheckCircle2 className="h-3.5 w-3.5" /> Approve budget
                    </Button>
                  )}
                  <Button size="sm" variant="outline" className="gap-1.5 text-xs" disabled={busy === s.id}
                    onClick={() => onSendBack(s, 'revision_requested')}>
                    <RotateCcw className="h-3.5 w-3.5" /> Request revision
                  </Button>
                  <Button size="sm" variant="outline" className="gap-1.5 text-xs text-destructive"
                    disabled={busy === s.id} onClick={() => onSendBack(s, 'rejected')}>
                    <XCircle className="h-3.5 w-3.5" /> Reject
                  </Button>
                  {s.pending_lines > 0 && (
                    <span className="text-[11px] text-muted-foreground">
                      {s.pending_lines} line item{s.pending_lines === 1 ? '' : 's'} still undecided
                    </span>
                  )}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="mt-4 flex justify-end border-t border-border pt-4">
        <Button size="sm" variant="outline" onClick={onClose}>Close review</Button>
      </div>
    </>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border p-3">
      <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="mt-0.5 font-mono text-sm font-semibold text-foreground">{value}</p>
    </div>
  );
}
