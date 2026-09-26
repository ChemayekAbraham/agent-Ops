import { AlertTriangle } from 'lucide-react';
import { usePlanPosition } from '@/hooks/tenantOpsWorkspace/usePlanPosition';
import { useTenantRisk } from '@/hooks/tenantOpsWorkspace/useTenantRisk';
import { BlockShell } from './BlockShell';

/**
 * "Idle state" is read from tops_plan_position's own days_past_due (already
 * fetched for PositionCard — React Query dedupes the identical query) since
 * no dedicated idle-detection table/RPC exists today for this to read.
 */
export function RiskBlock({ rentRequestId }: { rentRequestId: string }) {
  const { data: risk, isLoading, error } = useTenantRisk(rentRequestId);
  const { data: position } = usePlanPosition(rentRequestId);

  return (
    <BlockShell title="Risk" isLoading={isLoading} error={error}>
      {risk && (
        <div className="space-y-3 text-xs">
          <p>
            <span className="text-muted-foreground">Idle: </span>
            <span className="font-medium">
              {position?.days_past_due != null ? `${position.days_past_due} days since last payment` : '—'}
            </span>
          </p>

          <p>
            <span className="text-muted-foreground">Duplicates: </span>
            {risk.duplicateAlert ? (
              <span className="font-medium">
                {risk.duplicateAlert.matchType} · {risk.duplicateAlert.memberCount} accounts ·{' '}
                {risk.duplicateAlert.status}
              </span>
            ) : (
              <span className="font-medium">None flagged</span>
            )}
          </p>

          <div>
            <p className="mb-1 font-semibold uppercase tracking-wide text-muted-foreground">
              Restructure history
            </p>
            <ul className="space-y-0.5 text-muted-foreground">
              <li>Pauses: {risk.pauseCount} {risk.latestPauseStatus ? `(latest: ${risk.latestPauseStatus})` : ''}</li>
              <li>
                Renewal: {risk.isRenewal ? 'this plan renewed an earlier one' : risk.wasLaterRenewed ? 'later renewed into a new plan' : 'none'}
              </li>
              <li>Reopened: {risk.reopenCount} time{risk.reopenCount === 1 ? '' : 's'}{risk.reopenReason ? ` (${risk.reopenReason})` : ''}</li>
            </ul>
          </div>

          {risk.remainsInRiskNumerator && (
            <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/5 p-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
              <p className="text-warning">
                This plan has been paused, renewed or reopened — it REMAINS in the risk numerator.
              </p>
            </div>
          )}
        </div>
      )}
    </BlockShell>
  );
}
