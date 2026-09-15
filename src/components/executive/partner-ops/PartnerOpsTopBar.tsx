import { useEffect, useMemo, useRef, useState } from 'react';
import { Menu, Search, X } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { PartnerOpsSidebar } from './PartnerOpsSidebar';
import { searchPartnerOpsNav, type PartnerOpsViewKey } from './partnerOpsNav';
import { BudgetDepartmentNotificationBell } from '@/components/budget/BudgetDepartmentNotificationBell';
import { PromissoryNotesHeaderButton } from './PromissoryNotesHeaderButton';

interface Props {
  active: PartnerOpsViewKey;
  onSelect: (view: PartnerOpsViewKey) => void;
  badges?: Partial<Record<PartnerOpsViewKey, number>>;
  actions?: React.ReactNode;
}

export function PartnerOpsTopBar({ active, onSelect, badges, actions }: Props) {
  const { user } = useAuth();
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const blurTimer = useRef<number | null>(null);

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 30000);
    return () => window.clearInterval(id);
  }, []);

  const { data: profileName } = useQuery({
    queryKey: ['partner-ops-topbar-profile', user?.id],
    enabled: !!user?.id,
    staleTime: 300000,
    queryFn: async () => {
      const { data } = await supabase.from('profiles').select('full_name').eq('id', user!.id).maybeSingle();
      return data?.full_name || null;
    },
  });

  const results = useMemo(() => searchPartnerOpsNav(query), [query]);
  const showResults = focused && query.trim().length > 0;

  const pick = (view: PartnerOpsViewKey) => {
    onSelect(view);
    setQuery('');
    setFocused(false);
  };

  const displayName = profileName || user?.email || 'Signed in';
  const initials = displayName
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase())
    .join('');

  return (
    <div className="sticky top-0 z-30 -mx-4 border-b border-border/60 bg-card px-4 py-2">
      <div className="flex flex-wrap items-center gap-2">
        {/* mobile nav */}
        <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8 lg:hidden" aria-label="Open Partner Ops menu">
              <Menu className="h-4 w-4" />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="w-72 p-0">
            <div className="border-b px-4 py-3 text-sm font-bold">Partner Ops</div>
            <PartnerOpsSidebar
              active={active}
              badges={badges}
              onSelect={(v) => { onSelect(v); setMobileNavOpen(false); }}
              className="h-[calc(100vh-3.25rem)]"
            />
          </SheetContent>
        </Sheet>

        <h1 className="text-sm font-bold sm:text-base">Partner Ops</h1>

        {/* search */}
        <div className="relative order-last w-full min-w-[180px] flex-1 sm:order-none sm:w-auto">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => { blurTimer.current = window.setTimeout(() => setFocused(false), 150); }}
            placeholder="Search sections…"
            className="h-8 pl-8 pr-7 text-xs"
            aria-label="Search Partner Ops sections"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              aria-label="Clear search"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
          {showResults && (
            <div className="absolute left-0 right-0 top-9 z-40 overflow-hidden rounded-lg border bg-popover shadow-lg">
              {results.length === 0 ? (
                <p className="px-3 py-2.5 text-xs text-muted-foreground">No matching section</p>
              ) : (
                <ul className="max-h-72 overflow-y-auto py-1">
                  {results.map((r) => {
                    const Icon = r.icon;
                    return (
                      <li key={r.view}>
                        <button
                          type="button"
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => { if (blurTimer.current) window.clearTimeout(blurTimer.current); pick(r.view); }}
                          className={cn(
                            'flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-muted',
                            active === r.view && 'bg-muted/60 font-semibold'
                          )}
                        >
                          <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                          <span className="truncate">{r.label}</span>
                          {r.parentLabel && (
                            <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">{r.parentLabel}</span>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}
        </div>

        <BudgetDepartmentNotificationBell dashboard="partner-ops" />

        <PromissoryNotesHeaderButton
          active={active === 'proxy.promissory'}
          onClick={() => onSelect('proxy.promissory')}
        />

        {actions}

        {/* date & time */}
        <div className="hidden text-right leading-tight md:block">
          <p className="text-[11px] font-semibold">{format(now, 'EEE d MMM yyyy')}</p>
          <p className="text-[10px] text-muted-foreground">{format(now, 'HH:mm')} EAT</p>
        </div>

        {/* current user */}
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/10 text-[10px] font-bold text-primary">
            {initials || 'U'}
          </div>
          <span className="hidden max-w-[140px] truncate text-xs font-medium sm:inline">{displayName}</span>
        </div>
      </div>
    </div>
  );
}