import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import { ArrowLeftRight, Bell, Building2, Calculator, CalendarDays, ChevronLeft, ChevronRight, Eye, EyeOff, FileText, Hand, Home, Menu, Store, Trophy, Users, Wallet, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { formatUGX } from '@/lib/rentCalculations';
import { cn } from '@/lib/utils';

// Design-only sample figures: expected today is the agent's daily target, collected today is what has been banked so far.
const EXPECTED_TODAY = 250000;
const COLLECTED_TODAY = 0;
const TENANTS_DONE = 0;
const TENANTS_TOTAL = 8;
const CAPACITY_PCT = EXPECTED_TODAY > 0 ? Math.round((COLLECTED_TODAY / EXPECTED_TODAY) * 100) : 0;

const SHORTCUTS: { label: string; Icon: LucideIcon; color: string; to?: string }[] = [
  { label: 'Calculator', Icon: Calculator, color: 'text-primary' },
  { label: 'Service Center', Icon: Store, color: 'text-info', to: '/agent/service-center' },
  { label: 'Leaderboard', Icon: Trophy, color: 'text-success', to: '/dashboard/agents/leaderboard' },
  { label: 'Landlord Float', Icon: Building2, color: 'text-warning' },
];

export default function AgentsMock() {
  const [hidden, setHidden] = useState(false);
  const [bucket, setBucket] = useState<'Float' | 'Withdrawable'>('Float');
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
          <div className="flex items-center gap-2"><Button variant="ghost" size="icon-sm" aria-label="Notifications" className="text-primary" onClick={() => setNotice('Notifications')}><Bell className="!h-4 !w-4" /></Button><Button variant="outline" size="icon-sm" aria-label="Your profile" onClick={() => setNotice('Your profile')} className="relative rounded-full border-primary text-[11px] text-primary">SP<span className="absolute right-0 top-0 h-2 w-2 rounded-full border border-card bg-primary" /></Button></div>
        </header>
        <main className="space-y-4 px-4 pt-4">
          <section aria-label="Sample wallet balances" className="agents-mock-wallet relative h-[173px] overflow-hidden rounded-[18px] px-[18px] py-4">
            <div className="flex items-center justify-between"><span className="text-lg font-extrabold italic">Welile</span><Button variant="ghost" size="icon-sm" aria-label={hidden ? 'Show balances' : 'Hide balances'} onClick={() => setHidden(!hidden)} className="text-inherit hover:bg-primary/20">{hidden ? <EyeOff className="!h-4 !w-4" /> : <Eye className="!h-4 !w-4" />}</Button></div>
            <div className="mt-4 flex items-center gap-1"><p className="text-[9px] font-semibold uppercase opacity-70">{bucket} balance</p><Button variant="ghost" onClick={() => setBucket(bucket === 'Float' ? 'Withdrawable' : 'Float')} className="h-4 rounded-full bg-primary/40 px-1.5 text-[8px] text-inherit"><ArrowLeftRight className="!h-2 !w-2" />Switch</Button></div>
            <p className="text-[22px] leading-6 font-bold">{amount(bucket === 'Float' ? 250000 : 210000)}</p>
            <div className="mt-5 flex items-end justify-between"><div><p className="text-[8px] uppercase opacity-70">{bucket === 'Float' ? 'Withdrawable' : 'Float'} balance</p><p className="text-sm font-semibold">{amount(bucket === 'Float' ? 210000 : 250000)}</p></div><span className="mb-1 text-[8px] opacity-60">Last updated just now</span></div>
          </section>
          <div className="grid grid-cols-4 gap-1" aria-label="Agent shortcuts">
            {SHORTCUTS.map(({ label, Icon, color, to }) => <Button key={label} variant="ghost" onClick={() => (to ? navigate(to) : setNotice(label))} className="h-[64px] flex-col gap-1 px-0 text-[10px]"><span className={cn('flex h-8 w-8 items-center justify-center rounded-full bg-card', color)}><Icon className="!h-4 !w-4" /></span>{label}</Button>)}
          </div>
          <section aria-labelledby="capacity-heading" className="rounded-[14px] border border-primary/25 bg-card p-4">
            <div className="flex items-center justify-between"><h1 id="capacity-heading" className="text-xs font-semibold">Today's Capacity</h1><span className="text-xs font-bold text-primary">{CAPACITY_PCT}%</span></div>
            <p className="mt-3 text-xl font-bold text-primary">{formatUGX(COLLECTED_TODAY)}</p><p className="text-[11px] text-muted-foreground">collected of {formatUGX(EXPECTED_TODAY)} expected today</p>
            <progress aria-label="Today's capacity progress" value={CAPACITY_PCT} max={100} className="agents-mock-progress mt-3 block h-1.5 w-full rounded-full" />
            <div className="mt-3 flex justify-between text-[10px]"><span className="text-muted-foreground">{TENANTS_DONE} of {TENANTS_TOTAL} tenants completed</span><span className="font-semibold text-primary">{formatUGX(EXPECTED_TODAY - COLLECTED_TODAY)} left</span></div>
          </section>
          <section className="flex h-[142px] flex-col items-center justify-center rounded-[16px] bg-card text-center" aria-label="Today's scheduled collections">
            <span className="mb-2 flex h-9 w-9 items-center justify-center rounded-full bg-background text-muted-foreground"><CalendarDays className="h-4 w-4" /></span><h2 className="text-[11px] font-semibold">No collections scheduled</h2><p className="mt-1 max-w-[180px] text-[10px] leading-3 text-muted-foreground">There are no rent repayments due for collection today.</p>
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
