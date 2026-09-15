import { ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/integrations/supabase/client';
import { X, ArrowLeft, Menu, Home, LayoutGrid } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { PERSONAL_NAV } from './personalNav';

const SIDEBAR_WIDTH_KEY = 'personal-sidebar-width';
const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 420;
const SIDEBAR_DEFAULT = 240;

const readSidebarWidth = () => {
  try {
    const raw = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    const n = raw ? Number(raw) : NaN;
    if (Number.isFinite(n)) return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, n));
  } catch { /* storage unavailable */ }
  return SIDEBAR_DEFAULT;
};

const getInitials = (name: string) => {
  if (!name) return 'Me';
  return name
    .split(' ')
    .map((part) => part[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
};

interface PersonalLayoutProps {
  children: ReactNode;
  title?: string;
}

const PersonalLayout = ({ children, title }: PersonalLayoutProps) => {
  const { user, roles, switchRole } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [displayName, setDisplayName] = useState('');
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState<number>(readSidebarWidth);
  const [resizing, setResizing] = useState(false);
  const dragStart = useRef<{ x: number; width: number } | null>(null);

  const onResizePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    dragStart.current = { x: e.clientX, width: sidebarWidth };
    setResizing(true);

    const onMove = (ev: PointerEvent) => {
      if (!dragStart.current) return;
      const next = dragStart.current.width + (ev.clientX - dragStart.current.x);
      setSidebarWidth(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, next)));
    };
    const onUp = () => {
      dragStart.current = null;
      setResizing(false);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      setSidebarWidth((w) => {
        try { localStorage.setItem(SIDEBAR_WIDTH_KEY, String(Math.round(w))); } catch { /* ignore */ }
        return w;
      });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [sidebarWidth]);

  const { data: isPsoOfficer } = useQuery<boolean>({
    queryKey: ['pso-is-officer'],
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('pso_is_officer' as any);
      if (error) return false;
      return data === true;
    },
  });

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (!user) return;
      const { data } = await supabase
        .from('profiles')
        .select('full_name, avatar_url')
        .eq('id', user.id)
        .maybeSingle();
      if (!cancelled) {
        if (data?.full_name) setDisplayName(data.full_name);
        setAvatarUrl(data?.avatar_url || null);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [user]);

  const goToFunderDashboard = () => {
    if (roles?.includes('supporter')) switchRole('supporter');
    navigate('/dashboard', { replace: true });
  };

  const isOnHub = location.pathname === '/me';

  const isActive = (to: string) =>
    location.pathname === to || location.pathname.startsWith(to + '/');

  /** One menu row. Mirrors the executive sidebar's row treatment so My Space
   *  reads as part of the same product. */
  const NavRow = ({ to, icon: Icon, label }: { to: string; icon: typeof Home; label: string }) => (
    <Link
      to={to}
      onClick={() => setMenuOpen(false)}
      className={cn(
        'flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm transition-all select-none active:scale-[0.98]',
        isActive(to)
          ? 'bg-primary/10 font-semibold text-primary'
          : 'text-muted-foreground hover:bg-primary/5 hover:text-primary',
      )}
      style={{ touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent' }}
    >
      <Icon className="h-4 w-4 shrink-0" />
      <span className="truncate">{label}</span>
    </Link>
  );

  const MenuBody = () => (
    <nav className="flex h-full flex-col gap-6 overflow-y-auto py-5">
      <div>
        <p className="mb-2.5 px-4 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          My space
        </p>
        <div className="space-y-1 px-2">
          <NavRow to="/me" icon={LayoutGrid} label="Overview" />
        </div>
      </div>

      <div>
        <p className="mb-2.5 px-4 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Tools and records
        </p>
        <div className="space-y-1 px-2">
          {PERSONAL_NAV.filter((item) => !item.requiresPsoOfficer || isPsoOfficer === true)
            .map((item) => (
              <NavRow key={item.to} to={item.to} icon={item.icon} label={item.title} />
            ))}
        </div>
      </div>

      <div className="mx-2 mt-auto border-t border-border px-2 pt-4">
        <button
          type="button"
          onClick={() => { setMenuOpen(false); goToFunderDashboard(); }}
          className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-muted-foreground transition-colors select-none hover:bg-muted hover:text-foreground active:scale-[0.98]"
          style={{ touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent' }}
        >
          <ArrowLeft className="h-4 w-4 shrink-0" />
          <span>Back to app</span>
        </button>
      </div>
    </nav>
  );

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-30 border-b border-border/60 bg-card/80 backdrop-blur supports-[backdrop-filter]:bg-card/70 pt-safe">
        <div className="mx-auto w-full max-w-7xl px-3 sm:px-4">
          <div className="flex items-center gap-2 py-2.5 sm:gap-3">
            <button
              type="button"
              onClick={() => setMenuOpen(true)}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:hidden"
              aria-label="Open My space menu"
            >
              <Menu className="h-4 w-4" />
            </button>

            {!isOnHub && (
              <button
                type="button"
                onClick={() => navigate('/me')}
                className="hidden h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:flex"
                aria-label="Back to My space"
              >
                <ArrowLeft className="h-4 w-4" />
              </button>
            )}

            <Avatar className="h-9 w-9 shrink-0 border border-border/70 sm:h-10 sm:w-10">
              <AvatarImage src={avatarUrl || ''} alt={displayName || 'Your profile'} />
              <AvatarFallback className="bg-primary/10 text-xs font-semibold text-primary">
                {getInitials(displayName)}
              </AvatarFallback>
            </Avatar>

            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold leading-tight text-foreground sm:text-base">
                {displayName || 'Your Name'}
              </p>
              <p className="truncate text-[11px] text-muted-foreground">
                My space{title && !isOnHub ? ` · ${title}` : ''}
              </p>
            </div>

            <button
              type="button"
              onClick={goToFunderDashboard}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label="Back to funder dashboard"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-7xl">
        <aside
          className={cn(
            'relative sticky top-[57px] hidden h-[calc(100vh-57px)] shrink-0 border-r border-border/60 bg-card/40 lg:block',
            resizing && 'select-none',
          )}
          style={{ width: sidebarWidth }}
        >
          <MenuBody />
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize menu"
            onPointerDown={onResizePointerDown}
            className={cn(
              'group absolute -right-1 top-0 z-10 h-full w-2 cursor-col-resize touch-none',
              'before:absolute before:inset-y-0 before:left-1/2 before:w-px before:bg-transparent before:transition-colors',
              'hover:before:bg-primary/50',
              resizing && 'before:bg-primary',
            )}
          >
            <div className={cn(
              'absolute right-0.5 top-1/2 h-10 w-1 -translate-y-1/2 rounded-full bg-border/70 transition-colors group-hover:bg-primary/50',
              resizing && 'bg-primary',
            )} />
          </div>
        </aside>

        <main className="min-w-0 flex-1 px-3 py-4 sm:px-4 sm:py-6 lg:px-6">
          <div className="mx-auto w-full max-w-5xl">
            {title && (
              <div className="mb-4 space-y-1">
                {!isOnHub && (
                  <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <Link to="/me" className="transition-colors hover:text-foreground">My space</Link>
                    <span aria-hidden="true">/</span>
                    <span className="truncate font-medium text-foreground">{title}</span>
                  </nav>
                )}
                <h1 className="text-lg font-bold tracking-tight sm:text-2xl">{title}</h1>
              </div>
            )}
            <div className="space-y-4">{children}</div>
          </div>
        </main>
      </div>

      <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
        <SheetContent side="left" className="w-[17rem] p-0">
          <MenuBody />
        </SheetContent>
      </Sheet>
    </div>
  );
};

export default PersonalLayout;
