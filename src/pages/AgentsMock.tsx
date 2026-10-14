import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useNavigate } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import { ArrowRight, Bell, Building2, Calculator, CheckCircle2, ChevronLeft, ChevronRight, FileText, Plus, Home, Menu, Store, Trophy, Users, Wallet, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import RentCalculatorDialog from '@/components/agent/RentCalculatorDialog';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { COMMISSION_RATE, LANDLORD_PAYOUT_COMMISSION_RATE, formatUGX } from '@/lib/rentCalculations';
import { cn } from '@/lib/utils';
import { useProfile } from '@/hooks/useProfile';
import { useAuth } from '@/hooks/useAuth';
import { useAgentCapacityMap } from '@/hooks/useAgentCapacityMap';
import { useAgentArrears } from '@/hooks/useAgentArrears';

const SHORTCUTS: { label: string; Icon: LucideIcon; color: string; to?: string }[] = [
  { label: 'Calculator', Icon: Calculator, color: 'text-primary', },
  { label: 'Service Center', Icon: Store, color: 'text-info', to: '/agent/service-center' },
  { label: 'Leaderboard', Icon: Trophy, color: 'text-success', to: '/dashboard/agents/leaderboard' },
  { label: 'Landlord Float', Icon: Building2, color: 'text-warning' },
];

/**
 * The three moments an agent is paid for a Rent Plan they posted. The two
 * percentages are read from the same constants the payout paths use, so this
 * card can't drift from what the backend actually pays.
 */
const POST_EARNINGS: { label: string; when: string; tone: 'primary' | 'warning' | 'success' }[] = [
  { label: 'UGX 5,000', when: 'when you post the request', tone: 'primary' },
  { label: `${Math.round(LANDLORD_PAYOUT_COMMISSION_RATE * 100)}%`, when: 'when the landlord is paid', tone: 'warning' },
  { label: `${Math.round(COMMISSION_RATE * 100)}%`, when: 'when the tenant starts to pay', tone: 'success' },
];

const EARN_TONES = {
  primary: { chip: 'bg-primary/10 text-primary', text: 'text-primary' },
  warning: { chip: 'bg-warning/10 text-warning', text: 'text-warning' },
  success: { chip: 'bg-success/10 text-success', text: 'text-success' },
} as const;

export default function AgentsMock() {
  const { profile } = useProfile();
  const { user } = useAuth();
  const ids = useMemo(() => (user?.id ? [user.id] : []), [user?.id]);
  const { data: capMap } = useAgentCapacityMap(ids);
  const cap = user?.id ? capMap?.get(user.id) : undefined;
  const EXPECTED_TODAY = Math.max(0, cap?.expected_daily ?? 0);
  const TENANTS_TOTAL = cap?.tenants_due ?? 0;
  // Today's collection list comes from the same server read the Collect dialog
  // uses (`agent_arrears_overview`), so the names and amounts here are the
  // tenant's own open days — never a placeholder.
  const { data: arrears, isLoading: arrearsLoading, isError: arrearsFailed } = useAgentArrears(user?.id);
  const DUE_LIST = useMemo(() => arrears?.tenants ?? [], [arrears]);
  const DUE_TOTAL = DUE_LIST.reduce((s, t) => s + (Number(t.due_today_ugx) || 0), 0);
  const [tenantFilter, setTenantFilter] = useState<'repaying' | 'paid'>('repaying');
  const [period, setPeriod] = useState<'today' | 'month'>('today');
  const [detailPage, setDetailPage] = useState(0);
  const firstLetter = (name?: string | null) => (name || 'T').trim().charAt(0).toUpperCase() || 'T';
  const initials = (profile?.full_name || '').trim().split(/\s+/).slice(0, 2).map(w => w[0]?.toUpperCase() ?? '').join('') || 'SP';
  const [brokenAvatar, setBrokenAvatar] = useState<string | null>(null);
  // The photos folder is private, so the saved "public" link 404s. Turn the
  // saved link into a short-lived signed link for the same file instead.
  const avatarPath = useMemo(() => {
    const raw = profile?.avatar_url;
    if (!raw) return null;
    const m = raw.match(/\/avatars\/([^?]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }, [profile?.avatar_url]);
  const { data: signedAvatar } = useQuery({
    queryKey: ['agents-mock-avatar', avatarPath],
    enabled: !!avatarPath,
    staleTime: 50 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.storage.from('avatars').createSignedUrl(avatarPath ?? '', 3600);
      if (error) throw error;
      return data.signedUrl;
    },
  });
  const avatarSrc = signedAvatar ?? (avatarPath ? null : profile?.avatar_url ?? null);
  const [activeNav, setActiveNav] = useState('Home');
  const [notice, setNotice] = useState<string | null>(null);
  const [calcOpen, setCalcOpen] = useState(false);
  const navigate = useNavigate();
  const kampalaNow = new Date(Date.now() + 3 * 3600_000);
  const [month, setMonth] = useState(new Date(kampalaNow.getUTCFullYear(), kampalaNow.getUTCMonth(), 1));
  const [day, setDay] = useState(kampalaNow.getUTCDate());
  const monthLabel = month.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const offset = month.getDay();
  const moveMonth = (delta: number) => { setMonth(new Date(month.getFullYear(), month.getMonth() + delta, 1)); setDay(1); setDetailPage(0); };
  // Real collections for the visible month (Kampala days), non-reversed only.
  const monthKey = `${month.getFullYear()}-${month.getMonth()}`;
  const { data: monthRows, isLoading: collectionsLoading, isError: collectionsFailed } = useQuery({
    queryKey: ['agents-mock-month-collections', user?.id, monthKey],
    enabled: !!user?.id,
    staleTime: 60_000,
    queryFn: async () => {
      if (!user?.id) return [];
      const from = new Date(Date.UTC(month.getFullYear(), month.getMonth(), 1) - 3 * 3600_000).toISOString();
      const to = new Date(Date.UTC(month.getFullYear(), month.getMonth() + 1, 1) - 3 * 3600_000).toISOString();
      const { data, error } = await supabase.from('agent_collections')
        .select('id, tenant_id, amount, expected_amount, is_partial, created_at, momo_payer_name, momo_phone')
        .eq('agent_id', user?.id ?? '').is('reversed_at', null)
        .gte('created_at', from).lt('created_at', to).limit(5000);
      if (error) throw error;
      return data ?? [];
    },
  });
  const byDay = useMemo(() => {
    const m = new Map<number, { total: number; count: number; partial: boolean }>();
    (monthRows ?? []).forEach(r => {
      const d = new Date(new Date(r.created_at).getTime() + 3 * 3600_000).getUTCDate();
      const e = m.get(d) ?? { total: 0, count: 0, partial: false };
      e.total += Number(r.amount) || 0; e.count += 1; e.partial = e.partial || !!r.is_partial;
      m.set(d, e);
    });
    return m;
  }, [monthRows]);
  // What the agent was expected to collect each day: the nightly eligibility
  // history (agent_daily_eligibility_history) holds expected_daily per day.
  const monthStart = `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, '0')}-01`;
  const monthEndKey = `${month.getMonth() + 1 === 12 ? month.getFullYear() + 1 : month.getFullYear()}-${String(month.getMonth() + 2 > 12 ? 1 : month.getMonth() + 2).padStart(2, '0')}-01`;
  const { data: historyRows, isLoading: historyLoading, isError: historyFailed } = useQuery({
    queryKey: ['agents-mock-month-expected', user?.id, monthKey],
    enabled: !!user?.id,
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.from('agent_daily_eligibility_history')
        .select('day, expected_daily, paid')
        .eq('agent_id', user?.id ?? '')
        .gte('day', monthStart).lt('day', monthEndKey).limit(500);
      if (error) throw error;
      return data ?? [];
    },
  });
  const expectedByDay = useMemo(() => {
    const m = new Map<string, number>();
    (historyRows ?? []).forEach(r => m.set(String(r.day), Number(r.expected_daily) || 0));
    return m;
  }, [historyRows]);
  // Kampala "today" — the same +3h day boundary the collections query uses.
  const todayKey = new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);
  const dayStatus = (dayNum: number): 'paid' | 'partial' | 'missed' | null => {
    const dateKey = `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, '0')}-${String(dayNum).padStart(2, '0')}`;
    const expected = dateKey === todayKey ? EXPECTED_TODAY : (expectedByDay.get(dateKey) ?? 0);
    if (expected <= 0) return null;
    const collected = byDay.get(dayNum)?.total ?? 0;
    if (collected >= expected) return 'paid';
    if (collected > 0) return 'partial';
    // Nothing collected on a day that had an expectation. Today isn't a miss
    // until it ends; only finished days are marked.
    return dateKey < todayKey ? 'missed' : null;
  };
  const DAY_STYLES: Record<'paid' | 'partial' | 'missed', string> = {
    paid: 'bg-success text-success-foreground',
    partial: 'bg-success/35 text-foreground',
    missed: 'bg-destructive text-destructive-foreground',
  };
  const selected = byDay.get(day);
  const monthlyExpected = (historyRows ?? []).reduce((sum, row) => sum + (row.day === todayKey ? 0 : Number(row.expected_daily) || 0), 0)
    + (todayKey.startsWith(monthStart.slice(0, 7)) ? EXPECTED_TODAY : 0);
  const monthlyCollected = (monthRows ?? []).reduce((sum, row) => sum + Number(row.amount), 0);
  const expected = period === 'today' ? EXPECTED_TODAY : monthlyExpected;
  const collected = period === 'today' ? cap?.paid_today ?? 0 : monthlyCollected;
  const selectedRows = (monthRows ?? []).filter(row => new Date(new Date(row.created_at).getTime() + 3 * 3600_000).getUTCDate() === day);
  const detailRows = selectedRows.slice(detailPage * 10, detailPage * 10 + 10);
  const todayPaidCount = cap?.tenants_paid_today ?? 0;
  const openRequest = () => navigate('/dashboard/agent?action=post-rent-request');
  const dateLabel = new Date(month.getFullYear(), month.getMonth(), day).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  return (
    <div className="agents-mock-exact min-h-screen pb-24 font-sans text-foreground tracking-normal">
      <Helmet><title>Agent dashboard · Welile</title><meta name="robots" content="noindex,nofollow" /></Helmet>
      <div className="mx-auto max-w-2xl">
        <header className="flex items-center justify-between gap-3 px-5 py-5">
          <div className="min-w-0"><p className="text-xs text-muted-foreground">Welcome back</p><h1 className="truncate text-xl font-semibold">{profile?.full_name?.split(' ')[0] || 'Your dashboard'}</h1></div>
          <div className="flex gap-2"><Button variant="ghost" size="icon" aria-label="Notifications" onClick={() => setNotice('Notifications')}><Bell className="h-5 w-5" /></Button><Button variant="outline" size="icon" aria-label="Your profile" onClick={() => setNotice('Your profile')} className="overflow-hidden rounded-full">{avatarSrc && brokenAvatar !== avatarSrc ? <img src={avatarSrc} alt="" onError={() => setBrokenAvatar(avatarSrc)} className="h-full w-full object-cover" /> : initials}</Button></div>
        </header>
        <main className="space-y-7 px-5">
          <section aria-labelledby="post-cta-heading" className="border-b border-border pb-6">
            <div className="mb-3 flex items-center justify-between"><h2 id="post-cta-heading" className="text-lg font-semibold">Post a rent request</h2><FileText className="h-5 w-5 text-primary" /></div>
            <div className="mb-4 grid grid-cols-3 gap-3">{POST_EARNINGS.map(e => <div key={e.when} className="min-w-0"><p className={cn('text-lg font-bold', EARN_TONES[e.tone].text)}>{e.label}</p><p className="mt-1 text-xs leading-4 text-muted-foreground">{e.when}</p></div>)}</div>
            <Button onClick={openRequest} className="h-12 w-full justify-between rounded-lg px-4 text-sm font-semibold"><span className="flex items-center gap-2"><Plus className="h-5 w-5" />Post Rent Request</span><ArrowRight className="h-5 w-5" /></Button>
          </section>
          <section aria-label="Collection summary" className="rounded-lg border border-border bg-card p-5">
            <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="font-semibold">Collections</h2><div className="flex rounded-lg bg-muted p-1" aria-label="Collection period">{(['today', 'month'] as const).map(p => <Button key={p} variant="ghost" aria-pressed={period === p} onClick={() => setPeriod(p)} className={cn('h-10 rounded-md px-3 text-xs', period === p && 'bg-card shadow-sm')}>{p === 'today' ? 'Today' : 'This Month'}</Button>)}</div></div>
            <div className="mt-5 grid grid-cols-2 gap-4"><div><p className="text-xs text-muted-foreground">Collected</p><p className="mt-1 break-words text-xl font-bold text-success tabular-nums">{period === 'month' && (collectionsFailed || collectionsLoading) ? (collectionsFailed ? 'Unavailable' : 'Loading…') : formatUGX(collected)}</p></div><div className="border-l border-border pl-4"><p className="text-xs text-muted-foreground">Expected</p><p className="mt-1 break-words text-xl font-semibold tabular-nums">{period === 'month' && (historyFailed || historyLoading) ? (historyFailed ? 'Unavailable' : 'Loading…') : formatUGX(expected)}</p></div></div>
            <div className="mt-5 flex items-center gap-2 border-t border-border pt-4 text-sm"><Users className="h-4 w-4 text-primary" /><span><strong>{period === 'today' ? TENANTS_TOTAL : new Set((monthRows ?? []).map(r => r.tenant_id)).size}</strong> {period === 'today' ? 'tenants to collect for' : 'tenants collected for'}</span>{period === 'today' && <span className="ml-auto text-xs text-muted-foreground">{todayPaidCount} paid</span>}</div>
          </section>
          <section aria-label="Agent shortcuts" className="grid grid-cols-4 gap-2">{SHORTCUTS.map(({ label, Icon, color, to }) => <Button key={label} variant="ghost" onClick={() => to ? navigate(to) : label === 'Calculator' ? setCalcOpen(true) : setNotice(label)} className="h-auto min-h-20 flex-col gap-2 whitespace-normal px-1 text-center text-xs"><span className={cn('flex h-11 w-11 items-center justify-center rounded-full border border-border bg-card', color)}><Icon className="!h-5 !w-5" /></span>{label}</Button>)}</section>
          <section aria-labelledby="due-heading" className="border-y border-border py-5">
            <div className="flex items-center justify-between"><h2 id="due-heading" className="text-base font-semibold">Today's tenants</h2><Users className="h-5 w-5 text-muted-foreground" /></div>
            <div className="mt-4 grid grid-cols-2 gap-2">{(['repaying', 'paid'] as const).map(f => <Button key={f} variant={tenantFilter === f ? 'secondary' : 'ghost'} aria-pressed={tenantFilter === f} onClick={() => setTenantFilter(f)} className="h-11 justify-between rounded-lg capitalize">{f}<span className="text-xs tabular-nums">{f === 'repaying' ? DUE_LIST.length : todayPaidCount}</span></Button>)}</div>
            {arrearsLoading ? <p className="py-5 text-sm text-muted-foreground">Loading tenants…</p> : arrearsFailed ? <p className="py-5 text-sm text-destructive">Tenant counts are unavailable.</p> : <div className="mt-5 flex items-center justify-between"><div><p className="text-3xl font-semibold tabular-nums">{tenantFilter === 'repaying' ? DUE_LIST.length : todayPaidCount}</p><p className="mt-1 text-sm text-muted-foreground">{tenantFilter === 'repaying' ? 'tenants still to pay' : 'tenants paid today'}</p></div><Button variant="outline" className="h-11 gap-2" onClick={() => setNotice(tenantFilter === 'repaying' ? 'Repaying tenants' : 'Paid tenants')}>View tenants<ChevronRight className="h-4 w-4" /></Button></div>}
          </section>
          <section aria-labelledby="calendar-heading">
            <div className="flex items-center justify-between"><h2 id="calendar-heading" className="text-base font-semibold">Repayment calendar</h2></div>
            <div className="my-4 flex items-center justify-between"><Button variant="ghost" size="icon" aria-label="Previous month" onClick={() => moveMonth(-1)}><ChevronLeft className="h-5 w-5" /></Button><h3 className="text-sm font-semibold">{monthLabel}</h3><Button variant="ghost" size="icon" aria-label="Next month" onClick={() => moveMonth(1)}><ChevronRight className="h-5 w-5" /></Button></div>
            {(collectionsFailed || historyFailed) && <p className="mb-3 text-xs text-destructive">Calendar records could not be fully loaded.</p>}
            <div className="grid grid-cols-7 gap-y-1 text-center">{['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map(label => <span key={label} className="pb-3 text-xs text-muted-foreground">{label}</span>)}{Array.from({ length: offset }, (_, i) => <span key={`blank-${i}`} />)}{Array.from({ length: days }, (_, i) => { const st = dayStatus(i + 1); const isToday = `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}` === todayKey; return <Button key={i} variant="ghost" aria-label={`${monthLabel} ${i + 1}${st ? ` · ${st}` : ''}`} aria-pressed={day === i + 1} onClick={() => { setDay(i + 1); setDetailPage(0); }} className="h-11 w-full rounded-lg p-0 text-sm"><span className={cn('flex h-9 w-9 items-center justify-center rounded-lg font-medium', st && DAY_STYLES[st], isToday && 'border border-primary', day === i + 1 && 'ring-2 ring-primary ring-offset-2 ring-offset-background')}>{i + 1}</span></Button>; })}</div>
            <div className="mt-5 flex flex-wrap gap-4 text-xs text-muted-foreground">{[{ name: 'Paid', color: 'bg-success' }, { name: 'Partial', color: 'bg-success/35' }, { name: 'Missed', color: 'bg-destructive' }].map(item => <span key={item.name} className="flex items-center gap-2"><span className={cn('h-2.5 w-2.5 rounded-full', item.color)} />{item.name}</span>)}</div>
            <div aria-live="polite" className="mt-5 border-t border-border pt-5"><div className="flex flex-wrap justify-between gap-2"><h3 className="text-sm font-semibold">{dateLabel}</h3><span className="text-sm font-semibold text-success">{formatUGX(selected?.total ?? 0)}</span></div>
              {detailRows.length ? <ul className="mt-3 divide-y divide-border">{detailRows.map(row => <li key={row.id} className="flex items-center gap-3 py-3"><span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">{firstLetter(row.momo_payer_name)}</span><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{row.momo_payer_name || 'Recorded payer'}</p><p className="text-xs text-muted-foreground">{row.momo_phone || 'Phone not recorded'}</p></div><div className="text-right"><p className="text-sm font-semibold tabular-nums">{formatUGX(row.amount)}</p><p className="text-xs text-muted-foreground">{row.is_partial ? 'Partial payment' : 'Payment recorded'}</p></div></li>)}</ul> : <p className="py-5 text-sm text-muted-foreground">{collectionsLoading ? 'Loading collections…' : collectionsFailed ? 'Collections unavailable.' : dayStatus(day) === 'missed' ? 'No payments recorded. Individual missed-tenant details are not available for this date.' : 'No collections recorded for this date.'}</p>}
              {selectedRows.length > 0 && <div className="mt-3 flex flex-wrap items-center justify-between gap-3"><p className="text-xs text-muted-foreground">Showing {detailPage * 10 + 1}–{Math.min((detailPage + 1) * 10, selectedRows.length)} of {selectedRows.length} collections</p><div className="flex gap-2"><Button variant="outline" size="icon" aria-label="Previous results" disabled={detailPage === 0} onClick={() => setDetailPage(p => p - 1)}><ChevronLeft className="h-4 w-4" /></Button><Button variant="outline" size="icon" aria-label="Next results" disabled={(detailPage + 1) * 10 >= selectedRows.length} onClick={() => setDetailPage(p => p + 1)}><ChevronRight className="h-4 w-4" /></Button></div></div>}
            </div>
          </section>
        </main>
      </div>
      <nav aria-label="Agent navigation" className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-card pb-safe"><div className="mx-auto grid max-w-2xl grid-cols-5 px-2 py-2">{[{ label: 'Home', Icon: Home }, { label: 'Tenants', Icon: Users }, { label: 'Collect', Icon: Wallet }, { label: 'Post Rent', Icon: FileText }, { label: 'More', Icon: Menu }].map(({ label, Icon }) => <Button key={label} variant="ghost" aria-current={activeNav === label ? 'page' : undefined} onClick={() => { if (label === 'Post Rent') { openRequest(); return; } setActiveNav(label); if (label === 'Home') window.scrollTo({ top: 0, behavior: 'smooth' }); else setNotice(label); }} className={cn('h-14 flex-col gap-1 rounded-lg px-0 text-xs', activeNav === label ? 'text-primary' : 'text-muted-foreground')}><Icon className="!h-5 !w-5" strokeWidth={1.8} /><span>{label}</span></Button>)}</div></nav>
      <RentCalculatorDialog open={calcOpen} onOpenChange={setCalcOpen} />
      <Dialog open={notice !== null} onOpenChange={open => { if (!open) setNotice(null); }}><DialogContent><DialogHeader><DialogTitle>{notice}</DialogTitle><DialogDescription>{notice?.includes('tenants') || notice === 'Tenants' ? 'Tenant details' : 'Agent dashboard'}</DialogDescription></DialogHeader>{notice === 'Paid tenants' ? <p className="text-sm text-muted-foreground">{todayPaidCount} tenants paid today. Individual paid-tenant details are not available in this view.</p> : notice?.includes('tenants') || notice === 'Tenants' ? <ul className="max-h-80 overflow-y-auto divide-y divide-border">{DUE_LIST.map(t => <li key={t.rent_request_id} className="py-3"><p className="text-sm font-medium">{t.tenant_name || 'Tenant'}</p><p className="text-sm text-muted-foreground">{t.tenant_phone || 'Phone not recorded'}</p></li>)}</ul> : <p className="text-sm text-muted-foreground">No transactions have been made.</p>}</DialogContent></Dialog>
    </div>
  );
}
