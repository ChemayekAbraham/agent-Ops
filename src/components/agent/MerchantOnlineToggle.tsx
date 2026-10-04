import { Switch } from '@/components/ui/switch';
import { useMerchantOnlineStatus } from '@/hooks/useMerchantOnlineStatus';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

/**
 * Online/Offline availability switch for merchant (cash-out) agents.
 * Online agents receive real-time withdrawal dispatches; Offline agents don't.
 */
export function MerchantOnlineToggle({ className }: { className?: string }) {
  const { isOnline, setOnline, loading, saving } = useMerchantOnlineStatus();

  const handleToggle = async (next: boolean) => {
    const ok = await setOnline(next);
    if (!ok) {
      toast.error('Could not update your availability. Please try again.');
      return;
    }
    toast.success(next ? "You're Online — you'll receive withdrawal requests." : "You're Offline — no new requests.");
  };

  return (
    <div
      className={cn(
        'flex items-center justify-between gap-3 rounded-2xl border p-3.5 transition-colors',
        isOnline
          ? 'border-emerald-500/30 bg-emerald-500/10'
          : 'border-border bg-muted/40',
        className,
      )}
    >
      <div className="flex items-center gap-2.5 min-w-0">
        <span
          className={cn(
            'relative flex h-2.5 w-2.5 shrink-0 rounded-full',
            isOnline ? 'bg-emerald-500' : 'bg-muted-foreground/40',
          )}
        >
          {isOnline && (
            <span className="absolute inset-0 animate-ping rounded-full bg-emerald-500/70" />
          )}
        </span>
        <div className="min-w-0">
          <p className="text-sm font-semibold leading-tight">
            {isOnline ? 'Online' : 'Offline'}
          </p>
          <p className="text-[11px] text-muted-foreground leading-tight truncate">
            {isOnline
              ? 'Receiving new withdrawal requests'
              : 'Not receiving requests'}
          </p>
        </div>
      </div>
      <Switch
        checked={isOnline}
        disabled={loading || saving}
        onCheckedChange={handleToggle}
        aria-label="Toggle online availability"
      />
    </div>
  );
}

export default MerchantOnlineToggle;
