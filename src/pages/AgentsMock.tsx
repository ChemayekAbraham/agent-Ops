import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useNavigate } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import { ArrowRight, Bell, UserPlus, Calculator, CheckCircle2, ChevronLeft, ChevronRight, FileText, LogOut, Plus, Home, Menu, Repeat, Settings, Store, Trophy, UserRound, Users, Wallet, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import RentCalculatorDialog from '@/components/agent/RentCalculatorDialog';
import { SubAgentInviteLinkDialog } from '@/components/agent/SubAgentInviteLinkDialog';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { COMMISSION_RATE, LANDLORD_PAYOUT_COMMISSION_RATE, formatUGX } from '@/lib/rentCalculations';
import { cn } from '@/lib/utils';
import { useProfile } from '@/hooks/useProfile';
import { useAuth } from '@/hooks/useAuth';
import type { AppRole } from '@/hooks/auth/types';
import { roleDashboardRoutes } from '@/components/layout/executiveSidebarConfig';
import { roleToSlug } from '@/lib/roleRoutes';
import { useAgentCapacityMap } from '@/hooks/useAgentCapacityMap';
import { useAgentArrears } from '@/hooks/useAgentArrears';
import { TenantProfileView } from '@/components/agent/TenantProfileView';

const SHORTCUTS: { label: string; Icon: LucideIcon; color: string; to?: string }[] = [
  { label: 'Rent Calculator', Icon: Calculator, color: 'text-primary', },
  { label: 'Service Center', Icon: Store, color: 'text-info', to: '/agent/service-center' },
  { label: 'Leaderboard', Icon: Trophy, color: 'text-success', to: '/dashboard/agents/leaderboard' },
  { label: 'Invite', Icon: UserPlus, color: 'text-warning' },
];

/** Where the avatar menu goes: the two pages that already exist, then sign-out. */
const PROFILE_MENU: { label: string; Icon: LucideIcon; to: string }[] = [
  { label: 'Profile', Icon: UserRound, to: '/your-profile' },
  { label: 'Settings', Icon: Settings, to: '/settings' },
];

/** Plain names for the roles a signed-in user can hold, shown in the avatar menu. */
const ROLE_LABELS: Record<string, string> = {
  tenant: 'Tenant', agent: 'Agent', landlord: 'Landlord', supporter: 'Supporter',
  manager: 'Manager', ceo: 'CEO', coo: 'COO', cfo: 'CFO', cto: 'CTO', cmo: 'CMO',
  crm: 'CRM', employee: 'Employee', operations: 'Operations', super_admin: 'Super Admin',
  hr: 'HR', access_admin: 'Access Admin', rd: 'R&D',
  financial_ops: 'Financial Ops', agent_ops: 'Agent Ops', landlord_ops: 'Landlord Ops',
  tenant_ops: 'Tenant Ops', partner_ops: 'Partner Ops',
};

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
  const { user, signOut, role, roles, switchRole } = useAuth();
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
  const [profileOpen, setProfileOpen] = useState(false);
  const [calcOpen, setCalcOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const navigate = useNavigate();
  const [rolePickerOpen, setRolePickerOpen] = useState(false);
  // Same switch the header RoleSwitcher uses: flip the active role, then land
  // on that role's dashboard. Manager keeps its access-code gate.
  const pickRole = (next: AppRole) => {
    setProfileOpen(false);
    setRolePickerOpen(false);
    if (next === role) return;
    if (next === 'manager') { navigate('/manager-login'); return; }
    switchRole(next);
    navigate(roleDashboardRoutes[next] || roleToSlug(next));
  };
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
  // A tenant's photo comes from the profile, and falls back to the passport
  // photo captured with their Rent Request (the same fallback the server-side
  // tenant views use) — many tenants only have the request photo.
  const { data: tenantPhotos = {} } = useQuery({
    queryKey: ['agents-mock-tenant-photos', user?.id, tenantIds.join(',')],
    enabled: tenantIds.length > 0,
    staleTime: 50 * 60_000,
    queryFn: async () => {
      const [profRes, reqRes] = await Promise.all([
        supabase.from('profiles').select('id, avatar_url').in('id', tenantIds),
        supabase.from('rent_requests')
          .select('tenant_id, tenant_photo_url, created_at')
          .in('tenant_id', tenantIds)
          .not('status', 'in', '("rejected","deleted_by_agent")')
          .not('tenant_photo_url', 'is', null)
          .order('created_at', { ascending: false })
          .limit(2000),
      ]);
      const fallback = new Map<string, string>();
      (reqRes.data ?? []).forEach(r => {
        if (r.tenant_photo_url && !fallback.has(r.tenant_id)) fallback.set(r.tenant_id, r.tenant_photo_url);
      });
      const resolve = async (id: string, raw: string) => {
        const match = raw.match(/\/avatars\/([^?]+)/);
        if (match?.[1]) {
          const { data: signed } = await supabase.storage.from('avatars').createSignedUrl(decodeURIComponent(match[1]), 3600);
          if (signed?.signedUrl) photos[id] = signed.signedUrl;
        } else photos[id] = raw;
      };
      const photos: Record<string, string> = {};
      const profById = new Map((profRes.data ?? []).map(row => [row.id, row.avatar_url]));
      const ids = new Set<string>([...profById.keys(), ...fallback.keys()]);
      await Promise.all(Array.from(ids).map(async id => {
        const raw = profById.get(id) || fallback.get(id);
        if (raw) await resolve(id, raw);
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
        <header className="flex items-center justify-between gap-3 rounded-none border-0 shadow-none bg-[var(--mock-header)] px-4 pb-4 pt-5 text-primary-foreground sm:px-6">
          <div className="min-w-0"><p className="text-xs font-medium text-primary-foreground/80">Welcome back</p><h1 className="truncate text-xl font-semibold text-primary-foreground">{profile?.full_name?.split(' ')[0] || 'Your dashboard'}</h1></div>
          <div className="flex gap-2"><Button variant="ghost" size="icon" aria-label="Notifications" onClick={() => setNotice('Notifications')} className="text-primary-foreground hover:bg-primary-foreground/15 hover:text-primary-foreground"><Bell className="h-5 w-5" /></Button><Popover open={profileOpen} onOpenChange={open => { setProfileOpen(open); if (!open) setRolePickerOpen(false); }}><PopoverTrigger asChild><Button variant="outline" size="icon" aria-label="Your profile" className="overflow-hidden rounded-full border-primary-foreground/40 bg-primary-foreground/10 text-primary-foreground">{avatarSrc && brokenAvatar !== avatarSrc ? <img src={avatarSrc} alt="" onError={() => setBrokenAvatar(avatarSrc)} className="h-full w-full object-cover" /> : initials}</Button></PopoverTrigger><PopoverContent align="end" sideOffset={10} className="relative w-56 rounded-xl p-1.5"><span aria-hidden className="absolute -top-1.5 right-5 h-3 w-3 rotate-45 border-l border-t border-border bg-popover" />
            {rolePickerOpen ? <>
              <Button variant="ghost" onClick={() => setRolePickerOpen(false)} className="h-11 w-full justify-start gap-2.5 rounded-lg px-2 text-sm font-medium"><span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted/60"><ChevronLeft className="h-4 w-4" /></span>Switch role</Button>
              <div className="max-h-64 overflow-y-auto">{roles.map(r => { const label = ROLE_LABELS[r] ?? r; return <Button key={r} variant="ghost" disabled={r === role} onClick={() => pickRole(r)} className={cn('h-11 w-full justify-start gap-2.5 rounded-lg px-2 text-sm font-medium', r === role && 'bg-primary/10 text-primary')}><span className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[10px] font-bold', r === role ? 'bg-primary/20 text-primary' : 'bg-muted/60')}>{label.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()}</span>{label}{r === role && <CheckCircle2 className="ml-auto h-4 w-4 text-primary" />}</Button>; })}</div>
            </> : <>
              {PROFILE_MENU.map(({ label, Icon, to }) => <Button key={label} variant="ghost" onClick={() => { setProfileOpen(false); navigate(to); }} className="h-11 w-full justify-start gap-2.5 rounded-lg px-2 text-sm font-medium"><span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted/60"><Icon className="h-4 w-4" /></span>{label}<ChevronRight className="ml-auto h-4 w-4 text-muted-foreground" /></Button>)}
              {roles.length > 1 && <Button variant="ghost" onClick={() => setRolePickerOpen(true)} className="h-11 w-full justify-start gap-2.5 rounded-lg px-2 text-sm font-medium"><span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted/60"><Repeat className="h-4 w-4" /></span>Switch role<ChevronRight className="ml-auto h-4 w-4 text-muted-foreground" /></Button>}
              <Button variant="ghost" onClick={async () => { setProfileOpen(false); await signOut(); navigate('/auth'); }} className="h-11 w-full justify-start gap-2.5 rounded-lg px-2 text-sm font-medium text-destructive"><span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-destructive/10"><LogOut className="h-4 w-4" /></span>Log out<ChevronRight className="ml-auto h-4 w-4 text-destructive/60" /></Button>
            </>}
          </PopoverContent></Popover></div>
        </header>
        <main className="space-y-4 px-4 sm:px-6">
          <section aria-labelledby="post-cta-heading" className="rounded-xl border border-primary/20 bg-primary/5 p-4 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3 lg:flex-nowrap">
              <div className="min-w-0"><p className="text-[11px] font-semibold uppercase tracking-wide text-primary">Grow your earnings</p><h2 id="post-cta-heading" className="mt-0.5 text-lg font-bold leading-tight">Add tenant, earn at every step</h2></div>
              <Button onClick={openRequest} className="h-12 w-full gap-2 rounded-lg px-5 text-sm font-semibold shadow-sm sm:w-auto"><Plus className="h-4 w-4" />Post Rent Request<ArrowRight className="h-4 w-4" /></Button>
            </div>
            <ol className="relative mt-4 grid grid-cols-3" aria-label="How you earn">
              <span aria-hidden className="absolute left-[16.66%] right-[16.66%] top-3 h-0.5 bg-gradient-to-r from-primary via-warning to-success opacity-60" />
              {[{ step: '1', value: 'UGX 5,000', note: 'when you post', color: 'text-primary', dot: 'bg-primary' }, { step: '2', value: '1%', note: 'when landlord is paid', color: 'text-warning', dot: 'bg-warning' }, { step: '3', value: '10%', note: 'on every repayment', color: 'text-success', dot: 'bg-success' }].map(e => <li key={e.step} className="relative flex flex-col items-center px-1 text-center"><span className={cn('flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-bold text-primary-foreground ring-4 ring-background', e.dot)}>{e.step}</span><span className={cn('mt-1.5 text-sm font-bold tabular-nums sm:text-base', e.color)}>{e.value}</span><span className="text-[11px] leading-tight text-muted-foreground">{e.note}</span></li>)}
            </ol>
          </section>
          <section aria-label="Collection summary" className="rounded-xl border border-primary/20 bg-primary/5 p-4 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="font-semibold">Collections</h2><div className="flex rounded-lg bg-muted p-1" aria-label="Collection period">{(['today', 'month'] as const).map(p => <Button key={p} variant="ghost" aria-pressed={period === p} onClick={() => setPeriod(p)} className={cn('h-10 rounded-md px-3 text-xs', period === p && 'bg-card shadow-sm')}>{p === 'today' ? 'Today' : 'This Month'}</Button>)}</div></div>
            <div className="mt-3 grid grid-cols-2 gap-4"><div><p className="text-xs text-muted-foreground">Collected</p><p className="mt-1 break-words text-xl font-bold text-success tabular-nums">{period === 'month' && (collectionsFailed || collectionsLoading) ? (collectionsFailed ? 'Unavailable' : 'Loading…') : formatUGX(collected)}</p></div><div className="border-l border-border pl-4"><p className="text-xs text-muted-foreground">Expected</p><p className="mt-1 break-words text-xl font-semibold tabular-nums">{period === 'month' && (historyFailed || historyLoading) ? (historyFailed ? 'Unavailable' : 'Loading…') : formatUGX(expected)}</p></div></div>
            <div className="mt-3 flex items-center gap-2 text-xs"><Users className="h-4 w-4 text-primary" /><span><strong>{period === 'today' ? TENANTS_TOTAL : new Set((monthRows ?? []).map(r => r.tenant_id)).size}</strong> {period === 'today' ? 'tenants to collect for' : 'tenants collected for'}</span>{period === 'today' && <span className="ml-auto text-xs text-muted-foreground">{todayPaidCount} paid</span>}</div>
          </section>
          <section aria-label="Agent shortcuts" className="grid grid-cols-2 gap-2 sm:grid-cols-4">{SHORTCUTS.map(({ label, Icon, color, to }) => <Button key={label} variant="ghost" onClick={() => to ? navigate(to) : label === 'Rent Calculator' ? setCalcOpen(true) : label === 'Invite' ? setInviteOpen(true) : setNotice(label)} className="h-12 justify-start gap-2 rounded-lg border border-border whitespace-normal px-3 text-left text-xs"><span className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted/50', color)}><Icon className="!h-5 !w-5" /></span>{label}</Button>)}</section>
          <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
          <section aria-labelledby="due-heading" className="min-w-0">
            <div className="flex items-center justify-between gap-2"><h2 id="due-heading" className="text-base font-semibold">Today's tenants</h2><span className="text-xs text-muted-foreground">{payingTenants.length} repaying</span></div>
            <div className="mt-2 inline-grid grid-cols-2 gap-0.5 self-start rounded-full border border-border/12 bg-muted p-0.5" role="group" aria-label="Tenant filter">{(['repaying', 'paid'] as const).map(f => { const n = f === 'repaying' ? payingTenants.length : paidTenants.length; const on = tenantFilter === f; return <Button key={f} variant="ghost" aria-pressed={on} onClick={() => { setTenantFilter(f); setTenantPage(0); }} className={cn('!h-7 !min-h-0 w-full justify-center rounded-full px-2.5 text-[11px] capitalize transition-colors', on ? 'bg-primary text-primary-foreground hover:bg-primary' : 'text-muted-foreground hover:text-foreground')}>{f}<span className={cn('ml-1 inline-flex h-[14px] w-[14px] items-center justify-center rounded-full text-[9px] font-semibold tabular-nums', on ? 'bg-primary-foreground text-primary' : 'border border-primary/30 bg-primary/20 text-primary')}>{n}</span></Button>; })}</div>
            {tenantsLoading ? <p className="py-5 text-sm text-muted-foreground">Loading tenants…</p> : tenantsFailed ? <p className="py-5 text-sm text-destructive">Tenant records could not be loaded.</p> : <>
              <ul className="space-y-3">{displayTenants.slice(tenantPage * 10, tenantPage * 10 + 10).map(t => {
                const pct = t.total_repayment > 0 ? Math.min(100, Math.round(t.amount_repaid / t.total_repayment * 100)) : null;
                const paidToday = Number(t.today_paid_amount ?? 0);
                const balance = Number(t.balance ?? 0);
                const unfunded = Number(t.unfunded_balance ?? 0);
                const state = balance <= 0 && unfunded > 0
                  ? { label: 'Landlord not paid', chip: 'bg-warning/10 text-warning' }
                  : balance > 0
                    ? { label: 'Owing', chip: 'bg-destructive/10 text-destructive' }
                    : { label: 'Paid up', chip: 'bg-success/10 text-success' };
                return <li key={t.id}>
                  <Button variant="ghost" onClick={() => setSelectedTenantId(t.id)} className="h-auto min-h-[72px] w-full justify-start gap-2.5 rounded-2xl border-2 border-border/60 bg-card px-3 py-3 text-left transition-all hover:bg-card active:scale-[0.97] sm:gap-3">
                    <span className={cn('flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full text-sm font-bold sm:h-11 sm:w-11 sm:text-base', state.chip)}>{tenantPhotos[t.id] ? <img src={tenantPhotos[t.id]} alt="" className="h-full w-full object-cover" onError={e => { const el = e.currentTarget; el.style.display = 'none'; if (el.parentElement) el.parentElement.textContent = firstLetter(t.full_name); }} /> : firstLetter(t.full_name)}</span>
                    <span className="min-w-0 flex-1 whitespace-normal text-left"><span className="block truncate text-[13px] font-bold sm:text-sm">{t.full_name}</span><span className="mt-1 flex items-center gap-1 truncate text-[11px] text-muted-foreground sm:text-xs">{t.phone || 'Phone not recorded'}</span></span>
                    <span className="flex shrink-0 flex-col items-end text-right"><span className="text-[9px] font-bold uppercase tracking-wide text-muted-foreground sm:text-[10px]">Repaid today</span><span className={cn('mt-0.5 text-[11px] font-bold tabular-nums sm:text-sm', paidToday > 0 ? 'text-success' : 'text-muted-foreground')}>{formatUGX(paidToday)}</span><span className={cn('mt-0.5 text-[10px] font-semibold tabular-nums text-muted-foreground sm:text-xs', pct !== null && pct < 50 && 'text-destructive')}>{pct === null ? '—' : `${pct}%`}</span></span>
                  </Button>
                </li>;
              })}</ul>
              {displayTenants.length === 0 && <p className="py-5 text-sm text-muted-foreground">{tenantFilter === 'paid' ? 'No tenant payments recorded today.' : 'No repaying tenants found.'}</p>}
              {displayTenants.length > 10 && <div className="flex items-center justify-between gap-2 border-t border-border py-3"><span className="text-xs text-muted-foreground">{tenantPage * 10 + 1}–{Math.min(tenantPage * 10 + 10, displayTenants.length)} of {displayTenants.length} tenants</span><div className="flex gap-1"><Button variant="outline" size="icon" aria-label="Previous tenants" disabled={tenantPage === 0} onClick={() => setTenantPage(p => p - 1)}><ChevronLeft className="h-4 w-4" /></Button><Button variant="outline" size="icon" aria-label="Next tenants" disabled={(tenantPage + 1) * 10 >= displayTenants.length} onClick={() => setTenantPage(p => p + 1)}><ChevronRight className="h-4 w-4" /></Button></div></div>}
            </>}
          </section>
          <div className="mx-auto w-full max-w-[380px] lg:max-w-none">
          <section aria-labelledby="calendar-heading" className="rounded-xl border border-border/12 bg-[#FFFFFF] p-3 dark:bg-card">
            <div className="flex items-center justify-between gap-2"><h2 id="calendar-heading" className="whitespace-nowrap text-sm font-semibold">Repayment calendar</h2><div className="flex items-center gap-0.5"><Button variant="ghost" size="icon" className="!h-7 !w-7 !min-h-0 !min-w-0" aria-label="Previous month" onClick={() => moveMonth(-1)}><ChevronLeft className="h-4 w-4" /></Button><span className="min-w-[5rem] whitespace-nowrap text-center text-xs font-semibold">{monthLabel}</span><Button variant="ghost" size="icon" className="!h-7 !w-7 !min-h-0 !min-w-0" aria-label="Next month" onClick={() => moveMonth(1)}><ChevronRight className="h-4 w-4" /></Button></div></div>
            {(collectionsFailed || historyFailed) && <p className="mb-3 text-xs text-destructive">Calendar records could not be fully loaded.</p>}
            <div className="mt-2 grid grid-cols-7 gap-1 text-center">{['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map(label => <span key={label} className="pb-0.5 text-[11px] font-medium text-muted-foreground">{label}</span>)}{Array.from({ length: offset }, (_, i) => <span key={`blank-${i}`} />)}{Array.from({ length: days }, (_, i) => { const st = dayStatus(i + 1); const isToday = `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}` === todayKey; return <Button key={i} variant="ghost" aria-label={`${monthLabel} ${i + 1}${st ? ` · ${st}` : ''}`} aria-pressed={day === i + 1} onClick={() => { setDay(i + 1); setDetailPage(0); }} className="!h-8 !min-h-0 w-full min-w-0 rounded-md p-0 text-xs"><span className={cn('flex h-full w-full items-center justify-center rounded-md font-medium tabular-nums', st && DAY_STYLES[st], isToday && 'border border-primary', day === i + 1 && 'border-2 border-primary')}>{i + 1}</span></Button>; })}</div>
            </section>
            <div className="mt-2 flex flex-wrap gap-3 text-[11px] text-muted-foreground">{[{ name: 'Paid', color: 'bg-success' }, { name: 'Partial', color: 'bg-success/35' }, { name: 'Missed', color: 'bg-destructive' }].map(item => <span key={item.name} className="flex items-center gap-2"><span className={cn('h-2 w-2 rounded-full', item.color)} />{item.name}</span>)}</div>
            <div aria-live="polite" className="mt-2 rounded-2xl bg-muted p-4"><div className="flex flex-wrap justify-between gap-2"><h3 className="text-sm font-semibold">{dateLabel}</h3><span className="text-sm font-semibold text-success">{formatUGX(selected?.total ?? 0)}</span></div>
              {detailRows.length ? <ul className="mt-3 divide-y divide-border">{detailRows.map(row => <li key={row.id} className="flex items-center gap-3 py-3">{(() => { const t = tenantRows.find(x => x.id === row.tenant_id); const photo = tenantPhotos[row.tenant_id]; return <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full bg-primary/10 text-sm font-semibold text-primary">{photo ? <img src={photo} alt="" className="h-full w-full object-cover" onError={e => { const el = e.currentTarget; el.style.display = 'none'; if (el.parentElement) el.parentElement.textContent = firstLetter(t?.full_name); }} /> : firstLetter(t?.full_name)}</span>; })()}<div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{tenantRows.find(t => t.id === row.tenant_id)?.full_name || 'Tenant details unavailable'}</p><p className="text-xs text-muted-foreground">{tenantRows.find(t => t.id === row.tenant_id)?.phone || 'Phone not recorded'}</p></div><div className="text-right"><p className="text-sm font-semibold tabular-nums">{formatUGX(row.amount)}</p><p className="text-xs text-muted-foreground">{row.is_partial ? 'Partial payment' : 'Payment recorded'}</p></div></li>)}</ul> : <p className="py-5 text-sm text-muted-foreground">{collectionsLoading ? 'Loading collections…' : collectionsFailed ? 'Collections unavailable.' : dayStatus(day) === 'missed' ? 'No payments recorded. Individual missed-tenant details are not available for this date.' : 'No collections recorded for this date.'}</p>}
              {selectedRows.length > 0 && <div className="mt-3 flex flex-wrap items-center justify-between gap-3"><p className="text-xs text-muted-foreground">Showing {detailPage * 10 + 1}–{Math.min((detailPage + 1) * 10, selectedRows.length)} of {selectedRows.length} collections</p><div className="flex gap-2"><Button variant="outline" size="icon" aria-label="Previous results" disabled={detailPage === 0} onClick={() => setDetailPage(p => p - 1)}><ChevronLeft className="h-4 w-4" /></Button><Button variant="outline" size="icon" aria-label="Next results" disabled={(detailPage + 1) * 10 >= selectedRows.length} onClick={() => setDetailPage(p => p + 1)}><ChevronRight className="h-4 w-4" /></Button></div></div>}
            </div>
          </div>
          </div>
        </main>
      </div>
      <nav aria-label="Agent navigation" className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-card pb-safe"><div className="mx-auto grid max-w-xl grid-cols-5 px-2 py-2">{[{ label: 'Home', Icon: Home }, { label: 'Tenants', Icon: Users }, { label: 'Collect', Icon: Wallet }, { label: 'Post Rent', Icon: FileText }, { label: 'More', Icon: Menu }].map(({ label, Icon }) => <Button key={label} variant="ghost" aria-current={activeNav === label ? 'page' : undefined} onClick={() => { if (label === 'Post Rent') { openRequest(); return; } setActiveNav(label); if (label === 'Home') window.scrollTo({ top: 0, behavior: 'smooth' }); else if (label === 'Tenants') document.getElementById('due-heading')?.scrollIntoView({ behavior: 'smooth' }); else setNotice(label); }} className={cn('h-14 flex-col gap-1 rounded-lg px-0 text-xs', activeNav === label ? 'text-primary' : 'text-muted-foreground')}><Icon className="!h-5 !w-5" strokeWidth={1.8} /><span>{label}</span></Button>)}</div></nav>
      <Dialog open={selectedTenantId !== null} onOpenChange={open => { if (!open) setSelectedTenantId(null); }}><DialogContent className="max-h-[90dvh] max-w-2xl overflow-y-auto"><DialogHeader><DialogTitle>Tenant details</DialogTitle><DialogDescription>Rent Plans and repayment history</DialogDescription></DialogHeader>{selectedTenantId && <TenantProfileView tenantId={selectedTenantId} onBack={() => setSelectedTenantId(null)} />}</DialogContent></Dialog>
      <RentCalculatorDialog open={calcOpen} onOpenChange={setCalcOpen} />
      <SubAgentInviteLinkDialog open={inviteOpen} onOpenChange={setInviteOpen} />
      <Dialog open={notice !== null} onOpenChange={open => { if (!open) setNotice(null); }}><DialogContent><DialogHeader><DialogTitle>{notice}</DialogTitle><DialogDescription>{notice?.includes('tenants') || notice === 'Tenants' ? 'Tenant details' : 'Agent dashboard'}</DialogDescription></DialogHeader>{notice === 'Paid tenants' ? <p className="text-sm text-muted-foreground">{todayPaidCount} tenants paid today. Individual paid-tenant details are not available in this view.</p> : notice?.includes('tenants') || notice === 'Tenants' ? <ul className="max-h-80 overflow-y-auto divide-y divide-border">{DUE_LIST.map(t => <li key={t.rent_request_id} className="py-3"><p className="text-sm font-medium">{t.tenant_name || 'Tenant'}</p><p className="text-sm text-muted-foreground">{t.tenant_phone || 'Phone not recorded'}</p></li>)}</ul> : <p className="text-sm text-muted-foreground">No transactions have been made.</p>}</DialogContent></Dialog>
    </div>
  );
}
