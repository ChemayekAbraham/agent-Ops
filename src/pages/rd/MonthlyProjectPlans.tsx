import { useState } from 'react';
import { CalendarDays, Pencil, Save, Target } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { formatUGX } from '@/lib/rentCalculations';
import { monthlyPlansKey, readMonthlyPlans, saveMonthlyPlan, type MonthlyProjectPlan } from './monthlyProjectPlans.data';

type Project = { id: string; name: string };

export default function MonthlyProjectPlans({ projects, userId }: { projects: Project[]; userId: string }) {
  const [month, setMonth] = useState(() => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Kampala', year: 'numeric', month: '2-digit' }).format(new Date()).replace(/^(\d{2})\/(\d{4})$/, '$2-$1'));
  const [plans, setPlans] = useState<MonthlyProjectPlan[]>(() => {
    try { return readMonthlyPlans(localStorage.getItem(monthlyPlansKey(userId))); } catch { return []; }
  });
  const [project, setProject] = useState<Project | null>(null);
  const [budget, setBudget] = useState('');
  const [targets, setTargets] = useState('');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const current = plans.filter((p) => p.month === month);
  const visibleProjects = [...projects, ...current.filter((p) => !projects.some((item) => item.id === p.projectId)).map((p) => ({ id: p.projectId, name: p.projectName }))];
  const open = (item: Project) => {
    const record = current.find((p) => p.projectId === item.id);
    setProject(item); setBudget(record ? String(record.budget) : ''); setTargets(record?.targets ?? ''); setError(''); setSaved('');
  };
  const save = () => {
    if (!project) return;
    try {
      if (!budget.trim() || !targets.trim()) throw new Error('Enter a budget and at least one target.');
      const next = saveMonthlyPlan(plans, { projectId: project.id, projectName: project.name, month, budget: Number(budget), targets: targets.trim(), updatedAt: new Date().toISOString() });
      localStorage.setItem(monthlyPlansKey(userId), JSON.stringify(next));
      setPlans(next); setProject(null); setSaved(`${project.name} · ${month} saved`);
    } catch (cause) { setError(cause instanceof Error && cause.message.startsWith('Enter') ? cause.message : 'Could not save on this device. Please try again.'); }
  };

  return (
    <section className="space-y-4 border-y border-border py-5" aria-labelledby="monthly-plans-title">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="monthly-plans-title" className="flex items-center gap-2 text-base font-semibold text-foreground"><Target className="h-5 w-5 text-primary" />Monthly budgets &amp; targets</h2>
        <label className="flex items-center gap-2 text-sm text-muted-foreground"><CalendarDays className="h-4 w-4" />Month<Input aria-label="Planning month" type="month" value={month} onChange={(event) => { if (event.target.value) { setMonth(event.target.value); setSaved(''); } }} className="w-44" /></label>
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {visibleProjects.map((item) => {
          const record = current.find((p) => p.projectId === item.id);
          return <article key={item.id} className="min-w-0 rounded-lg border border-border bg-card p-4">
            <div className="flex items-start justify-between gap-2"><h3 className="break-words font-semibold text-foreground">{item.name}</h3><Button size="icon" variant="ghost" aria-label={`${record ? 'Edit' : 'Record'} monthly plan for ${item.name}`} onClick={() => open(item)}><Pencil className="h-4 w-4" /></Button></div>
            <p className="mt-3 text-xs text-muted-foreground">Budget</p><p className="break-words text-xl font-bold text-foreground">{record ? formatUGX(record.budget) : '—'}</p>
            <p className="mt-3 text-xs text-muted-foreground">Targets</p><p className="mt-1 whitespace-pre-wrap break-words text-sm text-foreground">{record?.targets ?? 'Not recorded'}</p>
          </article>;
        })}
      </div>
      {visibleProjects.length === 0 && <p className="text-sm text-muted-foreground">No projects recorded.</p>}
      <p className="text-xs text-muted-foreground">Saved on this device · Planning records</p>
      {saved && <p role="status" className="text-sm text-primary">{saved}</p>}
      <Dialog open={project !== null} onOpenChange={(value) => { if (!value) setProject(null); }}>
        <DialogContent className="max-w-lg"><DialogHeader><DialogTitle>{project?.name} · Monthly plan</DialogTitle><DialogDescription>{month}</DialogDescription></DialogHeader>
          <div className="space-y-4">
            <label className="block space-y-1 text-sm font-medium">Budget (UGX)<Input type="number" min="0" step="1" inputMode="numeric" value={budget} onChange={(event) => setBudget(event.target.value)} /></label>
            <label className="block space-y-1 text-sm font-medium">Targets<Textarea rows={5} value={targets} onChange={(event) => setTargets(event.target.value)} /></label>
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            <div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setProject(null)}>Cancel</Button><Button onClick={save}><Save className="mr-2 h-4 w-4" />Save plan</Button></div>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}