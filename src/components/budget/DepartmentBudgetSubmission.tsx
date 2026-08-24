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
import { Loader2, Plus, Save, Send, Trash2, Upload, FileText, AlertTriangle } from 'lucide-react';
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

interface DraftLine {
  description: string;
  account_code: string;
  quantity: string;
  unit_amount: string;
  period_month: string;
  justification: string;
  document_path: string;
}

const emptyLine = (): DraftLine => ({
  description: '', account_code: '', quantity: '1', unit_amount: '',
  period_month: '', justification: '', document_path: '',
});

const EDITABLE_STATUSES = ['draft'];

interface Props {
  /** Dashboard the page was opened from (e.g. 'tenant-ops'); locks the form to that hub's department. */
  dashboard?: string;
  /** Explicit hr_departments.key allowlist; overrides `dashboard`. */
  departmentKeys?: string[];
}

/** Department-facing budget preparation and submission interface. */
export default function DepartmentBudgetSubmission({ dashboard, departmentKeys }: Props = {}) {
  const { cycles, loading: cyclesLoading } = useBudgetCycles();
  const { accounts, myDepartments: allMyDepartments, primaryDepartmentId } = useBudgetReferenceData();

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
  const readOnly = active ? !EDITABLE_STATUSES.includes(active.status) : false;

  useEffect(() => {
    if (!cycleId && openCycles.length) setCycleId(openCycles[0].id);
  }, [openCycles, cycleId]);
  useEffect(() => {
    if (!myDepartments.length) { if (departmentId) setDepartmentId(''); return; }
    if (myDepartments.some(d => d.id === departmentId)) return;
    const preferred = primaryDepartmentId
      ? myDepartments.find(d => d.id === primaryDepartmentId)
      : null;
    setDepartmentId(preferred?.id ?? myDepartments[0].id);
  }, [myDepartments, departmentId, primaryDepartmentId]);

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
      updateLine(idx, { document_path: path });
      toast.success('Supporting document attached');
    } catch {
      toast.error('Upload failed');
    } finally {
      setUploadingIdx(null);
    }
  };

  const saveDraft = async () => {
    if (!cycleId || !departmentId) { toast.error('Pick a budget cycle and department'); return; }
    setSaving(true);
    try {
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
      if (!payload.length) { toast.error('Add at least one line with a description and a budget category'); return; }
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
      toast.success('Draft saved');
      await loadSubmissions();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save draft');
    } finally {
      setSaving(false);
    }
  };

  const submit = async () => {
    if (!activeId) { toast.error('Save the draft first'); return; }
    setSubmitting(true);
    try {
      const { data, error } = await supabase.rpc('budget_submit_submission', { p_submission_id: activeId });
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

  if (cyclesLoading) {
    return <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading budget cycles…</div>;
  }

  if (!myDepartments.length) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground">
          You are not linked to a department yet, so there is no budget to prepare. Ask HR to add your
          department assignment.
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
              {myDepartments.length > 1 ? (
                <Select value={departmentId} onValueChange={setDepartmentId}>
                  <SelectTrigger><SelectValue placeholder="Select department" /></SelectTrigger>
                  <SelectContent className="z-[100]">
                    {myDepartments.map(d => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              ) : (
                /* Single posting: the department is fixed to the user's own
                   department so a budget can never be filed under another. */
                <div
                  className="flex h-10 items-center rounded-md border border-input bg-muted/50 px-3 text-sm"
                  aria-readonly="true"
                >
                  {selectedDepartment?.name ?? '—'}
                </div>
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
                      <Button size="sm" variant="ghost" className="h-7 gap-1 px-2 text-[11px]"
                        onClick={async () => {
                          try { window.open(await getBudgetDocumentUrl(l.document_path), '_blank'); }
                          catch { toast.error('Could not open document'); }
                        }}>
                        <FileText className="h-3.5 w-3.5" /> View document
                      </Button>
                    )}
                    {!readOnly && (
                      <label className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px]">
                        {uploadingIdx === idx ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                        Attach
                        <input type="file" className="hidden"
                          onChange={e => { const f = e.target.files?.[0]; if (f) handleUpload(idx, f); }} />
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
              <Button size="sm" onClick={submit} disabled={submitting || !activeId} variant="secondary" className="gap-2 text-xs">
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