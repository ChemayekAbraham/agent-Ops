import { Card } from '@/components/ui/card';
import { EliteRankBadge } from '@/components/agent/EliteRankBadge';
import { useMyEliteRank, RANK_PERKS } from '@/components/agent/AgentRankCelebrationDialog';

/** Shown only to ranked agents. No safe read path for reward totals exists yet, so this lists the reward rules only. */
export function RankEarningsCard() {
  const { data: rank } = useMyEliteRank();
  if (!rank) return null;
  return (
    <Card className="rounded-2xl p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-bold">Rank rewards</h3>
        <EliteRankBadge tier={rank.tier_name} size="sm" />
      </div>
      <p className="mt-1 text-xs text-muted-foreground">You are #{rank.rank_position}. While you hold your rank you earn:</p>
      <ul className="mt-3 space-y-2">
        {RANK_PERKS[rank.tier_name].map((p) => (
          <li key={p.text} className="flex items-start gap-2 text-sm">
            <p.icon className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <span>{p.text}</span>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-[11px] text-muted-foreground">Rewards appear in your wallet history as they are paid.</p>
    </Card>
  );
}
