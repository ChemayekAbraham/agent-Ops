import { Loader2, ShieldAlert, UserCheck, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { ExistingTenantMatch } from '@/hooks/useExistingTenantByPhone';

interface ExistingTenantPhoneNoticeProps {
  match: ExistingTenantMatch | null;
  checking: boolean;
  /** Optional: tap to auto-fill the form with this existing person. */
  onUse?: (match: ExistingTenantMatch) => void;
  /** Optional: tap to renew / continue this existing tenant's rent plan. */
  onRenew?: (match: ExistingTenantMatch) => void;
}

/**
 * Inline banner shown under a tenant phone field. While an agent types a number
 * we check the platform and, if the number already belongs to someone, we simply
 * say so — no balances, no previous-agent details, no plan history. The agent
 * only needs to know not to register the same person twice.
 */
export function ExistingTenantPhoneNotice({ match, checking, onUse, onRenew }: ExistingTenantPhoneNoticeProps) {
  if (checking && !match) {
    return (
      <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" /> Checking if this number is already registered…
      </p>
    );
  }

  if (!match) return null;

  return (
    <div className="rounded-xl border-2 border-warning/50 bg-warning/10 p-3 text-warning-foreground">
      <div className="flex items-start gap-2">
        <ShieldAlert className="h-4 w-4 shrink-0 mt-0.5 text-warning" />
        <div className="min-w-0 flex-1 space-y-2">
          <p className="text-xs font-bold text-warning">
            This tenant is already in the system
          </p>

          <div className="flex flex-wrap gap-2 pt-0.5">
            {onRenew && (
              <Button
                type="button"
                size="sm"
                className="h-8 gap-1.5 text-xs bg-primary text-primary-foreground hover:bg-primary/90"
                onClick={() => onRenew(match)}
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Continue their rent plan
              </Button>
            )}
            {onUse && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 gap-1.5 text-xs"
                onClick={() => onUse(match)}
              >
                <UserCheck className="h-3.5 w-3.5" />
                Use their details
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
