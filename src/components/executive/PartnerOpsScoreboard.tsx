import { PartnerOpsPendingSummary } from './PartnerOpsPendingSummary';

interface PartnerOpsScoreboardProps {
  /** Kept for API compatibility; no longer used. */
  hideTargetEditor?: boolean;
}

export function PartnerOpsScoreboard(_props: PartnerOpsScoreboardProps = {}) {
  return (
    <div className="space-y-3">
      <PartnerOpsPendingSummary />
    </div>
  );
}

export default PartnerOpsScoreboard;
