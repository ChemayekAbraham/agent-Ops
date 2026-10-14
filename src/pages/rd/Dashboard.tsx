import { safeUUID } from '@/lib/safeUUID';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import {
  ArrowLeft, Target, CheckSquare, Check, Gauge, ArrowRight, CalendarDays, MapPin,
  BarChart3, TrendingUp, Car, Gem, Cpu, Users, Wallet, Handshake, FileText, BookOpen, Layers,
  FlaskConical, PlayCircle, Clock, PieChart, ClipboardList, type LucideIcon,
} from 'lucide-react';
import WelileLogo from '@/components/WelileLogo';
import { useEffect, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Plus, Trash2 } from 'lucide-react';
import IdeaCanvasBoard from './IdeaCanvasBoard';
import { Download } from 'lucide-react';
import { downloadRdGeneralReport } from '@/lib/rdGeneralReportPdf';
import { rdProjectCashValue, type RdCashField } from '@/lib/rdProjectCash';
import { kampalaTodayYmd } from '@/lib/kampalaDays';
import { loadRdUpdates, RD_UPDATES_KEY, rdDateOffset, rdWeeklyUpdates, type RdUpdate, type RdWeekPeriod } from '@/lib/rdWeeklyUpdates';

type Metric = { icon: LucideIcon; value: string; label: string; cashField?: RdCashField };
type Project = {
  cashId: string; name: string; tagline: string; icon: LucideIcon; stage: string; progress: number;
  objective: string; progressItems: string[]; metrics: Metric[];
  challenges: string[]; nextSteps: string[];
};

// Project presentation; report evidence comes only from recorded updates.
const PROJECTS: Project[] = [
  {
    cashId: 'car', name: 'Welile Car', tagline: 'Affordable vehicle ownership for a better tomorrow.', icon: Car,
    stage: 'Pilot', progress: 65,
    objective: 'Make vehicle ownership affordable through flexible financing.',
    progressItems: ['Customers saving for cars', 'Bank partnership in progress (Salaam Bank)', 'Contracts prepared (tenants/customers, directors)', 'New customers engaged'],
    metrics: [
      { icon: Users, value: '', label: 'Customers saving for car', cashField: 'customers' },
      { icon: Wallet, value: '', label: 'Cash in', cashField: 'cashIn' },
      { icon: Car, value: '', label: 'Cash out', cashField: 'cashOut' },
      { icon: Handshake, value: '1', label: 'Partner (working on bank account)' },
    ],
    challenges: ['Bank approval process', 'Customer documentation'],
    nextSteps: ['Meet Salaam Bank', 'Finalize agreements', 'Recruit more customers'],
  },
  {
    cashId: 'dowry', name: 'Welile Dowry', tagline: 'Plan today. Celebrate tomorrow.', icon: Gem,
    stage: 'Development', progress: 40,
    objective: 'Help families prepare for dowry expenses through structured financing.',
    progressItems: ['Business model finalized', 'Partnership discussions ongoing', 'Early customer interest and inquiries'],
    metrics: [
      { icon: Users, value: '', label: 'Registered customers', cashField: 'customers' },
      { icon: Wallet, value: '', label: 'Savings collected', cashField: 'cashIn' },
      { icon: Wallet, value: '', label: 'Cash out', cashField: 'cashOut' },
      { icon: FileText, value: '8', label: 'Applications received' },
    ],
    challenges: ['Market awareness', 'Partner recruitment'],
    nextSteps: ['Launch pilot program', 'Marketing campaign', 'Customer registration'],
  },
  {
    cashId: 'ai', name: 'Welile School of AI', tagline: "Skilling today for tomorrow's opportunities.", icon: Cpu,
    stage: 'Planning', progress: 25,
    objective: 'Train young people in Artificial Intelligence and digital skills.',
    progressItems: ['Curriculum development', 'Training materials preparation', 'Partnership outreach'],
    metrics: [
      { icon: Users, value: '', label: 'Students enrolled', cashField: 'customers' },
      { icon: Wallet, value: '', label: 'Cash in', cashField: 'cashIn' },
      { icon: Wallet, value: '', label: 'Cash out', cashField: 'cashOut' },
      { icon: BookOpen, value: '5', label: 'Courses drafted' },
      { icon: Users, value: '3', label: 'Potential trainers' },
    ],
    challenges: ['Equipment & tools', 'Training venue'],
    nextSteps: ['Launch first cohort', 'Marketing campaign', 'Partner outreach'],
  },
];

// Key metrics overview is generated live from the editable Business Ideas cash table.
function overviewMetrics(rows: IdeaRow[]): Metric[] {
  const tot = rows.reduce((a, r) => ({ c: a.c + r.customers, i: a.i + r.cashIn, o: a.o + r.cashOut }), { c: 0, i: 0, o: 0 });
  return [
    { icon: Users, value: tot.c.toLocaleString('en-US'), label: 'Total customers (across projects)' },
    { icon: Wallet, value: fmt(tot.i), label: 'Total cash in' },
    { icon: TrendingUp, value: fmt(tot.i - tot.o), label: 'Net position (cash in − out)' },
  ];
}

function Ring({ value, label }: { value: number; label: string }) {
  const r = 22; const c = 2 * Math.PI * r;
  return (
    <div className="flex shrink-0 flex-col items-center gap-1">
      <svg viewBox="0 0 56 56" className="h-14 w-14 -rotate-90">
        <circle cx="28" cy="28" r={r} className="fill-none stroke-muted" strokeWidth="5" />
        <circle cx="28" cy="28" r={r} className="fill-none stroke-primary" strokeWidth="5" strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={c * (1 - value / 100)} />
        <text x="28" y="28" textAnchor="middle" dominantBaseline="central"
          className="rotate-90 fill-foreground text-[12px] font-bold" style={{ transformOrigin: '28px 28px' }}>{value}%</text>
      </svg>
      <span className="text-[10px] text-muted-foreground">{label}</span>
    </div>
  );
}

function SectionTitle({ icon: Icon, children }: { icon: LucideIcon; children: React.ReactNode }) {
  return <p className="flex items-center gap-2 text-sm font-semibold text-foreground"><Icon className="h-4 w-4 text-primary" />{children}</p>;
}

function ProjectCard({ p, cashRows, updates, onUpdates }: { p: Project; cashRows: IdeaRow[]; updates: RdUpdate[]; onUpdates: (updates: RdUpdate[]) => void }) {
  const Icon = p.icon;
  const upd = (id: string, patch: Partial<RdUpdate>) => onUpdates(updates.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  return (
    <div className="flex flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <div className="flex items-start gap-3 bg-primary/5 p-4">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground"><Icon className="h-6 w-6" /></div>
        <div className="min-w-0 flex-1">
          <h3 className="text-lg font-bold text-foreground">{p.name}</h3>
          <p className="text-xs text-muted-foreground">{p.tagline}</p>
        </div>
        <Ring value={p.progress} label={p.stage} />
      </div>
      <div className="flex flex-1 flex-col gap-4 p-4">
        <div>
          <SectionTitle icon={Target}>Objective</SectionTitle>
          <p className="mt-1 pl-6 text-xs text-muted-foreground">{p.objective}</p>
        </div>
        <div>
          <SectionTitle icon={CheckSquare}>Current Progress</SectionTitle>
          <ul className="mt-1.5 space-y-1 pl-6">
            {p.progressItems.map((t) => (
              <li key={t} className="flex items-start gap-2 text-xs text-muted-foreground"><Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />{t}</li>
            ))}
          </ul>
        </div>
        <div className="rounded-xl bg-muted/50 p-3">
          <SectionTitle icon={Gauge}>Key Metrics</SectionTitle>
          <div className="mt-2 grid gap-2" style={{ gridTemplateColumns: `repeat(${p.metrics.length}, minmax(0, 1fr))` }}>
            {p.metrics.map((m) => (
              <div key={m.label} className="flex flex-col items-center text-center">
                <m.icon className="h-4 w-4 text-primary" />
                <span className="mt-1 text-sm font-bold text-foreground">{m.cashField ? rdProjectCashValue(cashRows, p.cashId, m.cashField) : m.value}</span>
                <span className="text-[10px] leading-tight text-muted-foreground">{m.label}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="mt-auto rounded-xl bg-muted/50 p-3">
          <div className="flex items-center justify-between gap-2">
            <SectionTitle icon={ClipboardList}>Updates</SectionTitle>
            <Button size="sm" variant="outline" className="h-7 gap-1 px-2 text-xs"
              onClick={() => onUpdates([...updates, { id: safeUUID(), date: kampalaTodayYmd(), text: '' }])}>
              <Plus className="h-3 w-3" />Add update
            </Button>
          </div>
          {updates.length === 0 && (
            <p className="mt-1.5 text-xs text-muted-foreground">No updates recorded yet. Add one with its date.</p>
          )}
          <div className="mt-2 space-y-2">
            {updates.map((u) => (
              <div key={u.id} className="flex items-center gap-1.5">
                <Input type="date" className="h-8 w-32 shrink-0 text-xs" value={u.date}
                  onChange={(e) => upd(u.id, { date: e.target.value })} />
                <Input className="h-8 min-w-0 flex-1 text-xs" placeholder="Record an update…" value={u.text}
                  onChange={(e) => upd(u.id, { text: e.target.value })} />
                <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" aria-label="Remove update"
                  onClick={() => onUpdates(updates.filter((x) => x.id !== u.id))}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}


type IdeaRow = { id: string; name: string; customers: number; cashIn: number; cashOut: number };
const IDEAS_KEY = 'rd-business-ideas-v1';
const DEFAULT_IDEAS: IdeaRow[] = [
  { id: 'car', name: 'Welile Car', customers: 2, cashIn: 4000000, cashOut: 40000 },
  { id: 'dowry', name: 'Welile Dowry', customers: 15, cashIn: 2300000, cashOut: 0 },
  { id: 'ai', name: 'Welile School of AI', customers: 0, cashIn: 0, cashOut: 0 },
];
const fmt = (n: number) => `UGX ${n.toLocaleString('en-US')}`;

function BusinessIdeasCashTable({ rows, setRows }: { rows: IdeaRow[]; setRows: React.Dispatch<React.SetStateAction<IdeaRow[]>> }) {
  const upd = (id: string, patch: Partial<IdeaRow>) => setRows((r) => r.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  const num = (v: string) => Math.max(0, Number(v.replace(/[^0-9]/g, '')) || 0);
  const tot = rows.reduce((a, r) => ({ c: a.c + r.customers, i: a.i + r.cashIn, o: a.o + r.cashOut }), { c: 0, i: 0, o: 0 });
  const net = (r: { cashIn: number; cashOut: number }) => r.cashIn - r.cashOut;
  const cls = (n: number) => (n < 0 ? 'text-destructive' : 'text-foreground');
  return (
    <div className="rounded-2xl border border-border bg-card p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <SectionTitle icon={Wallet}><span className="text-base">Business Ideas: Cash Position</span></SectionTitle>
          <p className="mt-0.5 pl-6 text-xs text-muted-foreground">Tap any figure to edit. Net position = cash in minus cash out. Saved on this device.</p>
        </div>
        <Button size="sm" variant="outline" className="gap-1.5"
          onClick={() => setRows((r) => [...r, { id: safeUUID(), name: 'New idea', customers: 0, cashIn: 0, cashOut: 0 }])}>
          <Plus className="h-4 w-4" />Add idea
        </Button>
      </div>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[640px] text-xs">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="p-2 font-medium">Business idea</th>
              <th className="p-2 font-medium">Customers</th>
              <th className="p-2 font-medium">Cash in (UGX)</th>
              <th className="p-2 font-medium">Cash out (UGX)</th>
              <th className="p-2 text-right font-medium">Net position</th>
              <th className="w-8 p-2" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-border">
                <td className="p-2"><Input className="h-8 text-xs" value={r.name} onChange={(e) => upd(r.id, { name: e.target.value })} /></td>
                <td className="p-2"><Input className="h-8 w-24 text-xs" inputMode="numeric" value={r.customers.toLocaleString('en-US')} onChange={(e) => upd(r.id, { customers: num(e.target.value) })} /></td>
                <td className="p-2"><Input className="h-8 text-xs" inputMode="numeric" value={r.cashIn.toLocaleString('en-US')} onChange={(e) => upd(r.id, { cashIn: num(e.target.value) })} /></td>
                <td className="p-2"><Input className="h-8 text-xs" inputMode="numeric" value={r.cashOut.toLocaleString('en-US')} onChange={(e) => upd(r.id, { cashOut: num(e.target.value) })} /></td>
                <td className={`p-2 text-right font-bold ${cls(net(r))}`}>{fmt(net(r))}</td>
                <td className="p-2"><Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Remove idea" onClick={() => setRows((x) => x.filter((y) => y.id !== r.id))}><Trash2 className="h-3.5 w-3.5" /></Button></td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-border font-bold text-foreground">
              <td className="p-2">Total</td>
              <td className="p-2">{tot.c.toLocaleString('en-US')}</td>
              <td className="p-2">{fmt(tot.i)}</td>
              <td className="p-2">{fmt(tot.o)}</td>
              <td className={`p-2 text-right ${cls(tot.i - tot.o)}`}>{fmt(tot.i - tot.o)}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

const avg = Math.round(PROJECTS.reduce((s, p) => s + p.progress, 0) / PROJECTS.length);
const SUMMARY: Metric[] = [
  { icon: Layers, value: String(PROJECTS.length), label: 'Active R&D Projects' },
  { icon: PlayCircle, value: String(PROJECTS.filter((p) => p.stage === 'Pilot').length), label: 'In pilot' },
  { icon: Clock, value: String(PROJECTS.filter((p) => p.stage !== 'Pilot').length), label: 'In development or planning' },
  { icon: PieChart, value: `${avg}%`, label: 'Average progress across all projects' },
];
const SUMMARY_KEY = 'rd-summary-v1';

const WEEK_COLS: { key: RdWeekPeriod; title: string; icon: LucideIcon }[] = [
  { key: 'last', title: 'Last 7 days', icon: CalendarDays },
  { key: 'today', title: 'Today', icon: MapPin },
  { key: 'next', title: 'Next 7 days', icon: ArrowRight },
];

export default function RDDashboard() {
  const navigate = useNavigate();
  const [projectUpdates, setProjectUpdates] = useState(loadRdUpdates);
  const [updateError, setUpdateError] = useState('');
  const editUpdates = (name: string, updates: RdUpdate[]) => {
    const next = { ...projectUpdates, [name]: updates };
    try {
      localStorage.setItem(RD_UPDATES_KEY, JSON.stringify(next));
      setProjectUpdates(next);
      setUpdateError('');
    } catch { setUpdateError('The update could not be saved on this device. Please try again.'); }
  };
  const reportDay = kampalaTodayYmd();
  const [ideaRows, setIdeaRows] = useState<IdeaRow[]>(() => {
    try { const v = localStorage.getItem(IDEAS_KEY); if (v) return JSON.parse(v); } catch { /* ignore */ }
    return DEFAULT_IDEAS;
  });
  const editIdeaRows: React.Dispatch<React.SetStateAction<IdeaRow[]>> = (edit) => {
    setIdeaRows((previous) => {
      const next = typeof edit === 'function' ? edit(previous) : edit;
      try { localStorage.setItem(IDEAS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  };
  const OVERVIEW = overviewMetrics(ideaRows);
  const [summaryText, setSummaryText] = useState<{ value: string; label: string }[]>(() => {
    try { const v = localStorage.getItem(SUMMARY_KEY); if (v) return JSON.parse(v); } catch { /* ignore */ }
    return SUMMARY.map((s) => ({ value: s.value, label: s.label }));
  });
  useEffect(() => { try { localStorage.setItem(SUMMARY_KEY, JSON.stringify(summaryText)); } catch { /* ignore */ } }, [summaryText]);
  const summary = SUMMARY.map((s, i) => ({ ...s, ...(summaryText[i] ?? {}) }));
  const editSummary = (i: number, patch: Partial<{ value: string; label: string }>) =>
    setSummaryText(() => summary.map((s, j) => ({ value: s.value, label: s.label, ...(j === i ? patch : {}) })));
  const [exporting, setExporting] = useState(false);
  const exportReport = async () => {
    setExporting(true);
    try {
      await downloadRdGeneralReport({
        projects: PROJECTS.map((p) => ({ name: p.name, updates: projectUpdates[p.name] ?? [] })),
        ideas: ideaRows,
      });
    } finally { setExporting(false); }
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-20 border-b border-border bg-card/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center gap-2 px-4 py-2">
          <Button variant="ghost" size="sm" className="gap-1.5 px-2" onClick={() => navigate('/admin/dashboard')}>
            <ArrowLeft className="h-4 w-4" />
            Back to dashboards
          </Button>
          <Button size="sm" className="ml-auto gap-1.5" disabled={exporting} onClick={exportReport}>
            <Download className="h-4 w-4" />{exporting ? 'Preparing…' : 'General report'}
          </Button>
          <WelileLogo showText={false} size="sm" linkToHome={false} />
        </div>
      </header>
      <main className="mx-auto max-w-7xl space-y-4 px-4 py-5">
        <div className="grid gap-3 rounded-2xl border border-border bg-card p-4 shadow-sm lg:grid-cols-[1.2fr_repeat(4,1fr)]">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-full bg-primary/10"><FlaskConical className="h-5 w-5 text-primary" /></div>
            <div>
              <h1 className="text-lg font-bold text-foreground">Overall Summary</h1>
              <p className="text-xs text-muted-foreground">Project progress at a glance</p>
            </div>
          </div>
          {summary.map((s, idx) => (
            <div key={idx} className="flex items-center gap-3 rounded-xl border border-border bg-background p-3">
              <s.icon className="h-6 w-6 shrink-0 text-primary" />
              <div className="min-w-0 flex-1 space-y-0.5">
                <input aria-label="Value" className="w-full bg-transparent text-xl font-bold text-foreground outline-none focus:rounded focus:ring-1 focus:ring-ring"
                  value={s.value} onChange={(e) => editSummary(idx, { value: e.target.value })} />
                <input aria-label="Label" className="w-full bg-transparent text-xs text-muted-foreground outline-none focus:rounded focus:ring-1 focus:ring-ring"
                  value={s.label} onChange={(e) => editSummary(idx, { label: e.target.value })} />
              </div>
            </div>
          ))}
        </div>

        <BusinessIdeasCashTable rows={ideaRows} setRows={editIdeaRows} />

        <IdeaCanvasBoard />

        <div className="grid gap-4 lg:grid-cols-3">
          {PROJECTS.map((p) => <ProjectCard key={p.name} p={p} cashRows={ideaRows} updates={projectUpdates[p.name] ?? []} onUpdates={(updates) => editUpdates(p.name, updates)} />)}
        </div>
        {updateError && <p role="alert" className="text-sm text-destructive">{updateError}</p>}

        <div className="grid gap-4 lg:grid-cols-3">
          <div className="rounded-2xl border border-border bg-card p-4 shadow-sm lg:col-span-2">
            <div className="flex flex-wrap items-baseline gap-3">
              <SectionTitle icon={CalendarDays}><span className="text-base">Weekly R&amp;D Report</span></SectionTitle>
              <span className="text-xs text-muted-foreground">Key updates for each project</span>
            </div>
            <div className="mt-3 grid gap-3 md:grid-cols-3">
              {WEEK_COLS.map((col) => (
                <div key={col.key} className="rounded-xl bg-muted/50">
                  <p className="flex items-center gap-2 rounded-t-xl bg-primary/10 px-3 py-2 text-xs font-bold uppercase tracking-wide text-foreground">
                    <col.icon className="h-4 w-4 text-primary" />{col.title}
                  </p>
                  <div className="space-y-3 p-3">
                    {PROJECTS.map((p) => (
                      <div key={p.name} className="flex gap-2">
                        <p.icon className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                        <div className="min-w-0 flex-1">
                          <p className="text-xs font-semibold text-foreground">{p.name}</p>
                          <div className="mt-1.5 space-y-2">
                            {rdWeeklyUpdates(projectUpdates[p.name] ?? [], col.key, reportDay).map((u) => (
                              <div key={u.id} className="space-y-1">
                                <Input type="date" aria-label={`${p.name} ${col.title} update date`} className="h-8 w-full text-xs" value={u.date}
                                  onChange={(e) => editUpdates(p.name, (projectUpdates[p.name] ?? []).map((x) => x.id === u.id ? { ...x, date: e.target.value } : x))} />
                                <div className="flex items-center gap-1">
                                  <Input aria-label={`${p.name} ${col.title} update text`} className="h-8 min-w-0 flex-1 text-xs" placeholder="Record an update…" value={u.text}
                                    onChange={(e) => editUpdates(p.name, (projectUpdates[p.name] ?? []).map((x) => x.id === u.id ? { ...x, text: e.target.value } : x))} />
                                  <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" aria-label={`Remove ${p.name} ${col.title} update`}
                                    onClick={() => editUpdates(p.name, (projectUpdates[p.name] ?? []).filter((x) => x.id !== u.id))}><Trash2 className="h-3.5 w-3.5" /></Button>
                                </div>
                              </div>
                            ))}
                            {rdWeeklyUpdates(projectUpdates[p.name] ?? [], col.key, reportDay).length === 0 && <p className="text-xs text-muted-foreground">No updates recorded</p>}
                            <Button size="sm" variant="outline" className="h-7 gap-1 px-2 text-xs" aria-label={`Add ${p.name} ${col.title} update`}
                              onClick={() => editUpdates(p.name, [...(projectUpdates[p.name] ?? []), { id: safeUUID(), date: rdDateOffset(reportDay, col.key === 'last' ? -1 : col.key === 'next' ? 1 : 0), text: '' }])}>
                              <Plus className="h-3 w-3" />Add update
                            </Button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="space-y-4">
            <div className="rounded-2xl border border-border bg-card p-4 shadow-sm">
              <SectionTitle icon={BarChart3}>Project Progress</SectionTitle>
              <div className="mt-3 space-y-3">
                {PROJECTS.map((p) => (
                  <div key={p.name} className="grid grid-cols-[7.5rem_1fr_2.5rem] items-center gap-2 text-xs">
                    <span className="text-foreground">{p.name}</span>
                    <div className="h-2.5 rounded-full bg-muted"><div className="h-2.5 rounded-full bg-primary" style={{ width: `${p.progress}%` }} /></div>
                    <span className="text-right font-semibold text-foreground">{p.progress}%</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="rounded-2xl border border-border bg-card p-4 shadow-sm">
              <SectionTitle icon={TrendingUp}>Key Metrics Overview</SectionTitle>
              <div className="mt-3 grid grid-cols-3 gap-2">
                {OVERVIEW.map((m) => (
                  <div key={m.label} className="flex flex-col items-center text-center">
                    <m.icon className="h-5 w-5 text-primary" />
                    <span className="mt-1 text-base font-bold text-foreground">{m.value}</span>
                    <span className="text-[10px] leading-tight text-muted-foreground">{m.label}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        <footer className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-primary px-4 py-3 text-xs text-primary-foreground">
          <span className="font-semibold">Welile Technologies Ltd <span className="mx-2 opacity-60">|</span> R&amp;D Department</span>
          <span className="italic">Innovation • Impact • Inclusivity</span>
        </footer>
      </main>
    </div>
  );
}
