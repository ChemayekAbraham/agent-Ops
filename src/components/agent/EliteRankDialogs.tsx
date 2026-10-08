import { useState } from 'react';
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogTrigger } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Info, Eye } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import { CelebrationBody, RANK_PERKS } from '@/components/agent/AgentRankCelebrationDialog';
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

/** Preview-only: shows what the rank popups look like. Nothing is saved or paid. */
export function EliteDialogPreviewButton() {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [tier, setTier] = useState<EliteTier | null>(null);
  if (!user) return null;
  const t = TIERS.find((x) => x.tier === tier);
  const name = (user.user_metadata?.full_name as string | undefined)?.split(' ')[0] ?? 'Agent';
  return (
    <Dialog open={open} onOpenChange={(value) => { setOpen(value); if (!value) setTier(null); }}>
      <DialogTrigger asChild>
        <Button variant="outline" className="h-auto min-h-[64px] justify-start gap-3 whitespace-normal rounded-2xl border-border/60 bg-card p-3.5 text-left">
          <span className="shrink-0 rounded-xl bg-accent p-2 text-accent-foreground"><Eye className="h-5 w-5" /></span>
          <span className="text-[13px] font-semibold">Preview rank popups</span>
        </Button>
      </DialogTrigger>
        <DialogContent className={t ? "max-w-sm rounded-3xl border-0 p-0 overflow-hidden gap-0 max-h-[90vh] overflow-y-auto" : "max-w-sm max-h-[90vh] overflow-y-auto"}>
          {t ? <CelebrationBody key={t.tier} tier={t.tier} position={t.pos} score={t.score} name={name} onClose={() => setTier(null)} /> : <>
            <DialogTitle>Preview rank popups</DialogTitle>
            <DialogDescription>Sample ranks only — your rank, benefits and wallet stay unchanged.</DialogDescription>
            <div className="grid grid-cols-2 gap-3">
              {TIERS.map((x) => <Button key={x.tier} variant="outline" className="h-12 capitalize" onClick={() => setTier(x.tier)}>{x.tier}</Button>)}
            </div>
            <Button variant="ghost" onClick={() => toast('You are no longer in the Top 4. You are back to a normal agent rate until the next refresh.')}>Drop-out message</Button>
          </>}
        </DialogContent>
    </Dialog>
  );
}
