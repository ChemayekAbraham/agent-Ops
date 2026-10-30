import { PartnerOpsPendingSummary } from './PartnerOpsPendingSummary';
import type { PromissoryQueueCounts } from '@/lib/promissoryQueueCounts';

interface PartnerOpsScoreboardProps {
  /** Kept for API compatibility; no longer used. */
  hideTargetEditor?: boolean;
  /** When the promissory list is on screen, Pending uses that list's count. */
  noteCounts?: PromissoryQueueCounts | null;
}

export function PartnerOpsScoreboard({ noteCounts }: PartnerOpsScoreboardProps = {}) {
  return (
    <div className="space-y-3">
      <PartnerOpsPendingSummary noteCounts={noteCounts} />
    </div>
  );
}

export default PartnerOpsScoreboard;
