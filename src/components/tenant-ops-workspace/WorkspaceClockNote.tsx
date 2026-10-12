import { useLandlordNotPaid } from '@/hooks/tenantOpsWorkspace/useLandlordNotPaid';

/**
 * One line of context above every Workspace section: where the repayment clock starts, and how many
 * live Rent Plans are not counted yet because the landlord has not been paid. The count line is
 * hidden (never a zero) until the number has loaded.
 */
export default function WorkspaceClockNote() {
  const { data } = useLandlordNotPaid();
  return (
    <div className="mb-3 space-y-0.5 text-xs text-muted-foreground" data-testid="workspace-clock-note">
      <p>Counted from the day after the landlord was paid</p>
      {data && (
        <p data-testid="workspace-landlord-not-paid">
          Landlord not paid yet: {data.total_plans.toLocaleString('en-US')} plan{data.total_plans === 1 ? '' : 's'} (not
          counted as owing)
        </p>
      )}
    </div>
  );
}
