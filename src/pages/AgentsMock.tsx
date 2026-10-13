import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useNavigate } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import { ArrowRight, Bell, Building2, Calculator, CheckCircle2, ChevronLeft, ChevronRight, FileText, Hand, Home, Menu, Store, Trophy, Users, Wallet, type LucideIcon } from 'lucide-react';
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
  const [showAllDue, setShowAllDue] = useState(false);
  const VISIBLE_DUE = showAllDue ? DUE_LIST : DUE_LIST.slice(0, 10);
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
      const { data, error } = await supabase.storage.from('avatars').createSignedUrl(avatarPath!, 3600);
      if (error) throw error;
      return data.signedUrl;
    },
  });
  const avatarSrc = signedAvatar ?? (avatarPath ? null : profile?.avatar_url ?? null);
  const [activeNav, setActiveNav] = useState('Home');
  const [notice, setNotice] = useState<string | null>(null);
  const [calcOpen, setCalcOpen] = useState(false);
  const navigate = useNavigate();
  const [month, setMonth] = useState(new Date(2026, 9, 1));
  const [day, setDay] = useState(13);
  const monthLabel = month.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const offset = month.getDay();
  const moveMonth = (delta: number) => { setMonth(new Date(month.getFullYear(), month.getMonth() + delta, 1)); setDay(1); };
  // Real collections for the visible month (Kampala days), non-reversed only.
  const monthKey = `${month.getFullYear()}-${month.getMonth()}`;
  const { data: monthRows } = useQuery({
    queryKey: ['agents-mock-month-collections', user?.id, monthKey],
    enabled: !!user?.id,
    staleTime: 60_000,
    queryFn: async () => {
      const from = new Date(Date.UTC(month.getFullYear(), month.getMonth(), 1) - 3 * 3600_000).toISOString();
      const to = new Date(Date.UTC(month.getFullYear(), month.getMonth() + 1, 1) - 3 * 3600_000).toISOString();
      const { data, error } = await supabase.from('agent_collections')
        .select('amount, is_partial, created_at, momo_payer_name')
        .eq('agent_id', user!.id).is('reversed_at', null)
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
  const { data: historyRows } = useQuery({
    queryKey: ['agents-mock-month-expected', user?.id, monthKey],
    enabled: !!user?.id,
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.from('agent_daily_eligibility_history')
        .select('day, expected_daily, paid')
        .eq('agent_id', user!.id)
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
  return (
    <div className="agents-mock-exact min-h-screen pb-20 font-sans text-foreground tracking-normal">
      <Helmet><title>Agent dashboard preview · Welile</title><meta name="robots" content="noindex,nofollow" /></Helmet>
      <div className="mx-auto min-h-screen max-w-[400px] border-x border-border/40">
        <header className="flex h-[60px] items-center justify-between bg-card px-4">
          <p className="flex items-center gap-1 text-[11px] text-muted-foreground"><Hand className="h-3 w-3 text-warning" />Welcome Back, <strong className="text-foreground">SSENKAALI</strong></p>
          <div className="flex items-center gap-2"><Button variant="ghost" size="icon-sm" aria-label="Notifications" className="text-primary" onClick={() => setNotice('Notifications')}><Bell className="!h-4 !w-4" /></Button><Button variant="outline" size="icon-sm" aria-label="Your profile" onClick={() => setNotice('Your profile')} className="relative rounded-full border-primary p-0 text-[11px] text-primary">{avatarSrc && brokenAvatar !== avatarSrc ? <img src={avatarSrc} alt="" onError={() => setBrokenAvatar(avatarSrc)} className="h-full w-full rounded-full object-cover" /> : initials}<span className="absolute right-0 top-0 h-2 w-2 rounded-full border border-card bg-primary" /></Button></div>
        </header>
        <main className="space-y-4 px-4 pt-4">
          <section aria-label="Rent due today" className="agents-mock-wallet relative overflow-hidden rounded-[18px] p-[18px]">
            <div className="relative mt-1">
              <p className="text-[9px] uppercase opacity-70">Rent due to collect</p>
              <p className="text-[22px] font-bold leading-6">{formatUGX(EXPECTED_TODAY)}</p>
              <p className="mt-1 text-[9px] opacity-70">expected today · {TENANTS_TOTAL} tenant{TENANTS_TOTAL === 1 ? '' : 's'}</p>
            </div>
          </section>
          <section aria-labelledby="post-cta-heading" className="relative overflow-hidden rounded-[18px] border border-primary/25 bg-card p-4">
            <span aria-hidden className="absolute inset-x-0 top-0 h-[3px] bg-gradient-to-r from-primary via-warning to-success" />
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 id="post-cta-heading" className="text-xs font-semibold">Post a rent request</h2>
                <p className="mt-1 text-[10px] leading-3 text-muted-foreground">For your tenant — and you earn at three points.</p>
              </div>
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"><FileText className="!h-4 !w-4" /></span>
            </div>
            <ol className="mt-3 space-y-1.5">
              {POST_EARNINGS.map((e, i) => (
                <li key={e.when} className="flex items-center gap-2.5 rounded-xl bg-background/70 px-2.5 py-2">
                  <span className={cn('flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-[9px] font-bold', EARN_TONES[e.tone].chip)}>{i + 1}</span>
                  <span className={cn('shrink-0 text-[12px] font-bold leading-none', EARN_TONES[e.tone].text)}>{e.label}</span>
                  <span className="ml-auto text-right text-[9px] leading-3 text-muted-foreground">{e.when}</span>
                </li>
              ))}
            </ol>
            <Button onClick={() => navigate('/dashboard/agent?action=post-rent-request')} className="mt-3 h-11 w-full gap-2 rounded-xl bg-primary text-[12px] font-bold text-primary-foreground">
              Post rent request here
              <ArrowRight className="!h-4 !w-4" />
            </Button>
          </section>
          <div className="grid grid-cols-4 gap-1" aria-label="Agent shortcuts">
            {SHORTCUTS.map(({ label, Icon, color, to }) => <Button key={label} variant="ghost" onClick={() => (to ? navigate(to) : label === 'Calculator' ? setCalcOpen(true) : setNotice(label))} className="h-[64px] flex-col gap-1 px-0 text-[10px]"><span className={cn('flex h-8 w-8 items-center justify-center rounded-full bg-card', color)}><Icon className="!h-4 !w-4" /></span>{label}</Button>)}
          </div>
          <section aria-labelledby="due-heading" className="rounded-[16px] bg-card p-4">
            <div className="flex items-center justify-between"><h2 id="due-heading" className="text-xs font-semibold">Collections due today</h2><span className="text-[11px] font-bold text-primary">{arrearsFailed ? 'Unavailable' : formatUGX(DUE_TOTAL)}</span></div>
            {arrearsLoading && !arrears ? (
              <p className="mt-3 text-[10px] text-muted-foreground">Loading today's list…</p>
            ) : arrearsFailed ? (
              <p className="mt-3 text-[10px] text-muted-foreground">Couldn't load today's list. Pull down to refresh.</p>
            ) : DUE_LIST.length === 0 ? (
              <div className="mt-2 flex flex-col items-center py-3 text-center">
                <span className="mb-2 flex h-9 w-9 items-center justify-center rounded-full bg-background text-success"><CheckCircle2 className="h-4 w-4" /></span>
                <h3 className="text-[11px] font-semibold">{TENANTS_TOTAL > 0 ? 'All due collections are in' : 'Nothing due today'}</h3>
                <p className="mt-1 max-w-[200px] text-[10px] leading-3 text-muted-foreground">{TENANTS_TOTAL > 0 ? 'Every tenant scheduled to pay today has already paid.' : 'You have no Rent Plans scheduled for collection today.'}</p>
              </div>
            ) : (
              <>
                <p className="mt-0.5 text-[10px] text-muted-foreground">{DUE_LIST.length} tenant{DUE_LIST.length === 1 ? '' : 's'} still to pay</p>
                <ul className="mt-2 space-y-1.5">
                  {VISIBLE_DUE.map(t => (
                    <li key={t.rent_request_id} className="flex items-center gap-2 rounded-xl bg-background/60 px-2.5 py-2">
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-[11px] font-bold text-primary">{firstLetter(t.tenant_name)}</span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[11px] font-medium">{t.tenant_name || 'Tenant'}</p>
                        <p className="text-[9px] text-muted-foreground">{Number(t.days_behind) > 0 ? `${t.days_behind} day${Number(t.days_behind) === 1 ? '' : 's'} behind` : 'Due today'}</p>
                      </div>
                      <span className="shrink-0 text-[11px] font-bold text-primary">{formatUGX(Number(t.due_today_ugx) || 0)}</span>
                    </li>
                  ))}
                </ul>
                {DUE_LIST.length > 10 && (
                  <Button variant="ghost" className="mt-2 h-8 w-full text-[10px] text-primary" onClick={() => setShowAllDue(v => !v)}>{showAllDue ? 'Show less' : `Show ${DUE_LIST.length - 10} more`}</Button>
                )}
              </>
            )}
          </section>
          <section aria-labelledby="calendar-heading" className="pt-1">
            <h2 id="calendar-heading" className="mb-3 text-xs font-semibold">Collection Calendar</h2>
            <div className="rounded-[16px] bg-card p-4">
              <div className="mb-3 flex items-center justify-between"><Button variant="ghost" size="icon-sm" aria-label="Previous month" onClick={() => moveMonth(-1)}><ChevronLeft className="!h-3 !w-3" /></Button><h3 className="text-[11px] font-semibold">{monthLabel}</h3><Button variant="ghost" size="icon-sm" aria-label="Next month" onClick={() => moveMonth(1)}><ChevronRight className="!h-3 !w-3" /></Button></div>
              <div className="grid grid-cols-7 text-center">{['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map(label => <span key={label} className="pb-2 text-[9px] text-muted-foreground">{label}</span>)}{Array.from({ length: offset }, (_, i) => <span key={`blank-${i}`} />)}{Array.from({ length: days }, (_, i) => { const st = dayStatus(i + 1); const isToday = `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}` === todayKey; return <Button key={i} variant="ghost" aria-label={`${monthLabel} ${i + 1}${st ? ` · ${st}` : ''}`} aria-pressed={day === i + 1} onClick={() => setDay(i + 1)} className="h-9 rounded-none p-0 text-[10px]"><span className={cn('flex h-7 w-7 items-center justify-center rounded-[3px] font-semibold', st && DAY_STYLES[st], isToday && 'border border-primary', day === i + 1 && 'ring-2 ring-primary ring-offset-1 ring-offset-card')}>{i + 1}</span></Button>; })}</div>
              <div className="mt-4 flex justify-center gap-3 border-t border-border pt-3 text-[9px] text-muted-foreground">{[{ name: 'Paid', color: 'bg-success' }, { name: 'Partial', color: 'bg-success/35' }, { name: 'Missed', color: 'bg-destructive' }].map(item => <span key={item.name} className="flex items-center gap-1"><span className={cn('h-2 w-2 rounded-full', item.color)} />{item.name}</span>)}</div>
            </div>
            <div className="mt-3 rounded-[16px] bg-card p-4"><h3 className="text-[10px] font-semibold">{new Date(month.getFullYear(), month.getMonth(), day).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</h3>{selected ? <p className="mt-1 text-[10px] text-muted-foreground">{selected.count} collection{selected.count === 1 ? '' : 's'} · <strong className="text-primary">{formatUGX(selected.total)}</strong>{selected.partial ? ' (includes partial)' : ''}</p> : <p className="mt-1 text-[10px] italic text-muted-foreground">{dayStatus(day) === 'missed' ? 'Nothing was collected this day — missed.' : 'No collections recorded.'}</p>}</div>
          </section>
        </main>
      </div>
      <nav aria-label="Agent navigation" className="fixed inset-x-0 bottom-0 z-40 bg-card pb-safe"><div className="mx-auto grid max-w-[400px] grid-cols-5 px-2 py-1">{[{ label: 'Home', Icon: Home }, { label: 'Tenants', Icon: Users }, { label: 'Collect', Icon: Wallet }, { label: 'Post Rent', Icon: FileText }, { label: 'More', Icon: Menu }].map(({ label, Icon }) => <Button key={label} variant="ghost" aria-current={activeNav === label ? 'page' : undefined} onClick={() => { setActiveNav(label); if (label === 'Home') window.scrollTo({ top: 0, behavior: 'smooth' }); else setNotice(label); }} className="h-[50px] flex-col gap-0.5 rounded-lg px-0 text-foreground"><span className={cn('flex h-7 w-7 items-center justify-center rounded-full text-primary', activeNav === label && 'bg-primary/10')}><Icon className="!h-4 !w-4" strokeWidth={1.8} /></span><span className="text-[8px] font-medium">{label}</span></Button>)}</div></nav>
      <RentCalculatorDialog open={calcOpen} onOpenChange={setCalcOpen} />
      <Dialog open={notice !== null} onOpenChange={open => { if (!open) setNotice(null); }}><DialogContent><DialogHeader><DialogTitle>{notice}</DialogTitle><DialogDescription>Design preview only. No transactions will be made.</DialogDescription></DialogHeader></DialogContent></Dialog>
    </div>
  );
}
