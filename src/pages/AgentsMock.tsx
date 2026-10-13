import { useEffect, useRef, useState } from 'react';
import { Helmet } from 'react-helmet-async';
import { ArrowDownLeft, ArrowRight, Banknote, Check, CheckCheck, ChevronDown, FileText, Home, MapPin, Menu, Plus, Sun, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { formatUGX } from '@/lib/rentCalculations';
import { cn } from '@/lib/utils';
import { loadMockTenantPage, MOCK_TENANTS, MOCK_TOTALS, type MockTenant } from './agentsMockData';
import agentAvatar from '@/assets/agents-mock-avatar.jpg';

type Filter = 'All' | 'Due' | 'Partial' | 'Paid';
const statusOf = (tenant: MockTenant): Filter => tenant.collected >= tenant.expected ? 'Paid' : tenant.collected > 0 ? 'Partial' : 'Due';
const initials = (name: string) => name.split(' ').map(part => part[0]).slice(0, 2).join('');

export default function AgentsMock() {
  const [tenants, setTenants] = useState<MockTenant[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<Filter>('All');
  const [activeNav, setActiveNav] = useState('Home');
  const [selected, setSelected] = useState<MockTenant | null>(null);
  const [notice, setNotice] = useState<'post' | 'more' | null>(null);
  const [imageFailed, setImageFailed] = useState(false);
  const tenantsRef = useRef<HTMLElement>(null);
  const busy = useRef(false);
  useEffect(() => {
    let alive = true;
    void loadMockTenantPage(0).then(rows => { if (alive) setTenants(rows); });
    return () => { alive = false; };
  }, []);
  const loadMore = async () => {
    if (busy.current) return;
    busy.current = true;
    setLoading(true);
    try { const rows = await loadMockTenantPage(tenants.length); setTenants(current => [...current, ...rows]); }
    finally { busy.current = false; setLoading(false); }
  };
  const visible = tenants.filter(tenant => filter === 'All' || statusOf(tenant) === filter);
  const progress = Math.round(MOCK_TOTALS.collected / MOCK_TOTALS.expected * 100);
  const date = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Kampala', weekday: 'long', day: 'numeric', month: 'long' }).format(new Date());
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Kampala', hour: 'numeric', hourCycle: 'h23' }).format(new Date()));
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const chooseNav = (label: string) => {
    setActiveNav(label);
    if (label === 'Home') window.scrollTo({ top: 0, behavior: 'smooth' });
    else if (label === 'Tenants' || label === 'Collect') {
      setFilter(label === 'Collect' ? 'Due' : 'All');
      tenantsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else setNotice(label === 'More' ? 'more' : 'post');
  };

  return (
    <div className="min-h-screen bg-background text-foreground font-sans tracking-normal pb-24">
      <Helmet><title>Agent dashboard preview · Welile</title><meta name="description" content="Welile agent dashboard design preview." /><meta name="robots" content="noindex,nofollow" /></Helmet>
      <div className="mx-auto max-w-2xl px-4 sm:px-6">
        <header className="flex items-center justify-between gap-3 py-4 sm:py-6">
          <div className="flex min-w-0 items-center gap-3 sm:gap-4">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full border-2 border-primary/15 bg-primary/10 text-primary font-bold">
              {imageFailed ? 'AM' : <img src={agentAvatar} width={56} height={56} alt="Sample agent avatar" className="h-full w-full object-cover" onError={() => setImageFailed(true)} />}
            </div>
            <div className="min-w-0"><p className="flex items-center gap-1.5 text-[11px] text-muted-foreground"><Sun className="h-3 w-3 text-warning" />{greeting},</p><h1 className="mt-0.5 text-base sm:text-lg font-bold">Alex Mugisha</h1></div>
          </div>
          <span className="shrink-0 rounded-full border border-border px-2 py-1 text-[10px] font-medium text-muted-foreground">Sample data</span>
        </header>

        <section aria-labelledby="today-heading" className="agents-mock-summary overflow-hidden rounded-lg p-5 sm:p-6 shadow-card">
          <div className="flex items-center justify-between gap-2"><h2 id="today-heading" className="text-sm font-bold">Today's collections</h2><Banknote className="h-5 w-5 opacity-70" /></div>
          <p className="mt-4 text-[11px] opacity-80">Rent expected today</p>
          <p className="mt-1 text-3xl font-bold tabular-nums">{formatUGX(MOCK_TOTALS.expected)}</p>
          <div className="mt-4 flex items-end justify-between gap-3"><div><p className="flex items-center gap-1 text-[11px] opacity-80"><ArrowDownLeft className="h-3 w-3" />Collected today</p><p className="mt-1 text-xl font-semibold tabular-nums">{formatUGX(MOCK_TOTALS.collected)}</p></div><p className="text-right text-[10px] opacity-80">{MOCK_TENANTS.length} tenants<br />{date}</p></div>
          <div className="mt-4"><progress aria-label="Today's collection progress" value={progress} max={100} className="agents-mock-progress block h-1 w-full overflow-hidden rounded-full" /><div className="mt-2 flex justify-between gap-2 text-[10px] opacity-90"><span>{progress}% collected</span><span>{formatUGX(MOCK_TOTALS.expected - MOCK_TOTALS.collected)} left</span></div></div>
        </section>

        <section className="py-4 sm:py-5" aria-label="Post rent request and earnings">
          <Button aria-label="Post rent request" variant="outline" className="h-auto w-full flex-col items-stretch gap-0 whitespace-normal rounded-lg border-primary/20 bg-card px-4 py-4 text-left hover:bg-primary/5" onClick={() => setNotice('post')}>
            <span className="flex items-center gap-3"><span className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/10 text-primary"><Plus className="h-5 w-5" /></span><span className="flex-1"><span className="block text-sm font-bold">Post rent request</span><span className="mt-0.5 block text-[10px] font-normal text-muted-foreground">Make a move. Earn at every step.</span></span><ArrowRight className="text-primary" /></span>
            <span className="mt-3 grid grid-cols-3 gap-3 border-t border-border pt-3">
              {[{ value: formatUGX(5000), text: 'When you post' }, { value: '1%', text: 'Landlord paid' }, { value: '10%', text: 'Tenant repays' }].map(({ value, text }, index) => <span key={text} className={cn('min-w-0', index > 0 && 'border-l border-border pl-3')}><span className="block text-sm font-bold text-primary">{value}</span><span className="mt-1 block text-[10px] font-normal text-muted-foreground">{text}</span></span>)}
            </span>
          </Button>
        </section>

        <section ref={tenantsRef} aria-labelledby="tenants-heading" className="scroll-mt-6">
          <div className="flex items-center justify-between gap-3"><h2 id="tenants-heading" className="text-sm sm:text-base font-bold">Repaying today</h2><span className="rounded-full bg-primary/10 px-2 py-1 text-[10px] font-semibold text-primary">{MOCK_TENANTS.length} tenants</span></div>
          <div className="mt-3 mb-2 flex gap-1 rounded-lg bg-muted p-1" role="group" aria-label="Payment status">
            {(['All', 'Due', 'Partial', 'Paid'] as Filter[]).map(item => <Button key={item} variant="ghost" size="sm" aria-pressed={filter === item} onClick={() => setFilter(item)} className={cn('flex-1 rounded-md text-xs', filter === item ? 'bg-card text-foreground shadow-soft' : 'text-muted-foreground')}>{item}<span className="hidden sm:inline text-[10px] opacity-70">{MOCK_TENANTS.filter(t => item === 'All' || statusOf(t) === item).length}</span></Button>)}
          </div>
          <div className="divide-y divide-border border-y border-border">
            {visible.map(tenant => {
              const status = statusOf(tenant);
              return <article key={tenant.id} className="flex items-center gap-2 py-3 sm:gap-3" data-testid="mock-tenant">
                <span className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[10px] font-bold', status === 'Paid' ? 'bg-success/10 text-success' : status === 'Partial' ? 'bg-warning/10 text-warning' : 'bg-primary/10 text-primary')}>{initials(tenant.name)}</span>
                <div className="min-w-0 flex-1"><h3 className="truncate text-xs sm:text-sm font-semibold">{tenant.name}</h3><p className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground"><MapPin className="h-3 w-3 shrink-0" />{tenant.area}</p></div>
                <div className="shrink-0 text-right"><p className="text-sm font-semibold tabular-nums">{formatUGX(tenant.expected)}</p><p className={cn('mt-1 flex items-center justify-end gap-1 text-[10px] font-medium', status === 'Paid' ? 'text-success' : status === 'Partial' ? 'text-warning' : 'text-muted-foreground')}>{status === 'Paid' && <CheckCheck className="h-3 w-3" />}{status === 'Partial' ? `${formatUGX(tenant.collected)} paid` : status === 'Paid' ? 'Paid today' : 'Due today'}</p></div>
                <Button variant="ghost" size="icon-sm" aria-label={`View ${tenant.name}`} className="shrink-0 text-muted-foreground" onClick={() => setSelected(tenant)}><ArrowRight /></Button>
              </article>;
            })}
            {visible.length === 0 && <p className="py-10 text-center text-sm text-muted-foreground">No {filter.toLowerCase()} tenants in this batch.</p>}
          </div>
          <div className="flex flex-col items-center gap-3 pt-5"><p className="text-[11px] text-muted-foreground">{tenants.length} of {MOCK_TENANTS.length} tenants loaded</p>{tenants.length < MOCK_TENANTS.length ? <Button variant="outline" className="w-full rounded-lg sm:w-64" onClick={loadMore} disabled={loading}>{loading ? 'Loading…' : 'Load 10 more'}<ChevronDown /></Button> : <p className="flex items-center gap-1 text-xs text-muted-foreground"><Check className="h-3.5 w-3.5" />All tenants loaded</p>}</div>
        </section>
      </div>

      <nav aria-label="Agent navigation" className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-card pb-safe"><div className="mx-auto grid max-w-2xl grid-cols-5 px-2 py-1">
        {[{ label: 'Home', Icon: Home }, { label: 'Tenants', Icon: Users }, { label: 'Collect', Icon: Banknote }, { label: 'Post Rent', Icon: FileText }, { label: 'More', Icon: Menu }].map(({ label, Icon }) => <Button key={label} variant="ghost" aria-current={activeNav === label ? 'page' : undefined} onClick={() => chooseNav(label)} className="h-[58px] flex-col gap-0.5 rounded-lg px-0 text-foreground hover:bg-primary/5"><span className={cn('flex h-8 w-8 items-center justify-center rounded-full text-primary', activeNav === label && 'bg-primary/10')}><Icon className="!h-5 !w-5" strokeWidth={1.8} /></span><span className="text-[10px] font-medium">{label}</span></Button>)}
      </div></nav>
      <Dialog open={selected !== null || notice !== null} onOpenChange={open => { if (!open) { setSelected(null); setNotice(null); } }}>
        <DialogContent className="rounded-lg"><DialogHeader><DialogTitle>{selected?.name ?? (notice === 'post' ? 'Post rent request' : 'More')}</DialogTitle><DialogDescription>{selected ? selected.area : 'This section is reserved for the next design stage.'}</DialogDescription></DialogHeader>
          {selected && <dl className="space-y-4 py-3"><div className="flex justify-between text-sm"><dt className="text-muted-foreground">Expected today</dt><dd className="font-semibold">{formatUGX(selected.expected)}</dd></div><div className="flex justify-between text-sm"><dt className="text-muted-foreground">Collected today</dt><dd className="font-semibold text-success">{formatUGX(selected.collected)}</dd></div><div className="flex justify-between border-t border-border pt-4 text-sm"><dt className="text-muted-foreground">Remaining today</dt><dd className="font-semibold">{formatUGX(selected.expected - selected.collected)}</dd></div></dl>}
        </DialogContent>
      </Dialog>
    </div>
  );
}