import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Calendar as CalendarIcon, Settings, ChevronDown, X, Menu } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import WelileLogo from '@/components/WelileLogo';
import { AgentNotificationBell } from '@/components/agent/AgentNotificationBell';
import { LandlordOpsSidebar } from './LandlordOpsSidebar';
import { searchLandlordOpsNav } from './landlordOpsNav';

interface TopBarProps {
  activePath: string;
  onNavigate: (path: string) => void;
  badges?: Record<string, number>;
}

const KAMPALA = 'Africa/Kampala';

function formatKampalaDate(d: Date) {
  return d.toLocaleDateString('en-GB', {
    timeZone: KAMPALA,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function formatKampalaTime(d: Date) {
  return d.toLocaleTimeString('en-GB', {
    timeZone: KAMPALA,
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function LandlordOpsTopBar({ activePath, onNavigate, badges }: TopBarProps) {
  const navigate = useNavigate();
  const { user, role } = useAuth();
  const [searchQuery, setSearchQuery] = useState('');
  const [focused, setFocused] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const blurTimer = useRef<number | null>(null);

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 30000);
    return () => window.clearInterval(id);
  }, []);

  const { data: profile } = useQuery({
    queryKey: ['landlord-ops-topbar-profile', user?.id],
    enabled: !!user?.id,
    staleTime: 300000,
    queryFn: async () => {
      const { data } = await supabase
        .from('profiles')
        .select('full_name, email')
        .eq('id', user!.id)
        .maybeSingle();
      return data ?? null;
    },
  });

  const displayName = profile?.full_name || profile?.email || user?.email || 'Signed in';
  const initials = displayName
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase())
    .join('');

  const roleLabel = (role || 'landlord_ops')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());

  const results = useMemo(() => searchLandlordOpsNav(searchQuery), [searchQuery]);
  const showResults = focused && searchQuery.trim().length > 0;

  const pick = (path: string) => {
    onNavigate(path);
    setSearchQuery('');
    setFocused(false);
  };

  return (
    <header className="border-b border-border bg-card px-3 py-2 sm:px-4 lg:px-6 sticky top-0 z-30 shadow-xs">
      <div className="flex flex-wrap items-center gap-2 sm:gap-3">
        {/* Left: Mobile Trigger + Logo & Title */}
        <div className="flex min-w-0 items-center gap-2">
          <Sheet open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="h-9 w-9 lg:hidden" aria-label="Open menu">
                <Menu className="h-4 w-4" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-[85vw] max-w-xs p-0">
            <div className="p-4 border-b border-border flex items-center gap-2">
                <WelileLogo showText size="sm" linkToHome={false} />
                <span className="text-xs font-bold text-foreground">Landlord Operations</span>
              </div>
              <LandlordOpsSidebar
                activePath={activePath}
                onNavigate={(p) => {
                  onNavigate(p);
                  setMobileMenuOpen(false);
                }}
                badges={badges}
                className="h-[calc(100dvh-3.75rem)]"
              />
            </SheetContent>
          </Sheet>

          <button
            type="button"
            className="flex min-w-0 items-center gap-2"
            onClick={() => onNavigate('')}
          >
            <span className="font-black text-base lg:text-lg tracking-tight text-[#0FA958]">WELILE</span>
            <span className="hidden truncate text-xs font-bold text-foreground pl-1 border-l border-border sm:inline lg:text-sm">
              Landlord Operations
            </span>
          </button>
        </div>

        {/* Search — full width row on small screens */}
        <div className="relative order-last w-full min-w-[160px] flex-1 sm:order-none sm:w-auto sm:max-w-md">
          <Search className="h-3.5 w-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => {
              blurTimer.current = window.setTimeout(() => setFocused(false), 150);
            }}
            placeholder="Search sections…"
            aria-label="Search Landlord Ops sections"
            className="h-9 pl-8 pr-7 text-xs bg-muted/30 border-border rounded-lg"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
          {showResults && (
            <div className="absolute left-0 right-0 top-10 z-40 overflow-hidden rounded-lg border bg-popover shadow-lg">
              {results.length === 0 ? (
                <p className="px-3 py-2.5 text-xs text-muted-foreground">No matching section</p>
              ) : (
                <ul className="max-h-72 overflow-y-auto py-1">
                  {results.map((r) => {
                    const Icon = r.icon;
                    const count = r.badgeKey ? badges?.[r.badgeKey] ?? 0 : 0;
                    return (
                      <li key={r.key}>
                        <button
                          type="button"
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => {
                            if (blurTimer.current) window.clearTimeout(blurTimer.current);
                            pick(r.path);
                          }}
                          className={cn(
                            'flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-muted',
                            activePath === r.path && 'bg-muted/60 font-semibold',
                          )}
                        >
                          <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                          <span className="truncate">{r.label}</span>
                          {count > 0 && (
                            <span className="ml-auto shrink-0 rounded-full bg-rose-500/10 px-1.5 text-[10px] font-bold text-rose-600">
                              {count}
                            </span>
                          )}
                          {!count && r.parentLabel && (
                            <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                              {r.parentLabel}
                            </span>
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

        {/* Right cluster */}
        <div className="ml-auto flex items-center gap-1 sm:gap-2">
          {/* Live date & time (Kampala) */}
          <div className="hidden items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 py-1 md:flex">
            <CalendarIcon className="h-3.5 w-3.5 text-muted-foreground" />
            <div className="leading-tight">
              <p className="text-[11px] font-medium text-foreground">{formatKampalaDate(now)}</p>
              <p className="text-[10px] text-muted-foreground">{formatKampalaTime(now)} EAT</p>
            </div>
          </div>

          {user?.id && <AgentNotificationBell userId={user.id} />}

          <Button
            variant="ghost"
            size="icon"
            className="h-9 w-9 text-muted-foreground hover:text-foreground"
            aria-label="Settings"
            onClick={() => navigate('/settings')}
          >
            <Settings className="h-4 w-4" />
          </Button>

          <button
            type="button"
            onClick={() => navigate('/settings')}
            className="flex items-center gap-2 pl-1 sm:pl-2 border-l border-border group"
          >
            <div className="h-7 w-7 shrink-0 rounded-full bg-primary/10 text-primary flex items-center justify-center font-bold text-[10px]">
              {initials || 'U'}
            </div>
            <div className="hidden text-left leading-tight lg:block">
              <p className="max-w-[140px] truncate text-xs font-semibold text-foreground group-hover:text-[#0FA958] transition-colors">
                {displayName}
              </p>
              <p className="text-[10px] text-muted-foreground">{roleLabel}</p>
            </div>
            <ChevronDown className="hidden h-3 w-3 text-muted-foreground lg:block" />
          </button>
        </div>
      </div>
    </header>
  );
}
