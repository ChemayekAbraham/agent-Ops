import RentAccessLimitActivity from '@/components/agent/RentAccessLimitActivity';
import { useRentAccessLimitData } from '@/hooks/tenantOpsWorkspace/useRentAccessLimitData';
import { BlockShell } from './BlockShell';

/**
 * Reuses the existing, already-audited RentAccessLimitActivity component
 * (src/components/agent/RentAccessLimitActivity.tsx) exactly as-is — it does
 * its own limit math via calculateRentAccessLimit(). This block only gathers
 * its inputs; no new money computation is written here.
 */
export function RentAccessLimitBlock({ rentRequestId }: { rentRequestId: string }) {
  const { data, isLoading, error } = useRentAccessLimitData(rentRequestId);

  return (
    <BlockShell title="Rent Access Limit" isLoading={isLoading} error={error}>
      {data && (
        <RentAccessLimitActivity
          tenantName={data.tenantName ?? 'This tenant'}
          monthlyRent={data.monthlyRent}
          repayments={data.repayments}
        />
      )}
    </BlockShell>
  );
}
