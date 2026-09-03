import { ReactNode, useEffect, useState } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/integrations/supabase/client';
import {
  X,
  ArrowLeft,
  User,
  FileText,
  Briefcase,
  Ticket,
  Wallet,
  Bell,
  FolderOpen,
  LayoutGrid,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';

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

/** Same destinations as the My space hub cards — surfaced as a quick nav rail. */
const NAV_ITEMS = [
  { to: '/me', icon: LayoutGrid, label: 'Overview' },
  { to: '/your-profile', icon: User, label: 'Profile' },
  { to: '/me/payslips', icon: FileText, label: 'Payslips' },
  { to: '/me/work', icon: Briefcase, label: 'My work' },
  { to: '/me/tickets', icon: Ticket, label: 'Tickets' },
  { to: '/me/requisitions', icon: Wallet, label: 'Requisitions' },
  { to: '/notifications', icon: Bell, label: 'Notifications' },
  { to: '/me/documents', icon: FolderOpen, label: 'Documents' },
];

const PersonalLayout = ({ children, title }: PersonalLayoutProps) => {
  const { user, roles, switchRole } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [displayName, setDisplayName] = useState('');

  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);

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

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-30 border-b border-border/60 bg-card/80 backdrop-blur supports-[backdrop-filter]:bg-card/70 pt-safe">
        <div className="mx-auto w-full max-w-5xl px-3 sm:px-4">
          <div className="flex items-center gap-2 py-2.5 sm:gap-3">
            {!isOnHub && (
              <button
                type="button"
                onClick={() => navigate('/me')}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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

          <nav
            aria-label="My space sections"
            className="-mx-3 flex gap-1 overflow-x-auto px-3 pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:-mx-4 sm:px-4"
          >
            {NAV_ITEMS.map((item) => {
              const active =
                item.to === '/me'
                  ? location.pathname === '/me'
                  : location.pathname === item.to || location.pathname.startsWith(`${item.to}/`);
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
                    active
                      ? 'border-primary/30 bg-primary/10 text-primary'
                      : 'border-transparent bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}
                >
                  <item.icon className="h-3.5 w-3.5" />
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl px-3 py-4 sm:px-4 sm:py-6">
        {title && (
          <h1 className="mb-3 text-lg font-bold tracking-tight sm:mb-4 sm:text-2xl">{title}</h1>
        )}
        <div className="space-y-4">{children}</div>
      </main>
    </div>
  );
};

export default PersonalLayout;
