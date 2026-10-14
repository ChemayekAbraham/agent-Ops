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
import { TenantProfileView } from '@/components/agent/TenantProfileView';

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
  const [tenantPage, setTenantPage] = useState(0);
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
  const [selectedTenantId, setSelectedTenantId] = useState<string | null>(null);
  const { data: tenantRows = [], isLoading: tenantsLoading, isError: tenantsFailed } = useQuery({
    queryKey: ['agents-mock-tenant-overview', user?.id, todayKey],
    enabled: Boolean(user?.id),
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_agent_tenants_overview', { p_today_start: `${todayKey}T00:00:00+03:00` });
      if (error) throw error;
      return data ?? [];
    },
  });
  const liveTenants = tenantRows.filter(t => t.statuses?.some(status => ['repaying', 'funded', 'disbursed'].includes(status)));
  const payingTenants = liveTenants.filter(t => !t.payment_states?.length || t.payment_states.some(state => state !== 'not_paying'));
  const paidTenants = payingTenants.filter(t => Number(t.today_paid_amount) > 0);
  const displayTenants = tenantFilter === 'paid' ? paidTenants : payingTenants;
  const tenantIds = tenantRows.map(t => t.id);
  const { data: tenantPhotos = {} } = useQuery({
    queryKey: ['agents-mock-tenant-photos', user?.id, tenantIds.join(',')],
    enabled: tenantIds.length > 0,
    staleTime: 50 * 60_000,
    queryFn: async () => {
      const { data } = await supabase.from('profiles').select('id, avatar_url').in('id', tenantIds);
      const photos: Record<string, string> = {};
      await Promise.all((data ?? []).map(async row => {
        if (!row.avatar_url) return;
        const match = row.avatar_url.match(/\/avatars\/([^?]+)/);
        if (match?.[1]) {
          const { data: signed } = await supabase.storage.from('avatars').createSignedUrl(decodeURIComponent(match[1]), 3600);
          if (signed?.signedUrl) photos[row.id] = signed.signedUrl;
        } else photos[row.id] = row.avatar_url;
      }));
      return photos;
    },
  });
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
      <div className="mx-auto max-w-6xl">
        <header className="flex items-center justify-between gap-3 px-4 py-4 sm:px-6">
          <div className="min-w-0"><p className="text-xs text-muted-foreground">Welcome back</p><h1 className="truncate text-xl font-semibold">{profile?.full_name?.split(' ')[0] || 'Your dashboard'}</h1></div>
          <div className="flex gap-2"><Button variant="ghost" size="icon" aria-label="Notifications" onClick={() => setNotice('Notifications')}><Bell className="h-5 w-5" /></Button><Button variant="outline" size="icon" aria-label="Your profile" onClick={() => setNotice('Your profile')} className="overflow-hidden rounded-full">{avatarSrc && brokenAvatar !== avatarSrc ? <img src={avatarSrc} alt="" onError={() => setBrokenAvatar(avatarSrc)} className="h-full w-full object-cover" /> : initials}</Button></div>
        </header>
        <main className="space-y-4 px-4 sm:px-6">
          <section aria-labelledby="post-cta-heading" className="flex flex-wrap items-center justify-between gap-4 border-y border-border bg-primary/5 px-4 py-4">
            <div className="min-w-0"><h2 id="post-cta-heading" className="text-base font-semibold">A new Rent Plan for your tenant</h2><div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground"><span><strong className="font-semibold text-primary">UGX 5,000</strong> on posting</span><span><strong className="font-semibold text-warning">1%</strong> landlord paid</span><span><strong className="font-semibold text-success">10%</strong> on repayments</span></div></div>
            <Button onClick={openRequest} className="h-11 w-full gap-2 rounded-lg px-4 text-sm font-semibold sm:w-auto"><Plus className="h-4 w-4" />Post Rent Request<ArrowRight className="h-4 w-4" /></Button>
          </section>
          <section aria-label="Collection summary" className="border-b border-border bg-card pb-4 pt-1">
            <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="font-semibold">Collections</h2><div className="flex rounded-lg bg-muted p-1" aria-label="Collection period">{(['today', 'month'] as const).map(p => <Button key={p} variant="ghost" aria-pressed={period === p} onClick={() => setPeriod(p)} className={cn('h-10 rounded-md px-3 text-xs', period === p && 'bg-card shadow-sm')}>{p === 'today' ? 'Today' : 'This Month'}</Button>)}</div></div>
            <div className="mt-3 grid grid-cols-2 gap-4"><div><p className="text-xs text-muted-foreground">Collected</p><p className="mt-1 break-words text-xl font-bold text-success tabular-nums">{period === 'month' && (collectionsFailed || collectionsLoading) ? (collectionsFailed ? 'Unavailable' : 'Loading…') : formatUGX(collected)}</p></div><div className="border-l border-border pl-4"><p className="text-xs text-muted-foreground">Expected</p><p className="mt-1 break-words text-xl font-semibold tabular-nums">{period === 'month' && (historyFailed || historyLoading) ? (historyFailed ? 'Unavailable' : 'Loading…') : formatUGX(expected)}</p></div></div>
            <div className="mt-3 flex items-center gap-2 text-xs"><Users className="h-4 w-4 text-primary" /><span><strong>{period === 'today' ? TENANTS_TOTAL : new Set((monthRows ?? []).map(r => r.tenant_id)).size}</strong> {period === 'today' ? 'tenants to collect for' : 'tenants collected for'}</span>{period === 'today' && <span className="ml-auto text-xs text-muted-foreground">{todayPaidCount} paid</span>}</div>
          </section>
          <section aria-label="Agent shortcuts" className="grid grid-cols-2 gap-2 sm:grid-cols-4">{SHORTCUTS.map(({ label, Icon, color, to }) => <Button key={label} variant="ghost" onClick={() => to ? navigate(to) : label === 'Calculator' ? setCalcOpen(true) : setNotice(label)} className="h-12 justify-start gap-2 rounded-lg border border-border whitespace-normal px-3 text-left text-xs"><span className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted/50', color)}><Icon className="!h-5 !w-5" /></span>{label}</Button>)}</section>
          <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
          <section aria-labelledby="due-heading" className="min-w-0 border-t border-border pt-4">
            <div className="flex items-center justify-between gap-2"><h2 id="due-heading" className="text-base font-semibold">Today's tenants</h2><span className="text-xs text-muted-foreground">{payingTenants.length} repaying</span></div>
            <div className="mt-2 flex gap-1 border-b border-border pb-2">{(['repaying', 'paid'] as const).map(f => <Button key={f} variant={tenantFilter === f ? 'secondary' : 'ghost'} aria-pressed={tenantFilter === f} onClick={() => { setTenantFilter(f); setTenantPage(0); }} className="h-10 gap-2 rounded-md px-3 text-xs capitalize">{f}<span className="tabular-nums text-muted-foreground">{f === 'repaying' ? payingTenants.length : paidTenants.length}</span></Button>)}</div>
            {tenantsLoading ? <p className="py-5 text-sm text-muted-foreground">Loading tenants…</p> : tenantsFailed ? <p className="py-5 text-sm text-destructive">Tenant records could not be loaded.</p> : <>
              <ul className="divide-y divide-border">{displayTenants.slice(tenantPage * 10, tenantPage * 10 + 10).map(t => {
                const pct = t.total_repayment > 0 ? Math.min(100, Math.round(t.amount_repaid / t.total_repayment * 100)) : null;
                return <li key={t.id}><Button variant="ghost" onClick={() => setSelectedTenantId(t.id)} className="h-auto min-h-20 w-full justify-start gap-3 rounded-none px-0 py-3 text-left">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full bg-primary/10 text-sm font-semibold text-primary">{tenantPhotos[t.id] ? <img src={tenantPhotos[t.id]} alt="" className="h-full w-full object-cover" onError={e => { e.currentTarget.style.display = 'none'; }} /> : firstLetter(t.full_name)}</span>
                  <span className="min-w-0 flex-1 whitespace-normal"><span className="block break-words text-sm font-semibold">{t.full_name}</span><span className="mt-0.5 block text-xs font-normal text-muted-foreground">{t.phone || 'Phone not recorded'}</span><span className="mt-1 block text-[11px] font-normal text-muted-foreground">{tenantFilter === 'paid' ? 'Collected today' : 'Total repaid'} · {formatUGX(tenantFilter === 'paid' ? t.today_paid_amount : t.amount_repaid)}</span></span>
                  <span className="shrink-0 text-right"><span className="block text-sm font-semibold tabular-nums">{pct === null ? '—' : `${pct}%`}</span><span className="mt-0.5 block text-[11px] font-normal text-muted-foreground">repaid</span><ChevronRight className="ml-auto mt-1 h-3 w-3 text-muted-foreground" /></span>
                </Button></li>;
              })}</ul>
              {displayTenants.length === 0 && <p className="py-5 text-sm text-muted-foreground">{tenantFilter === 'paid' ? 'No tenant payments recorded today.' : 'No repaying tenants found.'}</p>}
              {displayTenants.length > 10 && <div className="flex items-center justify-between gap-2 border-t border-border py-3"><span className="text-xs text-muted-foreground">{tenantPage * 10 + 1}–{Math.min(tenantPage * 10 + 10, displayTenants.length)} of {displayTenants.length} tenants</span><div className="flex gap-1"><Button variant="outline" size="icon" aria-label="Previous tenants" disabled={tenantPage === 0} onClick={() => setTenantPage(p => p - 1)}><ChevronLeft className="h-4 w-4" /></Button><Button variant="outline" size="icon" aria-label="Next tenants" disabled={(tenantPage + 1) * 10 >= displayTenants.length} onClick={() => setTenantPage(p => p + 1)}><ChevronRight className="h-4 w-4" /></Button></div></div>}
            </>}
          </section>
          <section aria-labelledby="calendar-heading" className="mx-auto w-full max-w-[380px] border-t border-border pt-4 lg:max-w-none">
            <div className="flex items-center justify-between"><h2 id="calendar-heading" className="text-base font-semibold">Repayment calendar</h2></div>
            <div className="my-2 flex items-center justify-between"><Button variant="ghost" size="icon" aria-label="Previous month" onClick={() => moveMonth(-1)}><ChevronLeft className="h-5 w-5" /></Button><h3 className="text-sm font-semibold">{monthLabel}</h3><Button variant="ghost" size="icon" aria-label="Next month" onClick={() => moveMonth(1)}><ChevronRight className="h-5 w-5" /></Button></div>
            {(collectionsFailed || historyFailed) && <p className="mb-3 text-xs text-destructive">Calendar records could not be fully loaded.</p>}
            <div className="grid grid-cols-7 text-center">{['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map(label => <span key={label} className="pb-1 text-xs text-muted-foreground">{label}</span>)}{Array.from({ length: offset }, (_, i) => <span key={`blank-${i}`} />)}{Array.from({ length: days }, (_, i) => { const st = dayStatus(i + 1); const isToday = `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}` === todayKey; return <Button key={i} variant="ghost" aria-label={`${monthLabel} ${i + 1}${st ? ` · ${st}` : ''}`} aria-pressed={day === i + 1} onClick={() => { setDay(i + 1); setDetailPage(0); }} className="h-11 w-full rounded-lg p-0 text-sm"><span className={cn('flex h-9 w-9 items-center justify-center rounded-lg font-medium', st && DAY_STYLES[st], isToday && 'border border-primary', day === i + 1 && 'ring-2 ring-primary ring-offset-2 ring-offset-background')}>{i + 1}</span></Button>; })}</div>
            <div className="mt-2 flex flex-wrap gap-3 text-[11px] text-muted-foreground">{[{ name: 'Paid', color: 'bg-success' }, { name: 'Partial', color: 'bg-success/35' }, { name: 'Missed', color: 'bg-destructive' }].map(item => <span key={item.name} className="flex items-center gap-2"><span className={cn('h-2.5 w-2.5 rounded-full', item.color)} />{item.name}</span>)}</div>
            <div aria-live="polite" className="mt-3 border-t border-border pt-3"><div className="flex flex-wrap justify-between gap-2"><h3 className="text-sm font-semibold">{dateLabel}</h3><span className="text-sm font-semibold text-success">{formatUGX(selected?.total ?? 0)}</span></div>
              {detailRows.length ? <ul className="mt-3 divide-y divide-border">{detailRows.map(row => <li key={row.id} className="flex items-center gap-3 py-3"><span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">{firstLetter(tenantRows.find(t => t.id === row.tenant_id)?.full_name)}</span><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{tenantRows.find(t => t.id === row.tenant_id)?.full_name || 'Tenant details unavailable'}</p><p className="text-xs text-muted-foreground">{tenantRows.find(t => t.id === row.tenant_id)?.phone || 'Phone not recorded'}</p></div><div className="text-right"><p className="text-sm font-semibold tabular-nums">{formatUGX(row.amount)}</p><p className="text-xs text-muted-foreground">{row.is_partial ? 'Partial payment' : 'Payment recorded'}</p></div></li>)}</ul> : <p className="py-5 text-sm text-muted-foreground">{collectionsLoading ? 'Loading collections…' : collectionsFailed ? 'Collections unavailable.' : dayStatus(day) === 'missed' ? 'No payments recorded. Individual missed-tenant details are not available for this date.' : 'No collections recorded for this date.'}</p>}
              {selectedRows.length > 0 && <div className="mt-3 flex flex-wrap items-center justify-between gap-3"><p className="text-xs text-muted-foreground">Showing {detailPage * 10 + 1}–{Math.min((detailPage + 1) * 10, selectedRows.length)} of {selectedRows.length} collections</p><div className="flex gap-2"><Button variant="outline" size="icon" aria-label="Previous results" disabled={detailPage === 0} onClick={() => setDetailPage(p => p - 1)}><ChevronLeft className="h-4 w-4" /></Button><Button variant="outline" size="icon" aria-label="Next results" disabled={(detailPage + 1) * 10 >= selectedRows.length} onClick={() => setDetailPage(p => p + 1)}><ChevronRight className="h-4 w-4" /></Button></div></div>}
            </div>
          </section>
          </div>
        </main>
      </div>
      <nav aria-label="Agent navigation" className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-card pb-safe"><div className="mx-auto grid max-w-xl grid-cols-5 px-2 py-2">{[{ label: 'Home', Icon: Home }, { label: 'Tenants', Icon: Users }, { label: 'Collect', Icon: Wallet }, { label: 'Post Rent', Icon: FileText }, { label: 'More', Icon: Menu }].map(({ label, Icon }) => <Button key={label} variant="ghost" aria-current={activeNav === label ? 'page' : undefined} onClick={() => { if (label === 'Post Rent') { openRequest(); return; } setActiveNav(label); if (label === 'Home') window.scrollTo({ top: 0, behavior: 'smooth' }); else if (label === 'Tenants') document.getElementById('due-heading')?.scrollIntoView({ behavior: 'smooth' }); else setNotice(label); }} className={cn('h-14 flex-col gap-1 rounded-lg px-0 text-xs', activeNav === label ? 'text-primary' : 'text-muted-foreground')}><Icon className="!h-5 !w-5" strokeWidth={1.8} /><span>{label}</span></Button>)}</div></nav>
      <Dialog open={selectedTenantId !== null} onOpenChange={open => { if (!open) setSelectedTenantId(null); }}><DialogContent className="max-h-[90dvh] max-w-2xl overflow-y-auto"><DialogHeader><DialogTitle>Tenant details</DialogTitle><DialogDescription>Rent Plans and repayment history</DialogDescription></DialogHeader>{selectedTenantId && <TenantProfileView tenantId={selectedTenantId} onBack={() => setSelectedTenantId(null)} />}</DialogContent></Dialog>
      <RentCalculatorDialog open={calcOpen} onOpenChange={setCalcOpen} />
      <Dialog open={notice !== null} onOpenChange={open => { if (!open) setNotice(null); }}><DialogContent><DialogHeader><DialogTitle>{notice}</DialogTitle><DialogDescription>{notice?.includes('tenants') || notice === 'Tenants' ? 'Tenant details' : 'Agent dashboard'}</DialogDescription></DialogHeader>{notice === 'Paid tenants' ? <p className="text-sm text-muted-foreground">{todayPaidCount} tenants paid today. Individual paid-tenant details are not available in this view.</p> : notice?.includes('tenants') || notice === 'Tenants' ? <ul className="max-h-80 overflow-y-auto divide-y divide-border">{DUE_LIST.map(t => <li key={t.rent_request_id} className="py-3"><p className="text-sm font-medium">{t.tenant_name || 'Tenant'}</p><p className="text-sm text-muted-foreground">{t.tenant_phone || 'Phone not recorded'}</p></li>)}</ul> : <p className="text-sm text-muted-foreground">No transactions have been made.</p>}</DialogContent></Dialog>
    </div>
  );
}
