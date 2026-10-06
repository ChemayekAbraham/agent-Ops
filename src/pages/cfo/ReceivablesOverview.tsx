import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowLeft, LayoutGrid, Users, Handshake, Home, Building2, Package, FlaskConical } from 'lucide-react';
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { kampalaTodayYmd } from '@/lib/kampalaDays';
import { formatUGX } from '@/lib/rentCalculations';
import {
  useReceivablesBreakdown, useReceivablesPredictiveForecast, useTenantReceivablesByLocation,
  type ReceivablesForecast, type ReceivableProduct,
} from '@/hooks/useReceivables';

/**
 * CFO Receivables Overview workspace. Presentation only: every figure comes
 * from the authoritative receivables RPCs. Nothing here writes data.
 */

type SubDef = { key: string; label: string };
type CatDef = { key: string; label: string; icon: typeof Users; subs: SubDef[] };

const CATS: CatDef[] = [
  { key: 'agent', label: 'Agent Products & Services', icon: Users, subs: [
    { key: 'merchandise_recovery', label: 'Merchandise & Smartphone Recovery' },
    { key: 'agent_advance', label: 'Agent Advances' },
    { key: 'agent_advance_access_fee', label: 'Agent Advance Access Fees' },
    { key: 'bike_recovery', label: 'Bike Recoveries' },
    { key: 'credit_access_draw', label: 'Credit Access Draws' },
    { key: 'merchandise_credit_sale', label: 'Merchandise Credit Sales' },
  ] },
  { key: 'partner', label: 'Partner Products & Services', icon: Handshake, subs: [
    { key: 'promissory_note', label: 'Promissory Notes' },
  ] },
  { key: 'tenant', label: 'Tenant Products & Services', icon: Home, subs: [
    { key: 'rent_plan', label: 'Rent Access Plans' },
    { key: 'tenant_service_charge', label: 'Tenant Service Charges' },
    { key: 'business_advance', label: 'Business Advances' },
  ] },
  { key: 'landlord', label: 'Landlord Products & Services', icon: Building2, subs: [
    { key: 'welile_homes', label: 'Welile Homes Subscriptions' },
  ] },
  { key: 'other', label: 'Unclassified / Other', icon: Package, subs: [] },
  { key: 'rnd', label: 'R&D', icon: FlaskConical, subs: [] },
];

const money = (v: number | null | undefined) => (v == null ? '—' : formatUGX(v));
const compact = (n: number) => {
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return n.toFixed(0);
};

export default function ReceivablesOverview() {
  const [params, setParams] = useSearchParams();
  const catKey = params.get('cat') ?? 'overview';
  const subParam = params.get('sub');
  const go = (cat: string, sub?: string) => {
    const n = new URLSearchParams();
    if (cat !== 'overview') n.set('cat', cat);
    if (sub) n.set('sub', sub);
    setParams(n, { replace: true });
  };

  const breakdown = useReceivablesBreakdown();
  const live = breakdown.data?.categories ?? [];
  const liveCat = (k: string) => live.find((c) => c.key === k);

  const cats = CATS.map((c) => {
    const lc = liveCat(c.key);
    const extra = (lc?.products ?? []).filter((p) => !c.subs.some((s) => s.key === p.key))
      .map((p) => ({ key: p.key, label: p.label }));
    return { ...c, subs: [...c.subs, ...extra], outstanding: lc?.outstanding ?? 0, count: lc?.item_count ?? 0 };
  });
  const cat = cats.find((c) => c.key === catKey);
  const subKey = cat ? (subParam && cat.subs.some((s) => s.key === subParam) ? subParam : cat.subs[0]?.key) : undefined;
  const sub = cat?.subs.find((s) => s.key === subKey);
  const product = cat && subKey ? liveCat(cat.key)?.products.find((p) => p.key === subKey) : undefined;

  return (
    <main className="min-h-screen bg-muted/30">
      <div className="mx-auto max-w-[1400px] px-4 sm:px-8 py-8">
        <header className="mb-8">
          <Link to="/cfo/dashboard" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-3 w-3" /> CFO dashboard
          </Link>
          <h1 className="mt-2 text-2xl font-semibold">Receivables Overview</h1>
          <p className="text-xs text-muted-foreground">Read-only · as at {breakdown.data?.as_at?.slice(0, 10) ?? '—'} · UGX</p>
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-6">
          <nav aria-label="Receivable categories" className="rounded-2xl border border-border/70 bg-card p-2 h-fit lg:sticky lg:top-6">
            <SideItem active={catKey === 'overview'} icon={LayoutGrid} label="Overview"
              value={breakdown.data?.total} onClick={() => go('overview')} />
            {cats.map((c) => (
              <SideItem key={c.key} active={catKey === c.key} icon={c.icon} label={c.label}
                value={c.outstanding} onClick={() => go(c.key)} />
            ))}
          </nav>

          <div className="min-w-0 space-y-6">
            {breakdown.isLoading ? (
              <Card><p className="text-sm text-muted-foreground">Loading live receivables…</p></Card>
            ) : !cat ? (
              <Overview cats={cats} products={(k) => liveCat(k)?.products ?? []} onOpen={go} total={breakdown.data?.total ?? 0} />
            ) : (
              <>
                <div>
                  <h2 className="text-lg font-semibold">{cat.label}</h2>
                  <p className="text-xs text-muted-foreground">{formatUGX(cat.outstanding)} · {cat.count.toLocaleString()} items</p>
                </div>
                {cat.subs.length === 0 ? (
                  <Card><p className="text-sm text-muted-foreground">No receivable products are recorded under this category yet.</p></Card>
                ) : (
                  <>
                    <div role="tablist" className="inline-flex flex-wrap gap-1 rounded-xl border border-border/70 bg-card p-1">
                      {cat.subs.map((s) => (
                        <button key={s.key} role="tab" aria-selected={s.key === subKey} onClick={() => go(cat.key, s.key)}
                          className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${s.key === subKey
                            ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground hover:bg-muted'}`}>
                          {s.label}
                        </button>
                      ))}
                    </div>
                    {sub && <SubDetail key={sub.key} catKey={cat.key} label={sub.label} productKey={sub.key} product={product} />}
                  </>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}

function SideItem({ active, icon: Icon, label, value, onClick }: {
  active: boolean; icon: typeof Users; label: string; value?: number; onClick: () => void;
}) {
  return (
    <button type="button" onClick={onClick} aria-current={active ? 'page' : undefined}
      className={`w-full flex items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors ${active ? 'bg-primary/10 text-primary' : 'hover:bg-muted text-foreground'}`}>
      <Icon className="h-4 w-4 shrink-0" />
      <span className="flex-1 min-w-0">
        <span className="block text-sm font-medium truncate">{label}</span>
        {value !== undefined && <span className="block text-[11px] text-muted-foreground tabular-nums">UGX {compact(value)}</span>}
      </span>
    </button>
  );
}

function Card({ title, right, children }: { title?: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-border/70 bg-card p-5 shadow-sm min-w-0">
      {title && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">{title}</h3>{right}
        </div>
      )}
      {children}
    </section>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-2xl border border-border/70 bg-card p-4 shadow-sm min-w-0">
      <p className="text-[11px] uppercase text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums break-words">{value}</p>
      {sub && <p className="text-[11px] text-muted-foreground">{sub}</p>}
    </div>
  );
}

function Overview({ cats, products, onOpen, total }: {
  cats: (CatDef & { outstanding: number; count: number })[];
  products: (k: string) => ReceivableProduct[]; onOpen: (c: string, s?: string) => void; total: number;
}) {
  return (
    <>
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
        <Stat label="Total receivables" value={formatUGX(total)} sub={`${cats.reduce((s, c) => s + c.count, 0).toLocaleString()} open items`} />
      </div>
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        {cats.map((c) => (
          <Card key={c.key} title={c.label} right={
            <button onClick={() => onOpen(c.key)} className="text-xs font-medium text-primary hover:underline">{formatUGX(c.outstanding)}</button>
          }>
            {c.subs.length === 0 ? (
              <p className="text-xs text-muted-foreground">No products recorded.</p>
            ) : (
              <ul className="divide-y divide-border/60">
                {c.subs.map((s) => {
                  const p = products(c.key).find((x) => x.key === s.key);
                  return (
                    <li key={s.key}>
                      <button onClick={() => onOpen(c.key, s.key)} className="w-full flex items-center justify-between gap-3 py-2.5 text-left hover:text-primary">
                        <span className="text-sm">{s.label}</span>
                        <span className="text-xs text-muted-foreground tabular-nums whitespace-nowrap">
                          {p ? `${formatUGX(p.outstanding)} · ${p.item_count}` : 'No live balance'}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        ))}
      </div>
    </>
  );
}

function SubDetail({ catKey, label, productKey, product }: {
  catKey: string; label: string; productKey: string; product?: ReceivableProduct;
}) {
  const t = kampalaTodayYmd();
  const items = useMemo(() => product?.items ?? [], [product]);
  const complete = !!product && items.length === product.item_count;
  const overdue = complete ? items.filter((i) => i.due_date && i.due_date < t).reduce((s, i) => s + i.amount, 0) : undefined;
  const current = overdue !== undefined && product ? Math.max(0, product.outstanding - overdue) : undefined;

  const upcoming = useMemo(() => items.filter((i) => i.due_date).sort((a, b) => (a.due_date! < b.due_date! ? -1 : 1)).slice(0, 8), [items]);
  const bySource = useMemo(() => {
    const m = new Map<string, { amount: number; n: number }>();
    for (const i of items) { const e = m.get(i.source) ?? { amount: 0, n: 0 }; e.amount += i.amount; e.n++; m.set(i.source, e); }
    return [...m.entries()].sort((a, b) => b[1].amount - a[1].amount);
  }, [items]);

  const isTenant = catKey === 'tenant';
  const loc = useTenantReceivablesByLocation({ level: 'region', productKey }, isTenant && !!product);

  const fc = useReceivablesPredictiveForecast('day', 7).data;
  const ideal = useQuery({
    queryKey: ['receivables-overview-ideal-7d', fc?.as_at],
    enabled: !!fc,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => Promise.all((fc?.periods ?? []).map(async (p) => {
      const { data, error } = await supabase.rpc('get_receivables_forecast', { p_from: p.forecast_from, p_to: p.period_end });
      if (error) throw error;
      return data as unknown as ReceivablesForecast;
    })),
  });
  const stream = fc?.streams.find((s) => s.category_key === catKey && s.product_key === productKey);
  const hasBehaviour = !!stream && !stream.insufficient_data;
  const proj = (fc?.periods ?? []).map((p, i) => ({
    label: p.label,
    behaviour: hasBehaviour ? p.sources.filter((s) => s.product_key === productKey && s.basis === 'modelled').reduce((a, s) => a + s.runoff, 0) : null,
    ideal: ideal.data?.[i]?.products.filter((s) => s.product_key === productKey).reduce((a, s) => a + s.scheduled, 0) ?? null,
  }));
  const bTotal = hasBehaviour ? proj.reduce((a, p) => a + (p.behaviour ?? 0), 0) : null;
  const iTotal = ideal.data ? proj.reduce((a, p) => a + (p.ideal ?? 0), 0) : null;

  if (!product) {
    return <Card title={label}><p className="text-sm text-muted-foreground">No live outstanding balance is recorded for {label} yet.</p></Card>;
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <Stat label="Outstanding" value={formatUGX(product.outstanding)} />
        <Stat label="Accounts" value={product.item_count.toLocaleString()} />
        <Stat label="Current" value={current === undefined ? 'Unavailable' : formatUGX(current)} sub="Not yet due" />
        <Stat label="Overdue" value={overdue === undefined ? 'Unavailable' : formatUGX(overdue)} sub={complete ? 'Past due date' : 'Item list sampled'} />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <Card title="Upcoming due dates">
          {upcoming.length === 0 ? <p className="text-xs text-muted-foreground">No dated items.</p> : (
            <ul className="divide-y divide-border/60">
              {upcoming.map((i) => (
                <li key={i.item_id} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <span className="min-w-0 truncate">{i.counterparty ?? '—'}</span>
                  <span className="text-xs text-muted-foreground whitespace-nowrap">{i.due_date}{i.due_date! < t && <span className="ml-2 text-destructive">overdue</span>}</span>
                  <span className="tabular-nums whitespace-nowrap">{formatUGX(i.amount)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title={isTenant ? 'Location breakdown' : 'Source breakdown'}>
          {isTenant && loc.data ? (
            <ul className="divide-y divide-border/60">
              {loc.data.rows.map((r) => (
                <li key={r.label} className="flex items-center justify-between py-2 text-sm">
                  <span>{r.label}</span>
                  <span className="tabular-nums">{formatUGX(r.outstanding)} <span className="text-xs text-muted-foreground">· {r.tenant_count}</span></span>
                </li>
              ))}
            </ul>
          ) : bySource.length === 0 ? <p className="text-xs text-muted-foreground">No items.</p> : (
            <ul className="divide-y divide-border/60">
              {bySource.map(([s, v]) => (
                <li key={s} className="flex items-center justify-between py-2 text-sm">
                  <span className="truncate">{s}</span>
                  <span className="tabular-nums">{formatUGX(v.amount)} <span className="text-xs text-muted-foreground">· {v.n}</span></span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card title="7-day forecast · behaviour-based vs ideal" right={
        <span className="text-xs text-muted-foreground">Behaviour {money(bTotal)} · Ideal {money(iTotal)}</span>
      }>
        {!hasBehaviour && <p className="mb-2 text-xs text-muted-foreground">Not enough collection history for a behaviour-based forecast; ideal schedule shown.</p>}
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={proj} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" tickLine={false} axisLine={false} />
              <YAxis tickFormatter={(v) => `UGX ${compact(v)}`} tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" tickLine={false} axisLine={false} width={70} />
              <Tooltip formatter={(v: number) => formatUGX(v)} contentStyle={{ fontSize: 12, borderRadius: 8 }} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Line type="monotone" dataKey="ideal" name="Ideal (scheduled)" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="behaviour" name="Behaviour-based" stroke="hsl(var(--success))" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </Card>
    </div>
  );
}
