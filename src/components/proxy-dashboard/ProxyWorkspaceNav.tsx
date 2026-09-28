import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Home, FileText, Users, Wallet, LayoutGrid, Share2, BarChart3, HelpCircle, Building2, ArrowLeft } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';

export type ProxySection = 'home' | 'notes' | 'partners' | 'earnings' | 'invite' | 'reports' | 'houses';

export const sectionPath = (s: ProxySection) => (s === 'home' ? '/dashboard/agent/proxy' : `/dashboard/agent/proxy/${s}`);

const DESKTOP: { id: ProxySection; label: string; icon: typeof Home }[] = [
  { id: 'home', label: 'Overview', icon: Home },
  { id: 'notes', label: 'Promissory Notes', icon: FileText },
  { id: 'partners', label: 'Partners', icon: Users },
  { id: 'earnings', label: 'Earnings', icon: Wallet },
  { id: 'invite', label: 'Invite & Share', icon: Share2 },
  { id: 'reports', label: 'Reports', icon: BarChart3 },
  { id: 'houses', label: 'Houses', icon: Building2 },
];

const MOBILE: { id: ProxySection; label: string; icon: typeof Home }[] = [
  { id: 'home', label: 'Home', icon: Home },
  { id: 'notes', label: 'Notes', icon: FileText },
  { id: 'partners', label: 'Partners', icon: Users },
  { id: 'earnings', label: 'Earnings', icon: Wallet },
];

export function ProxySidebar({ active }: { active: ProxySection }) {
  return (
    <aside className="sticky top-0 hidden h-screen w-56 shrink-0 flex-col border-r bg-card px-3 py-4 md:flex">
      <Link to="/dashboard/agent" className="mb-4 flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
        <ArrowLeft className="h-3.5 w-3.5" />Agent dashboard
      </Link>
      <p className="mb-2 px-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Proxy workspace</p>
      <nav className="space-y-0.5" aria-label="Proxy workspace">
        {DESKTOP.map(({ id, label, icon: Icon }) => (
          <Link
            key={id}
            to={sectionPath(id)}
            aria-current={active === id ? 'page' : undefined}
            className={cn(
              'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              active === id ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            <Icon className="h-4 w-4 shrink-0" />{label}
          </Link>
        ))}
      </nav>
    </aside>
  );
}

export function ProxyMobileNav({ active, onHowItWorks }: { active: ProxySection; onHowItWorks: () => void }) {
  const [more, setMore] = useState(false);
  const moreActive = active === 'invite' || active === 'reports' || active === 'houses';
  const item = 'flex min-h-[52px] flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-medium transition-colors active:scale-95';
  return (
    <>
      <nav
        aria-label="Proxy workspace"
        className="fixed inset-x-0 bottom-0 z-40 flex border-t bg-card/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
      >
        {MOBILE.map(({ id, label, icon: Icon }) => (
          <Link key={id} to={sectionPath(id)} aria-current={active === id ? 'page' : undefined}
            className={cn(item, active === id ? 'text-primary' : 'text-muted-foreground')}>
            <Icon className="h-5 w-5" />{label}
          </Link>
        ))}
        <button type="button" onClick={() => setMore(true)} className={cn(item, moreActive ? 'text-primary' : 'text-muted-foreground')}>
          <LayoutGrid className="h-5 w-5" />More
        </button>
      </nav>
      <Sheet open={more} onOpenChange={setMore}>
        <SheetContent side="bottom" className="rounded-t-2xl pb-[calc(1rem+env(safe-area-inset-bottom))]">
          <SheetHeader><SheetTitle>More</SheetTitle></SheetHeader>
          <div className="mt-3 grid gap-1">
            {[
              { id: 'invite' as const, label: 'Invite & Share', sub: 'Your invite link and how it performs', icon: Share2 },
              { id: 'reports' as const, label: 'Reports', sub: 'Performance over time', icon: BarChart3 },
              { id: 'houses' as const, label: 'All houses', sub: 'Every house you can work on', icon: Building2 },
            ].map(({ id, label, sub, icon: Icon }) => (
              <Link key={id} to={sectionPath(id)} onClick={() => setMore(false)} className="flex items-center gap-3 rounded-lg p-3 hover:bg-muted">
                <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary"><Icon className="h-4 w-4" /></span>
                <span><span className="block text-sm font-semibold">{label}</span><span className="block text-xs text-muted-foreground">{sub}</span></span>
              </Link>
            ))}
            <button type="button" onClick={() => { setMore(false); onHowItWorks(); }} className="flex items-center gap-3 rounded-lg p-3 text-left hover:bg-muted">
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary"><HelpCircle className="h-4 w-4" /></span>
              <span><span className="block text-sm font-semibold">How it works</span><span className="block text-xs text-muted-foreground">How proxy agents earn</span></span>
            </button>
            <Link to="/dashboard/agent" className="flex items-center gap-3 rounded-lg p-3 hover:bg-muted">
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted text-muted-foreground"><ArrowLeft className="h-4 w-4" /></span>
              <span className="text-sm font-semibold">Back to Agent dashboard</span>
            </Link>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
