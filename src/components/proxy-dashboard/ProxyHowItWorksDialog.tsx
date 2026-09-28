import { HelpCircle, BadgeCheck, Percent, Repeat, Wallet } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import { ugx } from './ProxyDashboardParts';

interface Props {
  /** Reward per Promissory Note that gets brought in, in UGX. */
  noteRate?: number;
  /** Percentage earned on a partner's first funding. */
  initialSupportPct?: number;
  /** Percentage earned on a partner's later top-ups. */
  topUpPct?: number;
}

const STEPS = [
  {
    icon: BadgeCheck,
    title: 'Promissory Note rewards',
    amount: (pct: number | undefined, rate: number | undefined) =>
      `${ugx(rate ?? 1500)} per note`,
    body: 'Create a Promissory Note for a house or rent plan and follow it up. When the note is brought in, your reward is added to your wallet.',
  },
  {
    icon: Percent,
    title: 'Initial Support',
    amount: (pct) => `${pct ?? 2}% of the first money they put in`,
    body: 'When a partner you brought in starts funding, you earn a share of that first amount.',
  },
  {
    icon: Repeat,
    title: 'Top-ups',
    amount: (pct) => `${pct ?? 1}% of every top-up`,
    body: 'Every time that partner adds more money later, you earn again — for as long as they keep going.',
  },
];

export function ProxyHowItWorksDialog({ noteRate, initialSupportPct, topUpPct }: Props) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="h-7 shrink-0 gap-1 px-2.5 text-[11px] md:text-xs">
          <HelpCircle className="h-3.5 w-3.5" />
          How it works
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>How proxy agents earn</DialogTitle>
          <DialogDescription>
            Three ways to earn, all paid into your Welile wallet and ready to withdraw.
          </DialogDescription>
        </DialogHeader>

        <ol className="space-y-3">
          {STEPS.map((s, i) => (
            <li key={s.title} className="flex gap-3 rounded-lg border border-border p-3">
              <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                <s.icon className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <p className="text-sm font-semibold">
                  {i + 1}. {s.title}
                  <span className="ml-1.5 font-normal text-muted-foreground">
                    {s.amount(i === 1 ? initialSupportPct : i === 2 ? topUpPct : undefined, noteRate)}
                  </span>
                </p>
                <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{s.body}</p>
              </div>
            </li>
          ))}
        </ol>

        <div className="space-y-2 rounded-lg bg-muted/50 p-3 text-xs leading-relaxed text-muted-foreground">
          <p className="flex items-center gap-1.5 font-semibold text-foreground">
            <Wallet className="h-3.5 w-3.5 text-primary" /> When you get paid
          </p>
          <p>
            Your <span className="font-medium text-foreground">Earned Commission</span> figure is money
            that has already reached your wallet. You can withdraw it any time.
          </p>
          <p>
            A note that is still waiting to be brought in shows under <span className="font-medium text-foreground">Pending</span> —
            it earns nothing until it comes in, so follow up on your notes.
          </p>
          <p>
            Commission on a partner&rsquo;s money is released once the deposit is confirmed on our side.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
