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
import { TenantOpsSidebar } from './TenantOpsSidebar';
import { searchTenantOpsNav, type TenantOpsActionKey, type TenantOpsViewKey } from './tenantOpsNav';

interface Props {
  active: TenantOpsViewKey | TenantOpsActionKey;
  onSelect: (key: TenantOpsViewKey | TenantOpsActionKey) => void;
  badges?: Partial<Record<string, number>>;
  actions?: React.ReactNode;
}

/** Tenant Ops top bar — mirror of the Partner Ops one (hamburger sheet nav on
 *  mobile, section search, user chip, and an `actions` slot). */
export function TenantOpsTopBar({ active, onSelect, badges, actions }: Props) {
  const { user, roles } = useAuth();
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
    queryKey: ['tenant-ops-topbar-profile', user?.id],
    enabled: !!user?.id,
    staleTime: 300000,
    queryFn: async () => {
      const { data } = await supabase.from('profiles').select('full_name').eq('id', user!.id).maybeSingle();
      return data?.full_name || null;
    },
  });

  const results = useMemo(() => searchTenantOpsNav(query, roles), [query, roles]);
  const showResults = focused && query.trim().length > 0;

  const pick = (key: TenantOpsViewKey | TenantOpsActionKey) => {
    onSelect(key);
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
    <div className="sticky top-0 z-30 -mx-4 border-b border-border/60 bg-card px-4 py-2.5 sm:py-2">
      <div className="flex flex-wrap items-center gap-2 sm:gap-3">
        {/* mobile nav */}
        <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon" className="h-10 w-10 lg:hidden" aria-label="Open Tenant Ops menu">
              <Menu className="h-5 w-5" />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="w-80 p-0 sm:w-72">
            <div className="border-b px-4 py-3.5 text-base font-bold">Tenant Ops</div>
            <TenantOpsSidebar
              active={active}
              badges={badges}
              onSelect={(v) => { onSelect(v); setMobileNavOpen(false); }}
              className="h-[calc(100vh-3.5rem)]"
            />
          </SheetContent>
        </Sheet>

        <h1 className="text-sm font-bold sm:text-base">Tenant Ops</h1>

        {/* search */}
        <div className="relative order-last w-full min-w-[180px] flex-1 sm:order-none sm:w-auto">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => { blurTimer.current = window.setTimeout(() => setFocused(false), 150); }}
            placeholder="Search sections…"
            className="h-9 pl-8 pr-7 text-xs sm:h-8"
            aria-label="Search Tenant Ops sections"
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
                      <li key={String(r.view)}>
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
