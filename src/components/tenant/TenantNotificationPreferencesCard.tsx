import { lazy, Suspense } from 'react';
import {
  useTenantNotificationPreferences,
  useUpdateTenantNotificationPreferences,
} from '@/hooks/useTenantNotificationPreferences';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Sparkles, Bell, ShieldCheck, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

const PushNotificationButton = lazy(() =>
  import('@/components/PushNotificationButton').then((m) => ({
    default: m.PushNotificationButton,
  })),
);

interface TenantNotificationPreferencesCardProps {
  tenantId: string;
}

export function TenantNotificationPreferencesCard({
  tenantId,
}: TenantNotificationPreferencesCardProps) {
  const { data: prefs, isLoading } = useTenantNotificationPreferences(tenantId);
  const updatePrefs = useUpdateTenantNotificationPreferences(tenantId);

  // Inverted: UI ON = marketing_push_opt_out: false (notifications enabled)
  const isEnabled = prefs ? !prefs.marketing_push_opt_out : true;

  const handleToggle = (checked: boolean) => {
    const optOut = !checked;
    updatePrefs.mutate(
      { marketing_push_opt_out: optOut },
      {
        onSuccess: () => {
          toast.success(
            checked
              ? 'Opportunities & tips notifications enabled'
              : 'Opportunities & tips notifications turned off',
          );
        },
        onError: (err: unknown) => {
          toast.error((err as Error)?.message || 'Failed to update notification preference');
        },
      },
    );
  };

  if (isLoading) {
    return (
      <div className="p-4 rounded-xl border border-border/50 bg-card space-y-3">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }

  return (
    <div className="p-4 rounded-xl border border-border/60 bg-card space-y-4">
      {/* Read-only push device status */}
      <div className="flex items-center justify-between border-b border-border/40 pb-3">
        <div className="flex items-center gap-2">
          <Bell className="h-4 w-4 text-primary" />
          <span className="text-xs font-semibold text-foreground">Device Push Status</span>
        </div>
        <Badge
          variant="outline"
          className={
            prefs?.push_enabled
              ? 'text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border-emerald-500/20 text-[10px]'
              : 'text-muted-foreground bg-muted/60 border-border text-[10px]'
          }
        >
          {prefs?.push_enabled ? 'Subscribed on this device' : 'Not subscribed'}
        </Badge>
      </div>

      {/* The single deliberate toggle */}
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary shrink-0" />
            <Label htmlFor="tenant-marketing-toggle" className="text-sm font-semibold cursor-pointer">
              Welile opportunities & tips
            </Label>
          </div>
          <div className="flex items-center gap-2">
            {updatePrefs.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
            <Switch
              id="tenant-marketing-toggle"
              checked={isEnabled}
              onCheckedChange={handleToggle}
              disabled={updatePrefs.isPending}
            />
          </div>
        </div>

        <p className="text-xs text-muted-foreground leading-relaxed pl-6">
          Turn off proposition and tip notifications (like moving house or building your rent record). Payment and account notices about your Rent Plan will always be sent — these cannot be turned off.
        </p>
      </div>

      {/* Push notification subscription button */}
      <div className="pt-2 border-t border-border/40">
        <p className="text-[11px] text-muted-foreground mb-2">
          Manage device permissions to receive notices on this phone:
        </p>
        <Suspense fallback={<Skeleton className="h-9 w-40 rounded-md" />}>
          <PushNotificationButton className="w-full sm:w-auto gap-2" />
        </Suspense>
      </div>
    </div>
  );
}

export default TenantNotificationPreferencesCard;
