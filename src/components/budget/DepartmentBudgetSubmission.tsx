import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Loader2, Plus, Save, Send, Trash2, Upload, FileText, AlertTriangle, X } from 'lucide-react';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { formatDynamic as formatUGX } from '@/lib/currencyFormat';
import {
  fetchLines, fetchSubmissions, uploadBudgetDocument, getBudgetDocumentUrl,
  registerBudgetDocuments, isBudgetableAccount, fetchDepartmentRoute, BUDGET_ROUTE_LABEL,
  useBudgetCycles, useBudgetReferenceData,
  type BudgetSubmission, type BudgetLine,
} from '@/hooks/useDepartmentBudgets';
import { departmentKeysForDashboard } from './departmentScope';
import { useAuth } from '@/hooks/useAuth';

interface DraftLine {
  description: string;
  account_code: string;
  quantity: string;
  unit_amount: string;
  period_month: string;
  justification: string;
  document_path: string;
  /** Original filename, kept for display only; never sent to the server. */
  document_name: string;
}

const emptyLine = (): DraftLine => ({
  description: '', account_code: '', quantity: '1', unit_amount: '',
  period_month: '', justification: '', document_path: '', document_name: '',
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

interface Props {
  /** Dashboard the page was opened from (e.g. 'tenant-ops'); locks the form to that hub's department. */
  dashboard?: string;
  /** Explicit hr_departments.key allowlist; overrides `dashboard`. */
  departmentKeys?: string[];
}

/** Department-facing budget preparation and submission interface. */
export default function DepartmentBudgetSubmission({ dashboard, departmentKeys }: Props = {}) {
  const { cycles, loading: cyclesLoading } = useBudgetCycles();
  const {
    accounts,
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

  const [cycleId, setCycleId] = useState<string>('');
  const [departmentId, setDepartmentId] = useState<string>('');
  const [submissions, setSubmissions] = useState<BudgetSubmission[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [purpose, setPurpose] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([emptyLine()]);
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [uploadingIdx, setUploadingIdx] = useState<number | null>(null);
  const [route, setRoute] = useState<'direct' | 'coo' | null>(null);

  const openCycles = useMemo(() => cycles.filter(c => c.status === 'open'), [cycles]);
  const budgetableAccounts = useMemo(() => accounts.filter(isBudgetableAccount), [accounts]);
  const cycle = useMemo(() => cycles.find(c => c.id === cycleId), [cycles, cycleId]);
  const active = useMemo(() => submissions.find(s => s.id === activeId) ?? null, [submissions, activeId]);
  const selectedDepartment = useMemo(
    () => selectableDepartments.find(d => d.id === departmentId) ?? null,
    [selectableDepartments, departmentId],
  );
  const readOnly = active ? !EDITABLE_STATUSES.includes(active.status) : false;


  useEffect(() => {
    if (!cycleId && openCycles.length) setCycleId(openCycles[0].id);
  }, [openCycles, cycleId]);
  useEffect(() => {
    // Never guess: the field prepopulates with the user's own (home) department
    // only. When the home department cannot be resolved and more than one
    // posting exists, the field stays empty so an alphabetically-first
    // department is never silently pre-selected on the user's behalf.
    if (refLoading) return;
    // Filing on behalf of departments: never preselect. A reviewer's own HR
    // posting is not the department they are usually budgeting for, and a
    // prefilled field invites submitting under the wrong one.
    if (filingOnBehalf) {
      if (departmentId && !selectableDepartments.some(d => d.id === departmentId)) setDepartmentId('');
      return;
    }
    if (!myDepartments.length) { if (departmentId) setDepartmentId(''); return; }
    if (myDepartments.some(d => d.id === departmentId)) return;
    // More than one posting: start on the "Select department" placeholder
    // rather than defaulting to the home department. A prefilled department
    // is easy to miss, and filing under the wrong one is the mistake this
    // field exists to prevent. Only a single posting fills itself in, and
    // that case renders as a fixed field with nothing to choose.
    setDepartmentId(myDepartments.length === 1 ? myDepartments[0].id : '');
  }, [myDepartments, departmentId, refLoading, filingOnBehalf, selectableDepartments]);


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
      account_code: r.account_code ?? '',
      quantity: String(r.quantity ?? 1),
      unit_amount: String(r.unit_amount ?? 0),
      period_month: r.period_month ?? '',
      justification: r.justification ?? '',
      document_path: r.document_path ?? '',
      document_name: r.document_path ? documentDisplayName(r.document_path) : '',
    })) : [emptyLine()]);
  };

  const startNew = () => {
    setActiveId(null);
    setTitle('');
    setPurpose('');
    setLines([emptyLine()]);
  };

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
  const persistDraft = async (): Promise<string | null> => {
    if (!cycleId || !departmentId) { toast.error('Pick a budget cycle and department'); return null; }
    const payload = lines
      .filter(l => l.description.trim() && l.account_code)
      .map(l => ({
        description: l.description.trim(),
        account_code: l.account_code,
        quantity: Number(l.quantity) || 1,
        unit_amount: Number(l.unit_amount) || 0,
        period_month: l.period_month || null,
        justification: l.justification || null,
        document_path: l.document_path || null,
      }));
    if (!payload.length) { toast.error('Add at least one line with a description and a budget category'); return null; }
    const { data, error } = await supabase.rpc('budget_save_draft', {
      p_submission_id: activeId,
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

  const saveDraft = async () => {
    setSaving(true);
    try {
      const id = await persistDraft();
      if (!id) return;
      toast.success('Draft saved');
      await loadSubmissions();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save draft');
    } finally {
      setSaving(false);
    }
  };

  /**
   * Submit straight from a filled-in form. The draft is written first because
   * budget_submit_submission works off persisted lines, but that is now an
   * implementation detail rather than a step the user has to remember: filling
   * the form and pressing Submit is enough, and any unsaved edits to an
   * existing draft are captured in the same action.
   */
  const submit = async () => {
    setSubmitting(true);
    try {
      const id = await persistDraft();
      if (!id) return;
      const { data, error } = await supabase.rpc('budget_submit_submission', { p_submission_id: id });
      if (error) throw error;
      const res = data as unknown as { is_late?: boolean };
      toast.success(res?.is_late ? 'Submitted — flagged as late' : 'Budget submitted for CFO review');
      await loadSubmissions();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not submit');
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
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Department budget</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label className="text-xs">Budget cycle</Label>
              <Select value={cycleId} onValueChange={setCycleId}>
                <SelectTrigger><SelectValue placeholder="Select cycle" /></SelectTrigger>
                <SelectContent className="z-[100]">
                  {cycles.map(c => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.title}{c.financial_year ? ` · ${c.financial_year}` : ''}{c.status !== 'open' ? ' (closed)' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Department</Label>
              {selectableDepartments.length > 1 ? (
                <Select value={departmentId} onValueChange={setDepartmentId}>
                  <SelectTrigger><SelectValue placeholder="Select department" /></SelectTrigger>
                  <SelectContent className="z-[100]">
                    {filingOnBehalf ? (
                      /* Own postings first so a reviewer filing for their own
                         department does not hunt through the full list. */
                      <>
                        {selectableDepartments.filter(d => myDepartmentIds.has(d.id)).map(d => (
                          <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
                        ))}
                        {selectableDepartments.some(d => myDepartmentIds.has(d.id)) && (
                          <div className="my-1 border-t border-border" role="separator" />
                        )}
                        {selectableDepartments.filter(d => !myDepartmentIds.has(d.id)).map(d => (
                          <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
                        ))}
                      </>
                    ) : (
                      selectableDepartments.map(d => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)
                    )}
                  </SelectContent>
                </Select>
              ) : (
                /* Single posting and not a reviewer: the department is fixed to
                   the user's own so a budget can never be filed under another. */
                <div
                  className="flex h-10 items-center rounded-md border border-input bg-muted/50 px-3 text-sm"
                  aria-readonly="true"
                >
                  {selectedDepartment?.name ?? '—'}
                </div>
              )}
              {selectableDepartments.length > 1 && !departmentId && (
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Pick the department this budget belongs to.
                </p>
              )}
              {filingOnBehalf && selectedDepartment && !myDepartmentIds.has(selectedDepartment.id) && (
                <p className="mt-1 text-[11px] text-amber-600">
                  Filing on behalf of {selectedDepartment.name} — you are not posted to this department.
                </p>
              )}
              {route && (
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Approval route: {BUDGET_ROUTE_LABEL[route]}
                </p>
              )}

            </div>

          </div>
          {cycle?.instructions && (
            <p className="rounded-md border border-border/60 bg-muted/40 p-3 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">CFO instructions: </span>{cycle.instructions}
            </p>
          )}
          {cycle?.deadline && (
            <p className="text-xs text-muted-foreground">
              Deadline: {format(new Date(cycle.deadline), 'dd MMM yyyy, HH:mm')} — late submissions are accepted but flagged.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">My submissions</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {submissions.length === 0 && <p className="text-xs text-muted-foreground">No budgets yet for this cycle.</p>}
          {submissions.map(s => (
            <button
              key={s.id}
              onClick={() => openSubmission(s)}
              className={`w-full rounded-lg border p-3 text-left text-xs transition-colors ${activeId === s.id ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50'}`}
            >
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
              <p className="mt-1 text-muted-foreground">
                Requested {formatUGX(Number(s.total_amount))}
                {Number(s.approved_total) > 0 && ` · Approved ${formatUGX(Number(s.approved_total))}`}
              </p>
              {s.cfo_comment && <p className="mt-1 text-[11px] text-amber-600">CFO: {s.cfo_comment}</p>}
            </button>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            {activeId ? (readOnly ? 'Submission (read-only)' : 'Edit draft') : 'New budget draft'}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label className="text-xs">Title</Label>
              <Input value={title} onChange={e => setTitle(e.target.value)} disabled={readOnly} placeholder="e.g. Marketing — August" />
            </div>
            <div>
              <Label className="text-xs">Purpose</Label>
              <Input value={purpose} onChange={e => setPurpose(e.target.value)} disabled={readOnly} placeholder="What this budget covers" />
            </div>
          </div>

          <div className="space-y-3">
            {lines.map((l, idx) => (
              <div key={idx} className="space-y-2 rounded-lg border border-border p-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium">Line {idx + 1}</span>
                  {!readOnly && lines.length > 1 && (
                    <Button size="sm" variant="ghost" className="h-7 px-2 text-destructive"
                      onClick={() => setLines(prev => prev.filter((_, i) => i !== idx))}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <div>
                    <Label className="text-[11px]">Description</Label>
                    <Input value={l.description} disabled={readOnly}
                      onChange={e => updateLine(idx, { description: e.target.value })} />
                  </div>
                  <div>
                    <Label className="text-[11px]">Budget category (Chart of Accounts)</Label>
                    <Select value={l.account_code} onValueChange={v => updateLine(idx, { account_code: v })} disabled={readOnly}>
                      <SelectTrigger><SelectValue placeholder="Select category" /></SelectTrigger>
                      <SelectContent className="z-[100]">
                        {budgetableAccounts.map(a => (
                          <SelectItem key={a.code} value={a.code}>{a.code} — {a.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {/* An empty catalogue is a permissions problem, not an
                        empty list. Say so rather than rendering a dropdown
                        with nothing in it and no way to tell why. */}
                    {!budgetableAccounts.length && !refLoading && (
                      <p className="mt-1 text-[11px] text-destructive">
                        No spending categories are available to your account, so this budget cannot be
                        filed. Ask Finance to grant access to the chart of accounts.
                      </p>
                    )}
                  </div>
                  <div className="grid grid-cols-3 gap-2 sm:col-span-2">
                    <div>
                      <Label className="text-[11px]">Quantity</Label>
                      <Input type="number" min="0" value={l.quantity} disabled={readOnly}
                        onChange={e => updateLine(idx, { quantity: e.target.value })} />
                    </div>
                    <div>
                      <Label className="text-[11px]">Unit cost (UGX)</Label>
                      <Input type="number" min="0" value={l.unit_amount} disabled={readOnly}
                        onChange={e => updateLine(idx, { unit_amount: e.target.value })} />
                    </div>
                    <div>
                      <Label className="text-[11px]">Month</Label>
                      <Input type="date" value={l.period_month} disabled={readOnly}
                        onChange={e => updateLine(idx, { period_month: e.target.value })} />
                    </div>
                  </div>
                  <div className="sm:col-span-2">
                    <Label className="text-[11px]">Justification</Label>
                    <Textarea rows={2} value={l.justification} disabled={readOnly}
                      onChange={e => updateLine(idx, { justification: e.target.value })} />
                  </div>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <span className="font-mono text-muted-foreground">
                    Total {formatUGX((Number(l.quantity) || 0) * (Number(l.unit_amount) || 0))}
                  </span>
                  <div className="flex items-center gap-2">
                    {l.document_path && (
                      /* Named, not "View document": the filename is how you
                         tell whether the right file went on the right line. */
                      <span className="inline-flex max-w-full items-center gap-1 rounded-md border border-border bg-muted/40 py-1 pl-2 pr-1 text-[11px]">
                        <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <button
                          type="button"
                          className="max-w-[16rem] truncate underline-offset-2 hover:underline"
                          title={`Open ${l.document_name || documentDisplayName(l.document_path)}`}
                          onClick={async () => {
                            try { window.open(await getBudgetDocumentUrl(l.document_path), '_blank'); }
                            catch { toast.error('Could not open document'); }
                          }}
                        >
                          {l.document_name || documentDisplayName(l.document_path)}
                        </button>
                        {!readOnly && (
                          <button
                            type="button"
                            aria-label={`Remove ${l.document_name || documentDisplayName(l.document_path)}`}
                            title="Remove attachment"
                            className="rounded p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                            onClick={() => {
                              updateLine(idx, { document_path: '', document_name: '' });
                              toast.success('Attachment removed');
                            }}
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </span>
                    )}
                    {!readOnly && (
                      <label className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px]">
                        {uploadingIdx === idx ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                        {l.document_path ? 'Replace' : 'Attach'}
                        <input type="file" className="hidden"
                          onChange={e => {
                            const f = e.target.files?.[0];
                            if (f) handleUpload(idx, f);
                            e.target.value = '';
                          }} />
                      </label>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>

          {!readOnly && (
            <Button size="sm" variant="outline" className="gap-1.5 text-xs"
              onClick={() => setLines(prev => [...prev, emptyLine()])}>
              <Plus className="h-3.5 w-3.5" /> Add line
            </Button>
          )}

          <div className="flex items-center justify-between border-t border-border pt-3 text-sm">
            <span className="text-muted-foreground">Requested total</span>
            <span className="font-mono font-semibold">{formatUGX(total)}</span>
          </div>

          <div className="flex flex-wrap items-center gap-2 pt-3">
            {!readOnly && (
              <Button size="sm" onClick={saveDraft} disabled={saving} className="gap-2 text-xs">
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Save draft
              </Button>
            )}
            <Button size="sm" className="gap-1.5 bg-purple-600 text-xs text-white hover:bg-purple-700" onClick={startNew}>
              <Plus className="h-3.5 w-3.5" /> New budget
            </Button>
            {!readOnly && (
              <Button size="sm" onClick={submit} disabled={submitting || saving} variant="secondary" className="gap-2 text-xs">
                {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Submit for review
              </Button>
            )}
          </div>
          {readOnly && (
            <p className="text-xs text-muted-foreground">
              This submission is locked. If the CFO requests a revision, a new version is created for you to edit.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}