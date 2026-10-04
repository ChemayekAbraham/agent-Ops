import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Plus, HandCoins } from 'lucide-react';
import { CFOInitiateAdvanceDialog } from '@/components/cfo/CFOInitiateAdvanceDialog';
import { StaffRepayAdvanceDialog } from '@/components/advances/StaffRepayAdvanceDialog';
import { AdvanceAnalyticsPanel } from '@/components/executive/agent-ops-v2/AdvanceAnalyticsPanel';
import { AgentAdvancesStatsCard } from '@/components/cfo/AgentAdvancesStatsCard';
import { AgentAdvancesOutstandingPanel } from '@/components/cfo/AgentAdvancesOutstandingPanel';

interface Props {
  /** Who is looking — only affects the copy shown in the header. */
  context?: 'cfo' | 'agent_ops';
}

/**
 * Single "Advances" analytics home: stats, graphs & charts plus the
 * Issue Advance entry point. Shared by the CFO dashboard and the
 * Agent Ops Manager dashboard.
 */
export function AdvancesAnalyticsView({ context = 'cfo' }: Props) {
  const [issueOpen, setIssueOpen] = useState(false);
  const [repayOpen, setRepayOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">📈 Advances</h1>
          <p className="text-sm text-muted-foreground">
            {context === 'cfo'
              ? 'Portfolio-wide advance performance: requests, approvals, disbursements and outstanding exposure.'
              : 'Advance performance across your agents: requests, approvals, disbursements and outstanding exposure.'}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setIssueOpen(true)} className="gap-2">
            <Plus className="h-4 w-4" />
            Issue Advance
          </Button>
          <Button variant="outline" onClick={() => setRepayOpen(true)} className="gap-2">
            <HandCoins className="h-4 w-4" />
            Repay Advance
          </Button>
        </div>
      </div>

      <div key={refreshKey} className="space-y-6">
        <AgentAdvancesStatsCard />
        <AdvanceAnalyticsPanel />
        <AgentAdvancesOutstandingPanel />
      </div>

      <CFOInitiateAdvanceDialog
        open={issueOpen}
        onOpenChange={setIssueOpen}
        onSuccess={() => setRefreshKey((k) => k + 1)}
      />

      <StaffRepayAdvanceDialog
        open={repayOpen}
        onOpenChange={setRepayOpen}
        onSuccess={() => setRefreshKey((k) => k + 1)}
      />
    </div>
  );
}

export default AdvancesAnalyticsView;
