import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { AutoGrowTextarea } from '@/components/budget/AutoGrowTextarea';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Loader2, Plus, Send, Trash2, Upload, FileText, AlertTriangle, X } from 'lucide-react';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { formatDynamic as formatUGX } from '@/lib/currencyFormat';
import {
  fetchLines, fetchSubmissions, uploadBudgetDocument, getBudgetDocumentUrl,
  registerBudgetDocuments, fetchDepartmentRoute, BUDGET_ROUTE_LABEL,
  useBudgetCycles, useBudgetReferenceData,
  type BudgetSubmission, type BudgetLine,
} from '@/hooks/useDepartmentBudgets';
import { departmentKeysForDashboard } from './departmentScope';
import { useAuth } from '@/hooks/useAuth';
import { useBudgetSubmissionGate } from '@/hooks/useBudgetSubmissionGate';

interface DraftLine {
  description: string;
  quantity: string;
  unit_amount: string;
  justification: string;
  document_path: string;
  /** Original filename, kept for display only; never sent to the server. */
  document_name: string;
}

const emptyLine = (): DraftLine => ({
  description: '', quantity: '1', unit_amount: '',
  justification: '', document_path: '', document_name: '',
});

const EDITABLE_STATUSES = ['draft'];

/** Recovers a readable filename from a stored document path. */
const documentDisplayName = (path: string) => {
  const base = path.split('/').pop() ?? path;
  return base.replace(/^\d+-/, '') || base;
};

/**
 * Mirrors public.is_budget_reviewer(). Reviewers are exempt from the
 * budget_can_file_for_department() guard in budget_save_draft, and
 * can_access_budget_submission() lets them submit, so they may legitimately
 * file for any active department. Used only to decide which departments to
 * offer; the database remains the authority on every write.
 */
const BUDGET_REVIEWER_ROLES = ['cfo', 'ceo', 'super_admin', 'manager', 'financial_ops'];

/**
 * Server refusals from PostgREST/RPC are plain objects, not Error instances, so
 * `e instanceof Error` was false for every database rejection and the real
 * reason ("You can only budget for a department you are registered in",
 * "Budget cycle is not open", ...) was replaced by a bare "Could not submit".
 * Read the reason off whatever shape arrives instead.
 */
/**
 * True when the refusal is about the record the form is holding rather than the
 * budget itself: the submission has already left draft, or no longer exists.
 * Those are recoverable by filing what is on screen as a fresh submission.
 */
function isStaleRecord(e: unknown): boolean {
  const msg = serverMessage(e, '').toLowerCase();
  return msg.includes('read-only in status')
    || msg.includes('only draft budgets can be submitted')
    || msg.includes('submission not found');
}

function serverMessage(e: unknown, fallback: string): string {
  if (typeof e === 'string' && e.trim()) return e.trim();
  const raw = e as { message?: unknown; details?: unknown; hint?: unknown } | null;
  const msg = [raw?.message, raw?.details, raw?.hint].find(
    v => typeof v === 'string' && v.trim().length > 0,
  ) as string | undefined;
  return msg?.trim() || fallback;
}

interface Props {
  /** Dashboard the page was opened from (e.g. 'tenant-ops'); locks the form to that hub's department. */
  dashboard?: string;
  /** Explicit hr_departments.key allowlist; overrides `dashboard`. */
  departmentKeys?: string[];
  /** Budget cycle to open on mount (used by the budget submission gate). */
  initialCycleId?: string;
  /** Department to open on mount (used by the budget submission gate). */
  initialDepartmentId?: string;
  /** Existing draft to resume, so the gate never starts a second submission. */
  initialSubmissionId?: string;
}

/** Department-facing budget preparation and submission interface. */
export default function DepartmentBudgetSubmission({
  dashboard,
  departmentKeys,
  initialCycleId,
  initialDepartmentId,
  initialSubmissionId,
}: Props = {}) {
  const { cycles, loading: cyclesLoading } = useBudgetCycles();
  const {
    departments,
    myDepartments: allMyDepartments,
    loading: refLoading,
  } = useBudgetReferenceData();


  /**
   * Submissions are department-specific: when the page is opened from a
   * department hub we only expose that hub's department, so a Tenant Ops user
   * can never file or read a budget under Agent Ops (and vice versa).
   */
  const allowedKeys = useMemo(
    () => departmentKeys ?? departmentKeysForDashboard(dashboard),
    [departmentKeys, dashboard],
  );
  const myDepartments = useMemo(
    () => (allowedKeys ? allMyDepartments.filter(d => allowedKeys.includes(d.key)) : allMyDepartments),
    [allMyDepartments, allowedKeys],
  );

  /**
   * A reviewer opening the page unscoped may file for any active department,
   * so offer the full list rather than only their own HR postings. An explicit
   * hub scope (?dashboard=tenant-ops) still wins: that lock is deliberate, and
   * widening it here would let a hub page file outside its own hub.
   */
  const { roles } = useAuth();
  const { refresh: refreshBudgetObligation } = useBudgetSubmissionGate();
  const isReviewer = useMemo(
    () => (roles ?? []).some(r => BUDGET_REVIEWER_ROLES.includes(r as string)),
    [roles],
  );
  const filingOnBehalf = isReviewer && !allowedKeys;
  const selectableDepartments = filingOnBehalf ? departments : myDepartments;
  const myDepartmentIds = useMemo(
    () => new Set(myDepartments.map(d => d.id)),
    [myDepartments],
  );

  /**
   * Departments the signed-in user is the designated head of. A head is the
   * person actually asked for the budget, so when their HR postings resolve to
   * several departments this is the one the budget belongs under — without it
   * the form silently picked whichever department came first, which is how a
   * head could end up filing under (or being locked out by) another
   * department's budget.
   */
  const [headDepartmentIds, setHeadDepartmentIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: auth } = await supabase.auth.getUser();
      const uid = auth.user?.id;
      if (!uid) return;
      const { data } = await supabase
        .from('budget_department_heads')
        .select('department_id')
        .eq('user_id', uid)
        .eq('active', true);
      if (!cancelled) setHeadDepartmentIds(new Set((data ?? []).map(r => r.department_id as string)));
    })();
    return () => { cancelled = true; };
  }, []);

  const [cycleId, setCycleId] = useState<string>(initialCycleId ?? '');
  const [departmentId, setDepartmentId] = useState<string>(initialDepartmentId ?? '');
  // Set once the requested draft has been opened, so a user edit is never
  // overwritten by re-opening it.
  const [resumedDraftId, setResumedDraftId] = useState<string | null>(null);
  const [submissions, setSubmissions] = useState<BudgetSubmission[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [purpose, setPurpose] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([emptyLine()]);
  const [submitting, setSubmitting] = useState(false);
  const [uploadingIdx, setUploadingIdx] = useState<number | null>(null);
  const [route, setRoute] = useState<'direct' | 'coo' | null>(null);

  const openCycles = useMemo(() => cycles.filter(c => c.status === 'open'), [cycles]);
  const cycle = useMemo(() => cycles.find(c => c.id === cycleId), [cycles, cycleId]);
  const active = useMemo(() => submissions.find(s => s.id === activeId) ?? null, [submissions, activeId]);
  const selectedDepartment = useMemo(
    () => selectableDepartments.find(d => d.id === departmentId) ?? null,
    [selectableDepartments, departmentId],
  );
  /**
   * A submission that has left 'draft' and not been rejected is still in the
   * approval pipeline. While one exists for this cycle/department the form is
   * locked, so the same budget can never be submitted twice — the user works
   * on the existing record (or a revision) instead of filing a duplicate.
   */
  const pendingSubmission = useMemo(
    () => submissions.find(s => s.status !== 'draft' && s.status !== 'rejected') ?? null,
    [submissions],
  );
  const readOnly = active
    ? !EDITABLE_STATUSES.includes(active.status)
    : !!pendingSubmission;


  useEffect(() => {
    if (!cycleId && openCycles.length) setCycleId(openCycles[0].id);
  }, [openCycles, cycleId]);
  useEffect(() => {
    // The department is no longer a choice on the form: a budget is always
    // filed under the preparer's own posting. The value is resolved here so
    // nothing has to be picked, and it is re-resolved whenever the postings
    // load or change.
    if (refLoading) return;
    // Arrived from the budget submission gate with an explicit department: that
    // is the department that is actually owed, so keep it.
    if (initialDepartmentId && departmentId === initialDepartmentId) return;
    if (!selectableDepartments.length) { if (departmentId) setDepartmentId(''); return; }
    if (selectableDepartments.some(d => d.id === departmentId)) return;
    // Department the user actually heads first — that is the budget they are
    // being asked for. Then their own posting (a reviewer who also carries a
    // posting files under it rather than under an unrelated department).
    const headed = selectableDepartments.find(d => headDepartmentIds.has(d.id));
    const own = selectableDepartments.find(d => myDepartmentIds.has(d.id));
    setDepartmentId((headed ?? own ?? selectableDepartments[0]).id);
  }, [departmentId, refLoading, selectableDepartments, myDepartmentIds, headDepartmentIds, initialDepartmentId]);


  useEffect(() => {
    if (!departmentId) { setRoute(null); return; }
    let cancelled = false;
    fetchDepartmentRoute(departmentId)
      .then(r => { if (!cancelled) setRoute(r); })
      .catch(() => { if (!cancelled) setRoute(null); });
    return () => { cancelled = true; };
  }, [departmentId]);

  const loadSubmissions = useCallback(async () => {
    if (!cycleId || !departmentId) { setSubmissions([]); return; }
    try {
      const rows = await fetchSubmissions(cycleId, departmentId || null);
      setSubmissions(rows);
    } catch {
      toast.error('Could not load your budgets');
    }
  }, [cycleId, departmentId]);

  useEffect(() => { loadSubmissions(); }, [loadSubmissions]);

  // A new cycle (or department) always starts from a completely blank form —
  // never carry forward values from a previously opened submission.
  useEffect(() => {
    setActiveId(null);
    setTitle('');
    setPurpose('');
    setLines([emptyLine()]);
  }, [cycleId, departmentId]);

  const openSubmission = async (s: BudgetSubmission) => {
    setActiveId(s.id);
    setTitle(s.title ?? '');
    setPurpose(s.purpose ?? '');
    const rows: BudgetLine[] = await fetchLines(s.id);
    setLines(rows.length ? rows.map(r => ({
      description: r.description,
      quantity: String(r.quantity ?? 1),
      unit_amount: String(r.unit_amount ?? 0),
      justification: r.justification ?? '',
      document_path: r.document_path ?? '',
      document_name: r.document_path ? documentDisplayName(r.document_path) : '',
    })) : [emptyLine()]);
  };

  // Arrived from the budget submission gate pointing at an existing draft:
  // resume that draft instead of starting a second submission.
  useEffect(() => {
    if (!initialSubmissionId || resumedDraftId === initialSubmissionId) return;
    const target = submissions.find(s => s.id === initialSubmissionId);
    if (!target) return;
    setResumedDraftId(initialSubmissionId);
    void openSubmission(target);
    // openSubmission is stable enough for this one-shot resume.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialSubmissionId, resumedDraftId, submissions]);


  const total = lines.reduce(
    (sum, l) => sum + (Number(l.quantity) || 0) * (Number(l.unit_amount) || 0), 0,
  );

  const updateLine = (idx: number, patch: Partial<DraftLine>) =>
    setLines(prev => prev.map((l, i) => (i === idx ? { ...l, ...patch } : l)));

  const handleUpload = async (idx: number, file: File) => {
    setUploadingIdx(idx);
    try {
      const path = await uploadBudgetDocument(file, activeId);
      updateLine(idx, { document_path: path, document_name: file.name });
      toast.success('Supporting document attached');
    } catch {
      toast.error('Upload failed');
    } finally {
      setUploadingIdx(null);
    }
  };

  /**
   * Writes the current form state and returns the submission id, or null when
   * the form is not yet valid (the reason is surfaced as a toast). Shared by
   * Save draft and Submit so what is on screen is always what gets persisted.
   */
  const persistDraft = async (submissionId: string | null = activeId): Promise<string | null> => {
    if (!cycleId || !departmentId) { toast.error('Pick a budget cycle and department'); return null; }
    const payload = lines
      .filter(l => l.description.trim())
      .map(l => ({
        description: l.description.trim(),
        account_code: null,
        quantity: Number(l.quantity) || 1,
        unit_amount: Number(l.unit_amount) || 0,
        period_month: null,
        justification: l.justification || null,
        document_path: l.document_path || null,
      }));
    if (!payload.length) { toast.error('Add at least one line with a description'); return null; }
    const { data, error } = await supabase.rpc('budget_save_draft', {
      p_submission_id: submissionId,
      p_call_id: cycleId,
      p_department_id: departmentId,
      p_title: title || null,
      p_purpose: purpose || null,
      p_lines: payload,
    });
    if (error) throw error;
    const newId = data as unknown as string;
    setActiveId(newId);
    await registerBudgetDocuments(newId, payload.map(l => l.document_path).filter(Boolean) as string[]);
    return newId;
  };

  /**
   * Plain-language reason the budget cannot be submitted yet, or null when the
   * form is complete. Mirrors what persistDraft and budget_submit_submission
   * require, so the button only enables when the submission will actually go
   * through — the database stays the authority on every write.
   */
  const incompleteReason = useMemo((): string | null => {
    if (!cycleId) return 'There is no open budget cycle to submit into yet.';
    if (!departmentId) return 'Your department could not be resolved, so this budget cannot be filed.';
    if (!title.trim()) return 'Add a title for this budget.';
    if (!purpose.trim()) return 'Add the purpose of this budget.';
    const filled = lines.filter(l =>
      l.description.trim() || l.unit_amount.trim() || l.justification.trim(),
    );
    if (!filled.length) return 'Add at least one item with a description, quantity and unit cost.';
    const incomplete = filled.some(l =>
      !l.description.trim()
      || !(Number(l.quantity) > 0)
      || !(Number(l.unit_amount) > 0)
      || !l.justification.trim(),
    );
    if (incomplete) return 'Every item needs a description, quantity, unit cost and justification.';
    return null;
  }, [cycleId, departmentId, title, purpose, lines]);


  /**
   * Submit straight from a filled-in form. The draft is written first because
   * budget_submit_submission works off persisted lines, but that is now an
   * implementation detail rather than a step the user has to remember: filling
   * the form and pressing Submit is enough, and any unsaved edits to an
   * existing draft are captured in the same action.
   */
  const submit = async () => {
    // The button stays pressable so it never reads as frozen: if something is
    // still missing the user is told exactly what, rather than being left with
    // a dead control.
    if (incompleteReason) { toast.error(incompleteReason); return; }
    setSubmitting(true);
    try {
      // One attempt against the record the form is holding. Returns the outcome
      // instead of throwing so a stale record can be retried cleanly.
      const attempt = async (submissionId: string | null) => {
        const id = await persistDraft(submissionId);
        if (!id) return { ok: false as const, error: null as unknown };
        const { data, error } = await supabase.rpc('budget_submit_submission', { p_submission_id: id });
        if (error) return { ok: false as const, error };
        return { ok: true as const, data: data as unknown as { is_late?: boolean } };
      };

      let res = await attempt(activeId);

      // The form was still holding a record the database will no longer accept
      // (it was already submitted, or was replaced by a new version elsewhere).
      // That is a stale screen, not a rejected budget, so file what is on screen
      // as a fresh submission instead of dead-ending the user.
      if (!res.ok && activeId && isStaleRecord(res.error)) {
        console.warn('[budget] stale draft, filing a fresh submission', res.error);
        setActiveId(null);
        res = await attempt(null);
      }

      if (!res.ok) {
        if (res.error) throw res.error;
        return;
      }

      toast.success(res.data?.is_late ? 'Submitted — flagged as late' : 'Budget submitted for CFO review');
      await loadSubmissions();
      // Re-derive the obligation from the database so the required-action gate
      // and the notification bell release without a reload.
      refreshBudgetObligation();
    } catch (e) {
      // Keep the full server reply for tracing, and show the user the actual
      // reason rather than a dead-end message they cannot act on.
      console.error('[budget] submit failed', e);
      toast.error(
        serverMessage(e, 'The server refused this budget without giving a reason. Please report this.'),
      );
    } finally {
      setSubmitting(false);
    }
  };

  if (cyclesLoading || refLoading) {
    return <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading budget cycles…</div>;
  }

  if (!selectableDepartments.length) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground">
          {filingOnBehalf
            ? 'No active departments are registered, so there is nothing to budget for yet. Ask HR to add the company departments.'
            : allowedKeys
              ? 'You do not have an active department assignment for this hub, so there is no budget to prepare here. Ask HR to post you to this department.'
              : 'No active department is linked to your account, so a budget cannot be prepared. Ask HR to add your active department assignment — budgets are always filed under your own department.'}
        </CardContent>
      </Card>
    );
  }


  return (
    <div className="space-y-5">
      {/* Where a budget is filed is not the preparer's decision: the cycle and
          department are fixed by the open call and the preparer's own posting,
          so this is a plain statement of record, not a set of choices. */}
      <section className="border-b border-border/70 pb-5" aria-labelledby="budget-filing-title">
        <h2 id="budget-filing-title" className="sr-only">Filing details</h2>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
          {selectableDepartments.length > 1 ? (
            // Some preparers are linked to more than one department. Showing the
            // choice is what lets each department head file under their own
            // department instead of whichever one resolved first.
            <select
              aria-label="Department this budget is filed under"
              className="rounded-lg border border-border bg-card px-2 py-1 text-sm font-semibold text-foreground"
              value={departmentId}
              onChange={e => setDepartmentId(e.target.value)}
            >
              {selectableDepartments.map(d => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
          ) : (
            <span className="text-sm font-semibold text-foreground">{selectedDepartment?.name ?? '—'}</span>
          )}
          {cycle && (
            <span>
              {cycle.title}{cycle.financial_year ? ` · ${cycle.financial_year}` : ''}
            </span>
          )}
          {route && <Badge variant="outline" className="font-normal">{BUDGET_ROUTE_LABEL[route]}</Badge>}
        </div>
        {cycle?.instructions && (
          <p className="mt-3 rounded-lg border border-border/60 bg-muted/40 p-3 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">CFO instructions: </span>{cycle.instructions}
          </p>
        )}
        {cycle?.deadline && (
          <p className="mt-2 text-xs text-muted-foreground">
            Deadline: {format(new Date(cycle.deadline), 'dd MMM yyyy, HH:mm')} — late submissions are accepted but flagged.
          </p>
        )}
      </section>

      <section aria-labelledby="budget-submissions-title">
        <div className="mb-3 flex items-end justify-between gap-3">
          <div>
            <h2 id="budget-submissions-title" className="text-sm font-semibold">My submissions</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">Open a saved draft or review its current status.</p>
          </div>
          <span className="text-xs tabular-nums text-muted-foreground">{submissions.length} total</span>
        </div>
        <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          {submissions.length === 0 && <p className="text-xs text-muted-foreground">No budgets yet for this cycle.</p>}
          {submissions.map(s => (
            <Button
              key={s.id}
              type="button"
              variant="outline"
              onClick={() => openSubmission(s)}
              className={`h-auto min-h-[72px] w-full items-start justify-start whitespace-normal rounded-lg p-3 text-left text-xs shadow-none ${activeId === s.id ? 'border-primary bg-primary/5' : 'bg-card'}`}
            >
              <div className="w-full">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono font-medium">{s.reference}</span>
                  <Badge variant="outline" className="text-[10px]">v{s.version}</Badge>
                  <Badge variant="secondary" className="text-[10px]">
                    {s.status === 'pending_coo'
                      ? 'Pending COO approval'
                      : s.status === 'coo_under_review'
                        ? 'COO reviewing'
                        : s.status.replace(/_/g, ' ')}
                  </Badge>
                  {s.is_late && <Badge variant="destructive" className="gap-1 text-[10px]"><AlertTriangle className="h-3 w-3" /> late</Badge>}
                </div>
                <p className="mt-2 font-normal text-muted-foreground">
                  Requested {formatUGX(Number(s.total_amount))}
                  {Number(s.approved_total) > 0 && ` · Approved ${formatUGX(Number(s.approved_total))}`}
                </p>
                {s.cfo_comment && <p className="mt-1 font-normal text-warning">CFO: {s.cfo_comment}</p>}
              </div>
            </Button>
          ))}
        </div>
      </section>

      <Card className="overflow-hidden rounded-lg border-border shadow-soft">
        <CardContent className="space-y-5 p-4 sm:p-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label className="mb-1.5 block text-xs font-semibold">Title</Label>
              <AutoGrowTextarea className="min-h-12 bg-card" value={title} onChange={e => setTitle(e.target.value)} disabled={readOnly} placeholder="e.g. Marketing — August" />
            </div>
            <div>
              <Label className="mb-1.5 block text-xs font-semibold">Purpose</Label>
              <AutoGrowTextarea className="min-h-12 bg-card" value={purpose} onChange={e => setPurpose(e.target.value)} disabled={readOnly} placeholder="What this budget covers" />
            </div>
          </div>

          <div className="overflow-hidden rounded-lg border border-border">
            <div className="hidden grid-cols-[44px_minmax(200px,1.4fr)_80px_130px_minmax(160px,1.2fr)_120px_120px] bg-muted/70 text-[11px] font-semibold text-muted-foreground xl:grid">
              <div className="border-r border-border px-3 py-3 text-center">#</div>
              <div className="border-r border-border px-3 py-3">Item / Description</div>
              <div className="border-r border-border px-3 py-3">Quantity</div>
              <div className="border-r border-border px-3 py-3">Unit Cost (UGX)</div>
              <div className="border-r border-border px-3 py-3">Justification</div>
              <div className="border-r border-border px-3 py-3">Total (UGX)</div>
              <div className="px-3 py-3 text-center">Actions</div>
            </div>
            {lines.map((l, idx) => (
              <div key={idx} className="grid gap-3 border-t border-border bg-card p-3 first:border-t-0 sm:grid-cols-2 xl:grid-cols-[44px_minmax(200px,1.4fr)_80px_130px_minmax(160px,1.2fr)_120px_120px] xl:gap-0 xl:p-0">
                  <div className="flex items-center justify-between sm:col-span-2 xl:col-span-1 xl:justify-center xl:border-r xl:border-border xl:px-3 xl:py-4">
                    <span className="text-xs font-semibold text-muted-foreground"><span className="xl:hidden">Item </span>{idx + 1}</span>
                    {!readOnly && lines.length > 1 && (
                      <Button type="button" size="icon-sm" variant="ghost" className="text-destructive xl:hidden" aria-label={`Delete item ${idx + 1}`} title="Delete item"
                        onClick={() => setLines(prev => prev.filter((_, i) => i !== idx))}>
                        <Trash2 />
                      </Button>
                    )}
                  </div>
                  <div className="xl:border-r xl:border-border xl:p-2">
                    <Label className="mb-1 block text-[11px] xl:hidden">Description</Label>
                    <AutoGrowTextarea className="min-h-11" value={l.description} disabled={readOnly} placeholder="Enter item description"
                      onChange={e => updateLine(idx, { description: e.target.value })} />
                  </div>
                  <div className="xl:border-r xl:border-border xl:p-2">
                      <Label className="mb-1 block text-[11px] xl:hidden">Quantity</Label>
                      <Input className="h-11 rounded-lg px-3 text-sm xl:mb-0" type="number" min="0" value={l.quantity} disabled={readOnly}
                        onChange={e => updateLine(idx, { quantity: e.target.value })} />
                  </div>
                  <div className="xl:border-r xl:border-border xl:p-2">
                      <Label className="mb-1 block text-[11px] xl:hidden">Unit cost (UGX)</Label>
                      <Input className="h-11 rounded-lg px-3 text-sm xl:mb-0" type="number" min="0" value={l.unit_amount} disabled={readOnly}
                        onChange={e => updateLine(idx, { unit_amount: e.target.value })} />
                  </div>
                  <div className="xl:border-r xl:border-border xl:p-2">
                    <Label className="mb-1 block text-[11px] xl:hidden">Justification</Label>
                    <AutoGrowTextarea className="min-h-11" value={l.justification} disabled={readOnly} placeholder="Add justification"
                      onChange={e => updateLine(idx, { justification: e.target.value })} />
                  </div>
                  <div className="flex min-h-11 items-center rounded-lg bg-muted px-3 text-xs font-medium tabular-nums text-muted-foreground xl:m-2">
                    <span className="mr-1 xl:hidden">Total </span>{formatUGX((Number(l.quantity) || 0) * (Number(l.unit_amount) || 0))}
                  </div>
                  <div className="flex flex-row flex-nowrap items-center gap-2 sm:justify-end xl:justify-center xl:px-2 xl:py-3">
                    {!readOnly && (
                      <label className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-lg border border-border bg-card px-2 text-[11px] font-medium transition-colors hover:bg-muted" title={l.document_path ? 'Replace attachment' : 'Attach document'}>
                        {uploadingIdx === idx ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                        <span className="xl:sr-only">{l.document_path ? 'Replace' : 'Attach'}</span>
                        <input type="file" className="hidden"
                          onChange={e => {
                            const f = e.target.files?.[0];
                            if (f) handleUpload(idx, f);
                            e.target.value = '';
                          }} />
                      </label>
                    )}
                    {!readOnly && lines.length > 1 && (
                      <Button type="button" size="icon-sm" variant="ghost" className="hidden text-destructive xl:inline-flex" aria-label={`Delete item ${idx + 1}`} title="Delete item"
                        onClick={() => setLines(prev => prev.filter((_, i) => i !== idx))}>
                        <Trash2 />
                      </Button>
                    )}
                  </div>
                  {l.document_path && (
                    <span className="inline-flex min-w-0 items-center gap-1 rounded-lg border border-border bg-muted/40 py-1 pl-2 pr-1 text-[11px] sm:col-span-2 xl:col-span-7 xl:mx-2 xl:mb-2">
                      <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <button
                        type="button"
                        className="truncate underline-offset-2 hover:underline"
                        title={`Open ${l.document_name || documentDisplayName(l.document_path)}`}
                        onClick={async () => {
                          try { window.open(await getBudgetDocumentUrl(l.document_path), '_blank'); }
                          catch { toast.error('Could not open document'); }
                        }}
                      >
                        {l.document_name || documentDisplayName(l.document_path)}
                      </button>
                      {!readOnly && (
                        <Button
                          type="button"
                          size="icon-sm"
                          variant="ghost"
                          aria-label={`Remove ${l.document_name || documentDisplayName(l.document_path)}`}
                          title="Remove attachment"
                          className="ml-auto h-7 min-h-7 w-7 min-w-7 text-muted-foreground hover:text-destructive"
                          onClick={() => {
                            updateLine(idx, { document_path: '', document_name: '' });
                            toast.success('Attachment removed');
                          }}
                        >
                          <X className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </span>
                  )}
              </div>
            ))}
          </div>

          {!readOnly && (
            <Button size="sm" variant="default" className="gap-1.5 rounded-lg text-xs"
              onClick={() => setLines(prev => [...prev, emptyLine()])}>
              <Plus className="h-3.5 w-3.5" /> Add item
            </Button>
          )}

          <div className="flex items-center justify-end gap-10 rounded-lg bg-muted px-4 py-4 text-sm sm:px-6">
            <span className="font-semibold text-muted-foreground">Requested total</span>
            <span className="font-mono text-base font-bold tabular-nums text-foreground">{formatUGX(total)}</span>
          </div>

          {!readOnly && (
            <div className="flex flex-col gap-2 border-t border-border pt-5">
              <Button
                size="sm"
                onClick={submit}
                disabled={submitting}
                className="w-full rounded-lg text-xs sm:w-auto sm:self-end"
              >
                {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Submit for review
              </Button>
              {incompleteReason && (
                <p className="text-xs text-muted-foreground sm:text-right">{incompleteReason}</p>
              )}
            </div>
          )}
          {readOnly && (
            <p className="text-xs text-muted-foreground">
              {pendingSubmission && activeId !== pendingSubmission.id
                ? `Budget ${pendingSubmission.reference} is already submitted and awaiting review, so this form is locked. Open it from "My submissions" to view it — if a revision is requested, a new version is created for you to edit.`
                : 'This submission is locked. If the CFO requests a revision, a new version is created for you to edit.'}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}