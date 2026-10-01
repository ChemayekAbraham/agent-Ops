import { useMemo, useState, type ReactNode } from 'react';
import { format, formatDistanceToNow } from 'date-fns';
import {
  ArrowDownLeft,
  ArrowUpRight,
  CalendarDays,
  CircleDollarSign,
  Clock3,
  HandCoins,
  Landmark,
  Lock,
  Mail,
  MapPin,
  MessageSquareWarning,
  Phone,
  Search,
  UserRound,
  WalletCards,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { useCalleeDossier, type CalleeDossier, type DossierCollection } from '@/hooks/useCalleeDossier';
import { ComplaintEditor } from './ComplaintEditor';

/* ---------------- shared bits ---------------- */
const ugx = (n: number | null | undefined) => `UGX ${Math.round(Number(n ?? 0)).toLocaleString('en-US')}`;
const fdate = (d: string | null | undefined, f = 'd MMM yyyy') => (d ? format(new Date(d), f) : '—');
const label = (s: string | null | undefined) => (s ? s.replace(/_/g, ' ') : '—');

function Section({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
        {right}
      </div>
      {children}
    </section>
  );
}
type StatTone = 'primary' | 'success' | 'warning' | 'destructive' | 'muted';
function Stat({ k, v, tone = 'muted', icon: Icon }: { k: string; v: ReactNode; tone?: StatTone; icon?: typeof WalletCards }) {
  const toneClass: Record<StatTone, string> = {
    primary: 'border-primary/20 bg-primary/10 text-primary',
    success: 'border-success/20 bg-success/10 text-success',
    warning: 'border-warning/30 bg-warning/10 text-warning-foreground',
    destructive: 'border-destructive/20 bg-destructive/10 text-destructive',
    muted: 'border-border bg-card text-foreground',
  };
  return (
    <div className={cn('flex min-w-0 items-center gap-3 rounded-lg border p-3', toneClass[tone])}>
      {Icon && <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-background/80 shadow-sm"><Icon className="h-4 w-4" /></span>}
      <div className="min-w-0">
        <p className="text-[10px] font-bold uppercase tracking-wide opacity-80">{k}</p>
        <p className="mt-0.5 truncate text-sm font-bold tabular-nums text-foreground">{v}</p>
      </div>
    </div>
  );
}
function Row({ left, sub, right, rightSub }: { left: ReactNode; sub?: ReactNode; right?: ReactNode; rightSub?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-border/60 py-2 last:border-0">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-foreground">{left}</p>
        {sub && <p className="truncate text-[11px] text-muted-foreground">{sub}</p>}
      </div>
      <div className="shrink-0 text-right">
        <p className="text-sm font-semibold tabular-nums text-foreground">{right}</p>
        {rightSub && <p className="text-[11px] text-muted-foreground">{rightSub}</p>}
      </div>
    </div>
  );
}
const Empty = ({ children }: { children: ReactNode }) => (
  <p className="rounded-md border border-dashed border-border p-3 text-center text-xs text-muted-foreground">{children}</p>
);
function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <div className="relative">
      <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
      <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="h-8 pl-8 text-xs" />
    </div>
  );
}
const matches = (q: string, ...vals: (string | null | undefined)[]) =>
  !q || vals.some((v) => v?.toLowerCase().includes(q.toLowerCase()));

/* ---------------- reusable sections ---------------- */
function WalletSection({ d }: { d: CalleeDossier }) {
  return (
    <Section title="Wallet balances">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <Stat k="Withdrawable" v={ugx(d.wallet.withdrawable)} tone="success" icon={WalletCards} />
        <Stat k="Operational float" v={ugx(d.wallet.operational_float)} tone="primary" icon={CircleDollarSign} />
        <Stat k="Landlord float" v={ugx(d.wallet.landlord_float)} tone="warning" icon={Landmark} />
        <Stat k="Advance owed" v={ugx(d.wallet.advance)} tone={d.wallet.advance > 0 ? 'destructive' : 'muted'} icon={HandCoins} />
      </div>
    </Section>
  );
}
function WalletTxnsSection({ d }: { d: CalleeDossier }) {
  return (
    <Section title="Last 10 wallet transactions">
      {d.wallet_txns.length === 0 ? <Empty>No wallet transactions.</Empty> : (
        <div>{d.wallet_txns.map((t) => (
          <Row key={t.id} left={t.description || label(t.category)}
            sub={<>{fdate(t.created_at, 'd MMM yyyy, HH:mm')} · {label(t.wallet_bucket)}
              {t.paid_by && <Badge variant="outline" className="ml-1.5 px-1.5 py-0 text-[9px]">{t.paid_by === 'self' ? 'Self-repayment' : 'Via agent'}</Badge>}</>}
            right={<span className={cn('inline-flex items-center gap-1', t.direction === 'cash_in' ? 'text-success' : 'text-destructive')}>{t.direction === 'cash_in' ? <ArrowDownLeft className="h-3.5 w-3.5" /> : <ArrowUpRight className="h-3.5 w-3.5" />}{t.direction === 'cash_in' ? '+' : '−'}{ugx(t.amount)}</span>} />
        ))}</div>
      )}
    </Section>
  );
}

type Period = 'today' | 'yesterday' | 'month' | 'all';
const PERIOD_LABEL: Record<Period, string> = { today: 'Today', yesterday: 'Yesterday', month: 'This month', all: 'All time' };
function inPeriod(c: DossierCollection, p: Period, today: string, yesterday: string, monthStart: string) {
  if (p === 'today') return c.kampala_day === today;
  if (p === 'yesterday') return c.kampala_day === yesterday;
  if (p === 'month') return c.kampala_day >= monthStart;
  return true;
}
const kampalaDay = (offset = 0) => {
  const d = new Date(Date.now() + 3 * 3600_000 - offset * 86400_000);
  return d.toISOString().slice(0, 10);
};

function AgentTab({ d }: { d: CalleeDossier }) {
  const a = d.agent!;
  const [period, setPeriod] = useState<Period>('today');
  const [q, setQ] = useState('');
  const [tq, setTq] = useState('');
  const today = kampalaDay(), yesterday = kampalaDay(1), monthStart = `${today.slice(0, 7)}-01`;
  const list = useMemo(
    () => a.collections.filter((c) => inPeriod(c, period, today, yesterday, monthStart) && matches(q, c.tenant_name)),
    [a.collections, period, q, today, yesterday, monthStart],
  );
  const tenants = a.tenants.filter((t) => matches(tq, t.tenant_name, t.tenant_phone));
  const last = a.collections[0];
  const tot = a.tenants.reduce((s, t) => ({ daily: s.daily + t.daily, today: s.today + t.collected_today }), { daily: 0, today: 0 });

  return (
    <div className="space-y-5">
      <Section title="Last recorded collection">
        {last ? <div className="rounded-lg border border-success/20 bg-success/10 px-3"><Row left={last.tenant_name ?? 'Tenant'} sub={fdate(last.created_at, 'd MMM yyyy, HH:mm')} right={<span className="text-success">{ugx(last.amount)}</span>} rightSub={label(last.payment_method)} /></div>
          : <Empty>No collection is recorded for this agent yet.</Empty>}
      </Section>
      <Section title="Collections">
        <div className="grid grid-cols-4 gap-1">
          {(Object.keys(PERIOD_LABEL) as Period[]).map((p) => (
            <button key={p} type="button" onClick={() => setPeriod(p)}
              className={cn('rounded-md border px-1.5 py-1.5 text-left transition-colors',
                period === p ? 'border-primary bg-primary/10' : 'border-border hover:bg-muted/50')}>
              <span className="block text-[10px] font-medium text-muted-foreground">{PERIOD_LABEL[p]}</span>
              <span className="block truncate text-xs font-semibold tabular-nums">{ugx(a.totals[p].amount)}</span>
              <span className="block text-[10px] text-muted-foreground">{a.totals[p].count} payments</span>
            </button>
          ))}
        </div>
        <SearchBox value={q} onChange={setQ} placeholder="Search collections by tenant" />
        {list.length === 0 ? <Empty>No collections for {PERIOD_LABEL[period].toLowerCase()}.</Empty> : (
          <div className="max-h-64 overflow-y-auto">{list.map((c) => (
            <Row key={c.id} left={c.tenant_name ?? 'Tenant'} sub={fdate(c.created_at, 'd MMM, HH:mm')} right={ugx(c.amount)} rightSub={label(c.payment_method)} />
          ))}</div>
        )}
        {period !== 'today' && a.totals[period].count > list.length && !q && (
          <p className="text-[10px] text-muted-foreground">Showing the latest {list.length} of {a.totals[period].count}; totals above cover all of them.</p>
        )}
      </Section>
      <Section title={`Tenants (${a.tenants.length})`} right={<span className="text-[11px] text-muted-foreground tabular-nums">Today {ugx(tot.today)} of {ugx(tot.daily)}</span>}>
        <SearchBox value={tq} onChange={setTq} placeholder="Search this agent's tenants" />
        {tenants.length === 0 ? <Empty>No active Rent Plans.</Empty> : (
          <div className="max-h-72 overflow-y-auto">{tenants.map((t) => (
            <div key={t.rent_request_id} className="border-b border-border/60 py-2 last:border-0">
              <div className="flex items-center justify-between gap-2">
                <p className="truncate text-sm font-medium">{t.tenant_name ?? 'Tenant'}</p>
                <Badge variant="outline" className="text-[9px]">{label(t.status)}</Badge>
              </div>
              <div className="mt-1 grid grid-cols-4 gap-1 text-[11px] tabular-nums text-muted-foreground">
                <span>Daily<br /><b className="text-foreground">{ugx(t.daily)}</b></span>
                <span>Weekly<br /><b className="text-foreground">{ugx(t.weekly)}</b></span>
                <span>Today<br /><b className={t.collected_today >= t.daily && t.daily > 0 ? 'text-primary' : 'text-foreground'}>{ugx(t.collected_today)}</b></span>
                <span>Paid so far<br /><b className="text-foreground">{ugx(t.repaid)}</b></span>
              </div>
              <p className="mt-0.5 text-[10px] text-muted-foreground">Still owes {ugx(t.outstanding)} of {ugx(t.total)}</p>
            </div>
          ))}</div>
        )}
      </Section>
    </div>
  );
}

function ProxyTab({ d }: { d: CalleeDossier }) {
  const p = d.proxy!;
  const [q, setQ] = useState('');
  return (
    <div className="space-y-5">
      <Section title={`Promissory notes (${p.notes.length})`}>
        <SearchBox value={q} onChange={setQ} placeholder="Search notes by partner" />
        {p.notes.length === 0 ? <Empty>No promissory notes.</Empty> : (
          <div className="max-h-72 overflow-y-auto">{p.notes.filter((n) => matches(q, n.partner_name, n.phone_number)).map((n) => (
            <div key={n.id} className="border-b border-border/60 py-2 last:border-0">
              <div className="flex items-center justify-between gap-2">
                <p className="truncate text-sm font-medium">{n.partner_name ?? 'Partner'}</p>
                <span className="text-sm font-semibold tabular-nums">{ugx(n.amount)}</span>
              </div>
              <div className="mt-1 flex flex-wrap gap-1">
                <Badge variant="outline" className="text-[9px]">{label(n.status)}</Badge>
                <Badge variant={n.came_in ? 'default' : 'outline'} className="text-[9px]">{n.came_in ? 'Came in' : 'Not yet in'}</Badge>
                {n.contribution_type && <Badge variant="outline" className="text-[9px]">{label(n.contribution_type)}</Badge>}
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {n.phone_number ?? '—'} · Recorded {fdate(n.recorded_on ?? n.created_at)} · Due {fdate(n.fulfilment_due_on)} · Collected {ugx(n.total_collected)}
              </p>
              {(n.follow_up_note || n.notes) && <p className="mt-0.5 text-[11px] italic text-muted-foreground">{n.follow_up_note || n.notes}</p>}
            </div>
          ))}</div>
        )}
      </Section>
      <Section title={`Connected partners (${p.partners.length})`}>
        {p.partners.length === 0 ? <Empty>No partners linked.</Empty> : p.partners.map((x) => (
          <Row key={x.beneficiary_id} left={x.full_name ?? 'Partner'}
            sub={<>{x.phone ?? '—'} · {label(x.approval_status)}{x.is_managed_account ? ' · managed' : ''}</>}
            right={<Badge variant={x.came_in ? 'default' : 'outline'} className="text-[9px]">{x.came_in ? 'Came in' : 'Not yet in'}</Badge>}
            rightSub={x.active_support != null ? ugx(x.active_support) : undefined} />
        ))}
      </Section>
    </div>
  );
}

function TenantTab({ d }: { d: CalleeDossier }) {
  const t = d.tenant!;
  const [open, setOpen] = useState<string | null>(t.plans[0]?.id ?? null);
  return (
    <div className="space-y-5">
      <Section title="Last collection">
        {t.last_collection ? <div className="rounded-lg border border-success/20 bg-success/10 px-3"><Row left={<span className="text-success">{ugx(t.last_collection.amount)}</span>} sub={fdate(t.last_collection.created_at, 'd MMM yyyy, HH:mm')} right={t.last_collection.agent_name ?? '—'} rightSub="Agent" /></div>
          : <Empty>No agent collection is recorded for this tenant yet.</Empty>}
      </Section>
      <Section title={`Rent Plans (${t.plans.length})`}>
        {t.plans.length === 0 ? <Empty>No Rent Plans.</Empty> : t.plans.map((p) => {
          const hist = t.repayments.filter((r) => r.rent_request_id === p.id);
          const isOpen = open === p.id;
          return (
            <div key={p.id} className="rounded-md border border-border">
              <button type="button" onClick={() => setOpen(isOpen ? null : p.id)} className="flex w-full items-center justify-between gap-2 p-2.5 text-left hover:bg-muted/40">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{ugx(p.rent_amount)} rent · {fdate(p.funded_at ?? p.created_at)}</p>
                  <p className="text-[11px] text-muted-foreground">Paid {ugx(p.amount_repaid)} of {ugx(p.total_repayment)} · owes {ugx(p.outstanding)}</p>
                </div>
                <Badge variant={p.status === 'repaying' ? 'default' : 'outline'} className="shrink-0 text-[9px]">{label(p.status)}</Badge>
              </button>
              {isOpen && (
                <div className="border-t border-border px-2.5 pb-1">
                  <p className="py-1.5 text-[11px] text-muted-foreground">Daily {ugx(p.daily_repayment)} · {p.duration_days ?? '—'} days · agent {p.agent_name ?? '—'}{p.tenancy_status ? ` · tenancy ${label(p.tenancy_status)}` : ''}</p>
                  {hist.length === 0 ? <Empty>No payments on this plan.</Empty> : hist.map((r) => (
                    <Row key={r.id} left={ugx(r.amount)} sub={fdate(r.created_at, 'd MMM yyyy, HH:mm')}
                      right={<Badge variant="outline" className="text-[9px]">{r.paid_by === 'self' ? 'Self-repayment' : 'Via agent'}</Badge>}
                      rightSub={r.paid_by === 'agent' ? r.agent_name ?? undefined : undefined} />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </Section>
    </div>
  );
}

function PartnerTab({ d }: { d: CalleeDossier }) {
  const p = d.partner!;
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  if (p.restricted) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-md border border-dashed border-border p-6 text-center">
        <Lock className="h-5 w-5 text-muted-foreground" />
        <p className="text-sm font-medium">Partner details are restricted</p>
        <p className="text-xs text-muted-foreground">Only Partner Operations, Super Admin and HR can see portfolios and Returns.</p>
      </div>
    );
  }
  const ports = (p.portfolios ?? []).filter((x) => matches(q, x.portfolio_code, x.status));
  const active = (p.portfolios ?? []).filter((x) => x.status === 'active' || x.status === 'locked');
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-2">
        <Stat k="Active support" v={ugx(active.reduce((s, x) => s + Number(x.investment_amount), 0))} tone="primary" />
        <Stat k="Returns earned" v={ugx((p.portfolios ?? []).reduce((s, x) => s + Number(x.total_roi_earned ?? 0), 0))} />
      </div>
      <Section title={`Portfolios (${p.portfolios?.length ?? 0})`}>
        <SearchBox value={q} onChange={setQ} placeholder="Search portfolio code or status" />
        {ports.length === 0 ? <Empty>No portfolios.</Empty> : ports.map((x) => {
          const isOpen = sel === x.id;
          const changes = (p.changes ?? []).filter((c) => c.portfolio_code === x.portfolio_code);
          return (
            <div key={x.id} className="rounded-md border border-border">
              <button type="button" onClick={() => setSel(isOpen ? null : x.id)} className="flex w-full items-center justify-between gap-2 p-2.5 text-left hover:bg-muted/40">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{x.portfolio_code ?? 'Portfolio'} · {ugx(x.investment_amount)}</p>
                  <p className="text-[11px] text-muted-foreground">{x.roi_percentage ?? '—'}% Returns · {x.duration_months ?? '—'} months · matures {fdate(x.maturity_date)}</p>
                </div>
                <Badge variant={x.status === 'active' ? 'default' : 'outline'} className="shrink-0 text-[9px]">{label(x.status)}</Badge>
              </button>
              {isOpen && (
                <div className="space-y-1 border-t border-border p-2.5 text-[11px] text-muted-foreground">
                  <p>Started {fdate(x.created_at)} · next Returns {fdate(x.next_roi_date)} · payout day {x.payout_day ?? '—'}</p>
                  <p>Mode {label(x.roi_mode)} · {x.auto_reinvest ? 'Compounding (auto-reinvest on)' : 'Paid out monthly'} · via {label(x.payment_method)}</p>
                  <p>Returns earned so far <b className="text-foreground">{ugx(x.total_roi_earned)}</b></p>
                  {changes.length > 0 && <div className="pt-1">{changes.map((c) => (
                    <p key={c.id}>• {fdate(c.changed_at, 'd MMM yyyy')} — {label(c.action)}{c.changed_fields?.length ? ` (${c.changed_fields.map(label).join(', ')})` : ''}</p>
                  ))}</div>}
                </div>
              )}
            </div>
          );
        })}
      </Section>
      <Section title="Top-ups">
        {(p.topups ?? []).length === 0 ? <Empty>No top-ups.</Empty> : p.topups!.map((t) => (
          <Row key={t.id} left={ugx(t.amount)} sub={`${fdate(t.created_at)} · effective ${fdate(t.effective_at)}`} right={<Badge variant="outline" className="text-[9px]">{label(t.status)}</Badge>} />
        ))}
      </Section>
      <Section title="Returns movements">
        {(p.returns ?? []).length === 0 ? <Empty>No Returns movements.</Empty> : (
          <div className="max-h-60 overflow-y-auto">{p.returns!.map((r) => (
            <Row key={r.id} left={r.description || label(r.category).replace(/roi/gi, 'Returns')} sub={fdate(r.created_at, 'd MMM yyyy, HH:mm')}
              right={<span className={r.direction === 'cash_in' ? 'text-primary' : 'text-destructive'}>{r.direction === 'cash_in' ? '+' : '−'}{ugx(r.amount)}</span>} />
          ))}</div>
        )}
      </Section>
    </div>
  );
}

/* ---------------- panel ---------------- */
export function CalleeDossierPanel({ userId, callId }: { userId: string; callId: string | null }) {
  const { data: d, isLoading, error } = useCalleeDossier(userId);

  if (isLoading) return <div className="space-y-2 p-5">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-16 w-full" />)}</div>;
  if (error || !d) return <div className="p-5"><Empty>Could not load this person's details.</Empty></div>;

  const pr = d.profile;
  const tabs = [
    d.agent && { id: 'agent', label: d.kinds.sub_agent ? 'Sub-agent' : 'Agent', node: <AgentTab d={d} /> },
    d.proxy && { id: 'proxy', label: 'Proxy', node: <ProxyTab d={d} /> },
    d.tenant && { id: 'tenant', label: 'Tenant', node: <TenantTab d={d} /> },
    d.partner && { id: 'partner', label: 'Partner', node: <PartnerTab d={d} /> },
    { id: 'wallet', label: 'Wallet', node: <WalletTxnsSection d={d} /> },
  ].filter(Boolean) as { id: string; label: string; node: ReactNode }[];

  return (
    <div className="space-y-6 p-5 sm:p-7">
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)]">
        <Section title="Profile">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Stat k="Name" v={pr?.full_name ?? '—'} icon={UserRound} />
            <Stat k="Phone" v={pr?.phone ?? '—'} icon={Phone} />
            <Stat k="Email" v={pr?.email ?? '—'} icon={Mail} />
            <Stat k="Location" v={pr?.location ?? (pr?.landmark || 'Not recorded')} icon={MapPin} />
            <Stat k="Joined" v={fdate(pr?.joined_at)} icon={CalendarDays} />
            <Stat k="Last active" v={pr?.last_active_at ? formatDistanceToNow(new Date(pr.last_active_at), { addSuffix: true }) : 'Never'} icon={Clock3} />
          </div>
          {!!pr?.roles?.length && <div className="flex flex-wrap gap-1">{pr.roles.map((r) => <Badge key={r} variant="outline" className="text-[9px]">{label(r)}</Badge>)}</div>}
          {pr?.is_frozen && <Badge variant="destructive" className="text-[10px]">Account frozen</Badge>}
        </Section>

        <WalletSection d={d} />
      </div>

      <Tabs defaultValue={tabs[0].id}>
        <TabsList variant="underline" className="h-auto w-full justify-start gap-6 overflow-x-auto border-b border-border bg-transparent">
          {tabs.map((t) => <TabsTrigger key={t.id} value={t.id} variant="underline" className="py-3 text-xs">{t.label}</TabsTrigger>)}
        </TabsList>
        {tabs.map((t) => <TabsContent key={t.id} value={t.id} className="mt-5">{t.node}</TabsContent>)}
      </Tabs>

      <section className="rounded-lg border border-border bg-card p-4">
        <div className="mb-3 flex items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-md bg-destructive/10 text-destructive"><MessageSquareWarning className="h-4 w-4" /></span>
          <div>
            <h3 className="text-sm font-bold text-foreground">Record a complaint</h3>
            <p className="text-xs text-muted-foreground">Capture the issue and required follow-up.</p>
          </div>
        </div>
        <ComplaintEditor userId={userId} callId={callId} />
        {d.complaints.length > 0 && <div>{d.complaints.map((c) => (
          <div key={c.id} className="border-b border-border/60 py-2 last:border-0">
            <p className="whitespace-pre-wrap text-xs text-foreground">{c.body_text}</p>
            <p className="mt-0.5 text-[10px] text-muted-foreground">{c.recorded_by_name ?? 'Staff'} · {fdate(c.created_at, 'd MMM yyyy, HH:mm')}</p>
          </div>
        ))}</div>}
      </section>
    </div>
  );
}
