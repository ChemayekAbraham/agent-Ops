import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import { Bell, Building2, Calculator, CalendarDays, CheckCircle2, ChevronLeft, ChevronRight, Eye, EyeOff, FileText, Hand, Home, Menu, Store, Trophy, Users, Wallet, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { formatUGX } from '@/lib/rentCalculations';
import { cn } from '@/lib/utils';
import { useProfile } from '@/hooks/useProfile';
import { useAuth } from '@/hooks/useAuth';
import { useAgentCapacityMap } from '@/hooks/useAgentCapacityMap';
import { useAgentArrears } from '@/hooks/useAgentArrears';

const SHORTCUTS: { label: string; Icon: LucideIcon; color: string; to?: string }[] = [
  { label: 'Calculator', Icon: Calculator, color: 'text-primary' },
  { label: 'Service Center', Icon: Store, color: 'text-info', to: '/agent/service-center' },
  { label: 'Leaderboard', Icon: Trophy, color: 'text-success', to: '/dashboard/agents/leaderboard' },
  { label: 'Landlord Float', Icon: Building2, color: 'text-warning' },
];

export default function AgentsMock() {
  const { profile } = useProfile();
  const { user } = useAuth();
  const ids = useMemo(() => (user?.id ? [user.id] : []), [user?.id]);
  const { data: capMap, isLoading: capLoading } = useAgentCapacityMap(ids);
  const cap = user?.id ? capMap?.get(user.id) : undefined;
  const EXPECTED_TODAY = Math.max(0, cap?.expected_daily ?? 0);
  const COLLECTED_TODAY = Math.max(0, cap?.paid_today ?? 0);
  const TENANTS_DONE = cap?.tenants_paid_today ?? 0;
  const TENANTS_TOTAL = cap?.tenants_due ?? 0;
  const CAPACITY_PCT = EXPECTED_TODAY > 0 ? Math.min(100, Math.round((COLLECTED_TODAY / EXPECTED_TODAY) * 100)) : 0;
  const LEFT_TODAY = Math.max(0, EXPECTED_TODAY - COLLECTED_TODAY);
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
  const [hidden, setHidden] = useState(false);
  const [activeNav, setActiveNav] = useState('Home');
  const [notice, setNotice] = useState<string | null>(null);
  const navigate = useNavigate();
  const [month, setMonth] = useState(new Date(2026, 9, 1));
  const [day, setDay] = useState(13);
  const monthLabel = month.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const offset = month.getDay();
  const moveMonth = (delta: number) => { setMonth(new Date(month.getFullYear(), month.getMonth() + delta, 1)); setDay(1); };
  const amount = (value: number) => hidden ? '••••••' : formatUGX(value);
  return (
    <div className="agents-mock-exact min-h-screen pb-20 font-sans text-foreground tracking-normal">
      <Helmet><title>Agent dashboard preview · Welile</title><meta name="robots" content="noindex,nofollow" /></Helmet>
      <div className="mx-auto min-h-screen max-w-[400px] border-x border-border/40">
        <header className="flex h-[60px] items-center justify-between bg-card px-4">
          <p className="flex items-center gap-1 text-[11px] text-muted-foreground"><Hand className="h-3 w-3 text-warning" />Welcome Back, <strong className="text-foreground">SSENKAALI</strong></p>
          <div className="flex items-center gap-2"><Button variant="ghost" size="icon-sm" aria-label="Notifications" className="text-primary" onClick={() => setNotice('Notifications')}><Bell className="!h-4 !w-4" /></Button><Button variant="outline" size="icon-sm" aria-label="Your profile" onClick={() => setNotice('Your profile')} className="relative rounded-full border-primary p-0 text-[11px] text-primary">{profile?.avatar_url && brokenAvatar !== profile.avatar_url ? <img src={profile.avatar_url} alt="" onError={() => setBrokenAvatar(profile.avatar_url)} className="h-full w-full rounded-full object-cover" /> : initials}<span className="absolute right-0 top-0 h-2 w-2 rounded-full border border-card bg-primary" /></Button></div>
        </header>
        <main className="space-y-4 px-4 pt-4">
          <section aria-label="Rent due and collected today" className="agents-mock-wallet relative overflow-hidden rounded-[18px] p-[18px]">
            <div className="relative flex items-center justify-between"><span className="text-[10px] font-semibold uppercase tracking-wide opacity-80">Today's rent</span><Button variant="ghost" size="icon-sm" aria-label={hidden ? 'Show amounts' : 'Hide amounts'} onClick={() => setHidden(!hidden)} className="text-inherit hover:bg-primary/20">{hidden ? <EyeOff className="!h-4 !w-4" /> : <Eye className="!h-4 !w-4" />}</Button></div>
            <div className="relative mt-2 flex items-center gap-4">
              <div className="relative h-[84px] w-[84px] shrink-0 rounded-full" style={{ background: `conic-gradient(hsl(var(--header-foreground)) ${CAPACITY_PCT * 3.6}deg, hsl(var(--header-foreground) / .2) 0deg)` }}>
                <div className="absolute inset-[7px] flex flex-col items-center justify-center rounded-full bg-[hsl(var(--mock-wallet-end))]"><span className="text-lg font-bold leading-5">{CAPACITY_PCT}%</span><span className="text-[8px] opacity-70">collected</span></div>
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[9px] uppercase opacity-70">Rent due to collect</p>
                <p className="text-[22px] font-bold leading-6">{amount(EXPECTED_TODAY)}</p>
                <p className="mt-1 text-[9px] opacity-70">expected today · {TENANTS_TOTAL} tenants</p>
              </div>
            </div>
          </section>
          <div className="grid grid-cols-4 gap-1" aria-label="Agent shortcuts">
            {SHORTCUTS.map(({ label, Icon, color, to }) => <Button key={label} variant="ghost" onClick={() => (to ? navigate(to) : setNotice(label))} className="h-[64px] flex-col gap-1 px-0 text-[10px]"><span className={cn('flex h-8 w-8 items-center justify-center rounded-full bg-card', color)}><Icon className="!h-4 !w-4" /></span>{label}</Button>)}
          </div>
          <section aria-labelledby="capacity-heading" className="rounded-[14px] border border-primary/25 bg-card p-4">
            <div className="flex items-center justify-between"><h1 id="capacity-heading" className="text-xs font-semibold">Today's Capacity</h1><span className="text-xs font-bold text-primary">{CAPACITY_PCT}%</span></div>
            <p className="mt-3 text-xl font-bold text-primary">{formatUGX(COLLECTED_TODAY)}</p><p className="text-[11px] text-muted-foreground">collected of {formatUGX(EXPECTED_TODAY)} expected today</p>
            <progress aria-label="Today's capacity progress" value={CAPACITY_PCT} max={100} className="agents-mock-progress mt-3 block h-1.5 w-full rounded-full" />
            <div className="mt-3 flex justify-between text-[10px]"><span className="text-muted-foreground">{TENANTS_DONE} of {TENANTS_TOTAL} tenants completed</span><span className="font-semibold text-primary">{capLoading && !cap ? 'Loading…' : `${formatUGX(LEFT_TODAY)} left`}</span></div>
          </section>
          <section aria-labelledby="due-heading" className="rounded-[16px] bg-card p-4">
            <div className="flex items-center justify-between"><h2 id="due-heading" className="text-xs font-semibold">Collections due today</h2><span className="text-[11px] font-bold text-primary">{arrearsFailed ? 'Unavailable' : amount(DUE_TOTAL)}</span></div>
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
                      <span className="shrink-0 text-[11px] font-bold text-primary">{amount(Number(t.due_today_ugx) || 0)}</span>
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
              <div className="grid grid-cols-7 text-center">{['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map(label => <span key={label} className="pb-2 text-[9px] text-muted-foreground">{label}</span>)}{Array.from({ length: offset }, (_, i) => <span key={`blank-${i}`} />)}{Array.from({ length: days }, (_, i) => <Button key={i} variant="ghost" aria-label={`${monthLabel} ${i + 1}`} aria-pressed={day === i + 1} onClick={() => setDay(i + 1)} className="h-9 rounded-none p-0 text-[10px]"><span className={cn('flex h-7 w-7 items-center justify-center rounded-lg', day === i + 1 && 'border-2 border-primary text-primary')}>{i + 1}</span></Button>)}</div>
              <div className="mt-4 flex justify-center gap-3 border-t border-border pt-3 text-[9px] text-muted-foreground">{[{ name: 'Collected', color: 'bg-success' }, { name: 'Partial', color: 'bg-warning/60' }, { name: 'Missed', color: 'bg-destructive' }].map(item => <span key={item.name} className="flex items-center gap-1"><span className={cn('h-2 w-2 rounded-full', item.color)} />{item.name}</span>)}</div>
            </div>
            <div className="mt-3 rounded-[16px] bg-card p-4"><h3 className="text-[10px] font-semibold">{new Date(month.getFullYear(), month.getMonth(), day).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</h3><p className="mt-1 text-[10px] italic text-muted-foreground">No collections scheduled.</p></div>
          </section>
        </main>
      </div>
      <nav aria-label="Agent navigation" className="fixed inset-x-0 bottom-0 z-40 bg-card pb-safe"><div className="mx-auto grid max-w-[400px] grid-cols-5 px-2 py-1">{[{ label: 'Home', Icon: Home }, { label: 'Tenants', Icon: Users }, { label: 'Collect', Icon: Wallet }, { label: 'Post Rent', Icon: FileText }, { label: 'More', Icon: Menu }].map(({ label, Icon }) => <Button key={label} variant="ghost" aria-current={activeNav === label ? 'page' : undefined} onClick={() => { setActiveNav(label); if (label === 'Home') window.scrollTo({ top: 0, behavior: 'smooth' }); else setNotice(label); }} className="h-[50px] flex-col gap-0.5 rounded-lg px-0 text-foreground"><span className={cn('flex h-7 w-7 items-center justify-center rounded-full text-primary', activeNav === label && 'bg-primary/10')}><Icon className="!h-4 !w-4" strokeWidth={1.8} /></span><span className="text-[8px] font-medium">{label}</span></Button>)}</div></nav>
      <Dialog open={notice !== null} onOpenChange={open => { if (!open) setNotice(null); }}><DialogContent><DialogHeader><DialogTitle>{notice}</DialogTitle><DialogDescription>Design preview only. No transactions will be made.</DialogDescription></DialogHeader></DialogContent></Dialog>
    </div>
  );
}
