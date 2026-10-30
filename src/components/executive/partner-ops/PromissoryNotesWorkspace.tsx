import { useMemo } from 'react';
import { PartnerOpsScoreboard } from '@/components/executive/PartnerOpsScoreboard';
import { PromissoryNotesQueue } from '@/components/executive/PromissoryNotesQueue';
import { usePromissoryOpsReport } from '@/hooks/usePromissoryOpsReport';
import { countPromissoryQueue } from '@/lib/promissoryQueueCounts';

/**
 * Pending summary tile and the promissory list share one report and one count.
 */
export function PromissoryNotesWorkspace({
  initialStatusFilter,
  initialSearch,
  initialRange,
}: {
  initialStatusFilter?: string;
  initialSearch?: string;
  initialRange?: string;
}) {
  const reportState = usePromissoryOpsReport();
  const noteCounts = useMemo(
    () => (reportState.isLoading || reportState.error ? null : countPromissoryQueue(reportState.report.notes)),
    [reportState.isLoading, reportState.error, reportState.report.notes],
  );

  return (
    <div className="space-y-6">
      <PartnerOpsScoreboard noteCounts={noteCounts} />
      <PromissoryNotesQueue
        reportState={reportState}
        initialStatusFilter={initialStatusFilter}
        initialSearch={initialSearch}
        initialRange={initialRange}
      />
    </div>
  );
}
