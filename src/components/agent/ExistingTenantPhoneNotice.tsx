import { Loader2, ShieldAlert, UserCheck, RefreshCw, Wallet, UserCog, CalendarClock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import type { ExistingTenantMatch } from '@/hooks/useExistingTenantByPhone';
import { useTenantRentSummary } from '@/hooks/useTenantRentSummary';
import { formatUGX } from '@/lib/rentCalculations';

interface ExistingTenantPhoneNoticeProps {
  match: ExistingTenantMatch | null;
  checking: boolean;
  /** Optional: tap to auto-fill the form with this existing person. */
  onUse?: (match: ExistingTenantMatch) => void;
  /** Optional: tap to renew / continue this existing tenant's rent plan. */
  onRenew?: (match: ExistingTenantMatch) => void;
}

const STATUS_LABELS: Record<string, string> = {
  funded: 'Active (funded)',
  repaying: 'Actively repaying',
  pending: 'Pending review',
  approved: 'Approved',
  agent_verified: 'Agent verified',
  coo_approved: 'COO approved',
  completed: 'Completed',
  rejected: 'Rejected',
};

/**
 * Inline banner shown under a tenant phone field. While an agent types a number
 * we check the platform and, if the number already belongs to someone, reveal
 * their name so the agent cannot register the same number twice (fraud guard).
 *
 * When the number already belongs to a tenant, we ALSO surface their current
 * outstanding balance and the previous/collecting agent, plus a "Renew" action
 * so the agent continues the existing tenancy instead of duplicating it.
 */
export function ExistingTenantPhoneNotice({ match, checking, onUse, onRenew }: ExistingTenantPhoneNoticeProps) {
  const { summary, loading } = useTenantRentSummary(match?.id ?? null);

  if (checking && !match) {
    return (
      <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" /> Checking if this number is already registered…
      </p>
    );
  }

  if (!match) return null;

  const name = match.full_name?.trim() || 'an existing user';
  const outstanding = summary?.outstandingBalance ?? 0;
  const hasOutstanding = outstanding > 0;

  return (
    <div className="rounded-xl border-2 border-warning/50 bg-warning/10 p-3 text-warning-foreground">
      <div className="flex items-start gap-2">
        <ShieldAlert className="h-4 w-4 shrink-0 mt-0.5 text-warning" />
        <div className="min-w-0 flex-1 space-y-2">
          <div>
            <p className="text-xs font-bold text-warning">
              This tenant is already on Welile — {name}
            </p>
            <p className="text-[11px] leading-snug text-foreground/80">
              Don't create a duplicate. Review their balance below and renew their
              existing tenancy if this is the same person.
            </p>
          </div>

          {match.national_id && (
            <p className="text-[11px] text-foreground/70">
              National ID on file: <span className="font-mono font-semibold">{match.national_id}</span>
            </p>
          )}

          {/* Outstanding balance — prominent */}
          {loading ? (
            <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" /> Loading tenant balance…
            </p>
          ) : summary ? (
            <div className="space-y-2">
              <div
                className={`rounded-lg border p-2.5 ${
                  hasOutstanding
                    ? 'border-destructive/40 bg-destructive/10'
                    : 'border-success/40 bg-success/10'
                }`}
              >
                <div className="flex items-center gap-1.5">
                  <Wallet className={`h-3.5 w-3.5 ${hasOutstanding ? 'text-destructive' : 'text-success'}`} />
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-foreground/70">
                    Outstanding Balance
                  </span>
                </div>
                <p className={`text-lg font-extrabold ${hasOutstanding ? 'text-destructive' : 'text-success'}`}>
                  {formatUGX(outstanding)}
                </p>
                {summary.activePlanCount > 0 && (
                  <p className="text-[10px] text-foreground/70">
                    Across {summary.activePlanCount} active rent {summary.activePlanCount === 1 ? 'plan' : 'plans'}
                    {summary.latestDailyRepayment > 0
                      ? ` · ${formatUGX(summary.latestDailyRepayment)}/day`
                      : ''}
                  </p>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-foreground/80">
                {summary.previousAgentName && (
                  <span className="flex items-center gap-1">
                    <UserCog className="h-3 w-3 text-foreground/60" />
                    Previous agent:{' '}
                    <span className="font-semibold">{summary.previousAgentName}</span>
                    {summary.previousAgentPhone ? ` · ${summary.previousAgentPhone}` : ''}
                  </span>
                )}
                {summary.latestStatus && (
                  <Badge variant="outline" className="text-[9px] px-1.5 py-0">
                    {STATUS_LABELS[summary.latestStatus] || summary.latestStatus}
                  </Badge>
                )}
                {summary.latestCreatedAt && (
                  <span className="flex items-center gap-1 text-foreground/60">
                    <CalendarClock className="h-3 w-3" />
                    Last plan {new Date(summary.latestCreatedAt).toLocaleDateString()}
                  </span>
                )}
              </div>
            </div>
          ) : (
            <p className="text-[11px] text-foreground/70">
              No previous rent plan on record for this tenant.
            </p>
          )}

          {/* Actions */}
          <div className="flex flex-wrap gap-2 pt-0.5">
            {onRenew && (
              <Button
                type="button"
                size="sm"
                className="h-8 gap-1.5 text-xs bg-primary text-primary-foreground hover:bg-primary/90"
                onClick={() => onRenew(match)}
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Renew {name}
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
