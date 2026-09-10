import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ChevronDown, Loader2, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { formatDynamic as formatUGX } from '@/lib/currencyFormat';
import {
  fetchConsolidation, useBudgetCycles,
  type BudgetConsolidation,
} from '@/hooks/useDepartmentBudgets';
import BudgetReviewQueue from '@/components/budget/BudgetReviewQueue';

type View = 'queue' | 'consolidation' | 'cycles';

const VIEWS: { id: View; label: string }[] = [
  { id: 'queue', label: 'Department budgets' },
  { id: 'consolidation', label: 'Consolidated budget' },
  { id: 'cycles', label: 'Budget cycles' },
];

/** CFO-side department budget collection, line-level approval and consolidation. */
export default function BudgetApprovalPanel() {
  const { cycles, loading: cyclesLoading, reload: reloadCycles } = useBudgetCycles();
  const [view, setView] = useState<View>('queue');
  const [cycleId, setCycleId] = useState('all');
  const [loading, setLoading] = useState(false);
  const [consolidation, setConsolidation] = useState<BudgetConsolidation | null>(null);

  const selectedCycleId = cycleId === 'all' ? null : cycleId;

  useEffect(() => {
    if (view !== 'consolidation') return;
    if (!selectedCycleId) {
      setConsolidation(null);
      return;
    }
    setConsolidation(null);
    fetchConsolidation(selectedCycleId)
      .then(setConsolidation)
      .catch(e => toast.error(e instanceof Error ? e.message : 'Could not build consolidation'));
  }, [view, selectedCycleId]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {VIEWS.map(v => (
          <button key={v.id} onClick={() => setView(v.id)}
            className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${view === v.id ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-secondary text-muted-foreground hover:text-foreground'}`}>
            {v.label}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-2">
          <Select value={cycleId} onValueChange={setCycleId}>
            <SelectTrigger className="h-8 w-[220px] text-xs"><SelectValue placeholder="Budget cycle" /></SelectTrigger>
            <SelectContent className="z-[100]">
              <SelectItem value="all">All cycles</SelectItem>
              {cycles.map(c => (
                <SelectItem key={c.id} value={c.id}>
                  {c.title}{c.financial_year ? ` · ${c.financial_year}` : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {(cyclesLoading || loading) && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      )}

      {view === 'queue' && <BudgetReviewQueue cycleId={selectedCycleId} stage="cfo" />}

      {view === 'consolidation' && (
        <div className="space-y-3">
          {!selectedCycleId && (
            <p className="text-xs text-muted-foreground">Select a specific budget cycle above to build a consolidated view.</p>
          )}
          {selectedCycleId && !consolidation && <p className="text-xs text-muted-foreground">Building consolidation…</p>}
          {selectedCycleId && consolidation && (
            <>
              <div className="grid grid-cols-2 gap-2">
                <Kpi label="Requested company-wide" value={formatUGX(consolidation.totals.requested)} />
                <Kpi label="Approved company-wide" value={formatUGX(consolidation.totals.approved)} />
              </div>
              <Section title="By activity">
                {consolidation.by_activity.map(r => (
                  <Row key={r.activity} label={r.activity} a={r.requested} b={r.approved} />
                ))}
              </Section>
              <Section title="By department">
                {consolidation.by_department.map(r => (
                  <Row key={r.department_id ?? r.department_name} label={r.department_name} a={r.requested} b={r.approved} />
                ))}
              </Section>
              <Section title="By account — approved vs actual (General Ledger)">
                {consolidation.by_account.map(r => (
                  <div key={r.account_code} className="flex items-center justify-between border-b border-border/40 py-1.5 text-xs last:border-0">
                    <span className="min-w-0 flex-1 truncate">{r.account_code} — {r.account_label ?? ''}</span>
                    <span className="w-28 text-right font-mono">{formatUGX(r.approved)}</span>
                    <span className="w-28 text-right font-mono text-muted-foreground">{formatUGX(r.actual)}</span>
                    <span className={`w-16 text-right font-mono ${r.variance < 0 ? 'text-destructive' : 'text-emerald-600'}`}>
                      {r.utilization_pct == null ? '—' : `${Math.round(r.utilization_pct)}%`}
                    </span>
                  </div>
                ))}
              </Section>
            </>
          )}
        </div>
      )}

      {view === 'cycles' && <CycleManager onCreated={reloadCycles} cycles={cycles} />}
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

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader className="pb-2"><CardTitle className="text-sm">{title}</CardTitle></CardHeader>
      <CardContent className="pt-0">{children}</CardContent>
    </Card>
  );
}

function Row({ label, a, b }: { label: string; a: number; b: number }) {
  return (
    <div className="flex items-center justify-between border-b border-border/40 py-1.5 text-xs last:border-0">
      <span className="min-w-0 flex-1 truncate capitalize">{label.replace(/_/g, ' ')}</span>
      <span className="w-28 text-right font-mono text-muted-foreground">{formatUGX(a)}</span>
      <span className="w-28 text-right font-mono">{formatUGX(b)}</span>
    </div>
  );
}

function CycleManager({ cycles, onCreated }: { cycles: ReturnType<typeof useBudgetCycles>['cycles']; onCreated: () => Promise<void> }) {
  const [title, setTitle] = useState('');
  const [fy, setFy] = useState('');
  const [periodType, setPeriodType] = useState('5days');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [deadline, setDeadline] = useState('');
  const [instructions, setInstructions] = useState('');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const [departments, setDepartments] = useState<{ id: string; name: string }[]>([]);
  const [targetIds, setTargetIds] = useState<string[]>([]);

  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from('hr_departments')
        .select('id,name')
        .eq('active', true)
        .order('name');
      const list = (data ?? []) as { id: string; name: string }[];
      setDepartments(list);
      // Every active department is targeted by default. The previous default
      // was a hardcoded list of three display names ('Marketing',
      // 'Engineering & Product', 'Operations'), so every other department was
      // silently left out of the cycle and never notified - and renaming or
      // adding a department in HR quietly changed who got a budget call.
      // Excluding a department is now a deliberate act, not a default.
      setTargetIds(list.map(d => d.id));
    })();
  }, []);

  const toggleDept = (id: string) =>
    setTargetIds(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]));

  const targetLabel = targetIds.length === 0
    ? 'Select departments'
    : targetIds.length === departments.length
      ? 'All departments'
      : departments.filter(d => targetIds.includes(d.id)).map(d => d.name).join(', ');

  const create = async () => {
    if (!title || !start || !end) {
      setFormError('Title, start and end dates are required');
      return;
    }
    if (targetIds.length === 0) {
      setFormError('Select at least one department to send the cycle to');
      return;
    }
    setFormError('');
    setSaving(true);
    try {
      const { error } = await supabase.rpc('budget_create_cycle', {
        p_title: title,
        p_financial_year: fy || null,
        p_period_type: periodType,
        p_period_start: start,
        p_period_end: end,
        p_deadline: deadline ? new Date(deadline).toISOString() : null,
        p_instructions: instructions || null,
        p_department_ids: targetIds,
      } as any);
      if (error) throw error;
      toast.success(`Budget cycle opened — sent to ${targetIds.length} department(s)`);
      setTitle(''); setFy(''); setStart(''); setEnd(''); setDeadline(''); setInstructions('');
      await onCreated();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not open cycle');
    } finally {
      setSaving(false);
    }
  };


  const setStatus = async (id: string, status: string) => {
    const { error } = await supabase.rpc('budget_set_cycle_status', { p_call_id: id, p_status: status });
    if (error) { toast.error(error.message); return; }
    toast.success(`Cycle ${status}`);
    await onCreated();
  };

  return (
    <div className="space-y-3">
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">Open a new budget cycle</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div><Label className="text-xs">Title</Label><Input value={title} onChange={e => setTitle(e.target.value)} placeholder="FY2027 Annual Budget" /></div>
            <div><Label className="text-xs">Financial year</Label><Input value={fy} onChange={e => setFy(e.target.value)} placeholder="FY2027" /></div>
            <div>
              <Label className="text-xs">Period type</Label>
              <Select value={periodType} onValueChange={setPeriodType}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent className="z-[100]">
                  {['5days'].map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div><Label className="text-xs">Submission deadline</Label><Input type="datetime-local" value={deadline} onChange={e => setDeadline(e.target.value)} /></div>
            <div><Label className="text-xs">Period start</Label><Input type="date" value={start} onChange={e => setStart(e.target.value)} /></div>
            <div><Label className="text-xs">Period end</Label><Input type="date" value={end} onChange={e => setEnd(e.target.value)} /></div>
          </div>
          <div><Label className="text-xs">Instructions to departments</Label><Textarea rows={2} value={instructions} onChange={e => setInstructions(e.target.value)} /></div>
          <div>
            <Label className="text-xs">Send to departments</Label>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" className="mt-1 w-full justify-between gap-2 text-xs font-normal">
                  <span className="truncate">{targetLabel}</span>
                  <ChevronDown className="h-4 w-4 shrink-0 opacity-60" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="z-[100] max-h-72 w-64 overflow-y-auto">
                <DropdownMenuLabel className="flex items-center justify-between gap-2 text-xs">
                  <span>Departments</span>
                  <span className="flex gap-2 font-normal">
                    <button
                      type="button"
                      className="text-primary hover:underline disabled:opacity-40 disabled:no-underline"
                      disabled={targetIds.length === departments.length}
                      onClick={() => setTargetIds(departments.map(d => d.id))}
                    >
                      All
                    </button>
                    <button
                      type="button"
                      className="text-muted-foreground hover:underline disabled:opacity-40 disabled:no-underline"
                      disabled={targetIds.length === 0}
                      onClick={() => setTargetIds([])}
                    >
                      Clear
                    </button>
                  </span>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                {departments.map(d => (
                  <DropdownMenuCheckboxItem
                    key={d.id}
                    checked={targetIds.includes(d.id)}
                    onCheckedChange={() => toggleDept(d.id)}
                    onSelect={e => e.preventDefault()}
                    className="text-xs"
                  >
                    {d.name}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <p className="mt-1 text-[11px] text-muted-foreground">
              Only the selected departments get the cycle on their dashboard.
            </p>
          </div>
          <Button onClick={create} disabled={saving} className="gap-2">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Open cycle
          </Button>

          {formError && <p className="text-xs text-destructive">{formError}</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">Existing cycles</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {cycles.map(c => (
            <div key={c.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-border p-3 text-xs">
              <span className="font-medium">{c.title}</span>
              {c.financial_year && <Badge variant="outline" className="text-[10px]">{c.financial_year}</Badge>}
              <Badge variant="secondary" className="text-[10px]">{c.status}</Badge>
              <span className="text-muted-foreground">
                {format(new Date(c.period_start), 'dd MMM yyyy')} – {format(new Date(c.period_end), 'dd MMM yyyy')}
                {c.deadline && ` · due ${format(new Date(c.deadline), 'dd MMM yyyy')}`}
              </span>
              <div className="ml-auto flex gap-2">
                {c.status !== 'open' && <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => setStatus(c.id, 'open')}>Open</Button>}
                {c.status === 'open' && <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => setStatus(c.id, 'closed')}>Close</Button>}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}