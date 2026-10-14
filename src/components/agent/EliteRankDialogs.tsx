import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogTrigger } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Info } from 'lucide-react';
import { RANK_PERKS } from '@/components/agent/AgentRankCelebrationDialog';
import { EliteRankBadge } from '@/components/agent/EliteRankBadge';
import type { EliteTier } from '@/hooks/useEliteRanks';

const TIERS: { tier: EliteTier; pos: number; score: number }[] = [
  { tier: 'diamond', pos: 1, score: 100 },
  { tier: 'platinum', pos: 2, score: 99.2 },
  { tier: 'gold', pos: 3, score: 84.5 },
  { tier: 'silver', pos: 4, score: 81.5 },
];

export function EliteHowItWorksDialog() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="h-7 gap-1 rounded-full px-3 text-xs">
          <Info className="h-3.5 w-3.5" /> How it works
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md rounded-3xl max-h-[90vh] overflow-y-auto">
        <DialogTitle>How Elite ranks work</DialogTitle>
        <DialogDescription>The top 4 agents earn a rank every night at 1:00 AM Kampala time.</DialogDescription>
        <div className="space-y-4 text-sm">
          <div>
            <p className="font-semibold">Your score (out of 100, last 30 days)</p>
            <ul className="mt-1 space-y-1 text-muted-foreground">
              <li>Collections, up to 40: collecting your tenants' Rent Plan repayments</li>
              <li>Active sub-agents, up to 35: sub-agents who are actively collecting</li>
              <li>App activity, up to 25: days you open and use the app</li>
            </ul>
          </div>
          <div>
            <p className="font-semibold">Ranks</p>
            <p className="text-muted-foreground">#1 Diamond, #2 Platinum, #3 Gold, #4 Silver.</p>
          </div>
          {TIERS.map(({ tier }) => (
            <div key={tier} className="rounded-2xl border p-3">
              <EliteRankBadge tier={tier} size="sm" />
              <ul className="mt-2 space-y-1.5">
                {RANK_PERKS[tier].map((p) => (
                  <li key={p.text} className="flex gap-2"><p.icon className="mt-0.5 h-4 w-4 shrink-0 text-primary" />{p.text}</li>
                ))}
              </ul>
            </div>
          ))}
          <p className="text-xs text-muted-foreground">
            If you fall out of the top 4 at the nightly refresh, you go back to a normal agent and the perks stop until you earn a rank again.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
