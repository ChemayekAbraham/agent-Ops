import { useState } from 'react';
import { AlertTriangle, Target } from 'lucide-react';
import { EarningsForecastCard } from './EarningsForecastCard';
import { CollectionStreakCard } from './CollectionStreakCard';
import { PriorityCollectionQueue } from './PriorityCollectionQueue';
import { DailyRentExpectedCard } from './DailyRentExpectedCard';
import { AgentArrearsCard } from './AgentArrearsCard';
import { AgentExpiredCyclesCard } from './AgentExpiredCyclesCard';

interface Props {
  agentId: string;
  hideDailyRent?: boolean;
}

export function AgentActionInsights({ agentId, hideDailyRent }: Props) {
  const [queueOpen, setQueueOpen] = useState(false);

  return (
    <>
      <div className="space-y-3">
        {/* Daily Rent Expected */}
        {!hideDailyRent && <DailyRentExpectedCard userId={agentId} />}

        {/* Unpaid days to recover. Renders nothing when nobody is behind. */}
        <AgentArrearsCard agentId={agentId} />

        {/* Ended Rent Plans that still owe. These carry no pinned day, so they
            appear nowhere under today's target. Renders nothing when there are
            none. */}
        <AgentExpiredCyclesCard agentId={agentId} />


        {/* Collection Streak */}
        <CollectionStreakCard agentId={agentId} />

        {/* Priority Collection Queue Trigger */}
        <button
          onClick={() => setQueueOpen(true)}
          className="w-full flex items-center gap-3 rounded-xl border border-destructive/20 bg-destructive/5 hover:bg-destructive/10 p-3 transition-all active:scale-[0.98] touch-manipulation"
        >
          <div className="p-2 rounded-lg bg-destructive/10 shrink-0">
            <Target className="h-4 w-4 text-destructive" />
          </div>
          <div className="flex-1 text-left">
            <p className="text-sm font-semibold">Priority Collections</p>
            <p className="text-[10px] text-muted-foreground">Tap to see who needs collection first</p>
          </div>
          <AlertTriangle className="h-4 w-4 text-destructive/60" />
        </button>
      </div>

      <PriorityCollectionQueue open={queueOpen} onOpenChange={setQueueOpen} agentId={agentId} />
    </>
  );
}
