import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Calendar as CalendarIcon, Settings, ChevronDown, X, Menu, Type } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/sheet';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { fontSizeOptions, useFontSize, type FontSize } from '@/hooks/useFontSize';
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
  const { fontSize, setFontSize } = useFontSize();
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
    <header className="border-b border-border bg-card px-2.5 py-2 sm:px-4 lg:px-6 sticky top-0 z-30 shadow-xs">
      <div className="flex flex-wrap items-center gap-1.5 sm:gap-3">
        {/* Left: Mobile Trigger + Logo & Title */}
        <div className="flex min-w-0 items-center gap-2">
          <Sheet open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="h-11 w-11 lg:hidden" aria-label="Open menu">
                <Menu className="h-5 w-5" />
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
            <span className="hidden min-[360px]:inline-flex"><WelileLogo showText size="sm" linkToHome={false} /></span>
            <span className="min-[360px]:hidden"><WelileLogo size="sm" linkToHome={false} /></span>
            <span className="hidden truncate text-xs font-bold text-foreground pl-2 border-l border-border sm:inline lg:text-sm">
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
            className="h-11 pl-9 pr-9 text-sm bg-muted/30 border-border rounded-lg sm:h-9 sm:text-xs"
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

          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-11 w-11 text-muted-foreground hover:text-foreground sm:h-9 sm:w-9"
                aria-label={`Text size: ${fontSize.replace('-', ' ')}`}
              >
                <Type className="h-5 w-5 sm:h-4 sm:w-4" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-60 p-3">
              <p className="mb-2 text-sm font-semibold">Text size</p>
              <div className="grid grid-cols-2 gap-2">
                {fontSizeOptions.map((option) => (
                  <Button
                    key={option.value}
                    type="button"
                    variant={fontSize === option.value ? 'default' : 'outline'}
                    className="h-11 justify-start px-3"
                    onClick={() => setFontSize(option.value as FontSize)}
                  >
                    {option.label}
                  </Button>
                ))}
              </div>
            </PopoverContent>
          </Popover>

          <Button
            variant="ghost"
            size="icon"
            className="h-11 w-11 text-muted-foreground hover:text-foreground sm:h-9 sm:w-9"
            aria-label="Settings"
            onClick={() => navigate('/settings')}
          >
            <Settings className="h-4 w-4" />
          </Button>

          <button
            type="button"
            onClick={() => navigate('/settings')}
            className="hidden items-center gap-2 pl-1 border-l border-border group sm:flex sm:pl-2"
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
