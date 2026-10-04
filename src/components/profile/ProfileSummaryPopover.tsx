import { ReactNode, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BadgeCheck, ChevronRight, Mail, MapPin, Phone, Settings, UserRound } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { UserAvatar } from '@/components/UserAvatar';
import { hapticTap } from '@/lib/haptics';
import { cn } from '@/lib/utils';

interface ProfileSummaryPopoverProps {
  avatarUrl?: string | null;
  fullName?: string | null;
  phone?: string | null;
  email?: string | null;
  location?: string | null;
  verified?: boolean | null;
  /** Short role label, e.g. "Welile Agent" or "Tenant". */
  roleLabel?: string;
  /** Avatar size used inside the trigger. */
  triggerSize?: 'sm' | 'md' | 'lg';
  /** Extra rows rendered under the contact details (stats, trust score, etc.). */
  children?: ReactNode;
  className?: string;
  align?: 'start' | 'center' | 'end';
}

/**
 * Tapping the dashboard avatar opens a compact profile summary card instead of
 * jumping straight to Settings. Settings and the full profile are one tap away
 * from inside the card.
 */
export function ProfileSummaryPopover({
  avatarUrl,
  fullName,
  phone,
  email,
  location,
  verified,
  roleLabel,
  triggerSize = 'lg',
  children,
  className,
  align = 'start',
}: ProfileSummaryPopoverProps) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  const go = (path: string) => {
    hapticTap();
    setOpen(false);
    navigate(path);
  };

  const rows = [
    { icon: Phone, value: phone },
    { icon: Mail, value: email },
    { icon: MapPin, value: location },
  ].filter((r) => !!r.value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          onClick={() => hapticTap()}
          aria-label="Open profile summary"
          title="Profile summary"
          className={cn(
            'shrink-0 rounded-full touch-manipulation transition-transform active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background',
            className,
          )}
          style={{ WebkitTapHighlightColor: 'transparent' }}
        >
          <UserAvatar avatarUrl={avatarUrl} fullName={fullName ?? undefined} size={triggerSize} />
          <span className="sr-only">
            {fullName ? `${fullName} — profile summary` : 'Profile summary'}
          </span>
        </button>
      </PopoverTrigger>

      <PopoverContent align={align} className="w-[min(20rem,calc(100vw-2rem))] rounded-2xl p-0">
        <div className="flex items-start gap-3 p-4">
          <UserAvatar avatarUrl={avatarUrl} fullName={fullName ?? undefined} size="md" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <p className="truncate text-sm font-bold text-foreground">{fullName || 'Your profile'}</p>
              {verified && <BadgeCheck className="h-4 w-4 shrink-0 fill-primary/20 text-primary" />}
            </div>
            {roleLabel && (
              <Badge variant="outline" className="mt-1 text-[10px] font-medium">
                {roleLabel}
              </Badge>
            )}
            {!verified && (
              <p className="mt-1 text-[11px] text-muted-foreground">Verification pending</p>
            )}
          </div>
        </div>

        {rows.length > 0 && (
          <div className="space-y-1.5 border-t border-border/60 px-4 py-3">
            {rows.map((r) => (
              <div key={r.icon.displayName ?? String(r.value)} className="flex items-center gap-2">
                <r.icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate text-xs text-foreground">{r.value}</span>
              </div>
            ))}
          </div>
        )}

        {children && <div className="border-t border-border/60 px-4 py-3">{children}</div>}

        <div className="grid gap-1 border-t border-border/60 p-2">
          <Button
            variant="ghost"
            className="h-10 justify-start gap-2 rounded-xl px-2 text-sm font-medium"
            onClick={() => go('/your-profile')}
          >
            <span className="rounded-lg bg-muted p-1.5">
              <UserRound className="h-4 w-4" />
            </span>
            View full profile
            <ChevronRight className="ml-auto h-4 w-4 opacity-50" />
          </Button>
          <Button
            variant="ghost"
            className="h-10 justify-start gap-2 rounded-xl px-2 text-sm font-medium"
            onClick={() => go('/settings')}
          >
            <span className="rounded-lg bg-muted p-1.5">
              <Settings className="h-4 w-4" />
            </span>
            Settings
            <ChevronRight className="ml-auto h-4 w-4 opacity-50" />
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}