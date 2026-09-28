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
    rate: (p: Props) => ugx(p.noteRate ?? 1500),
    body: 'Create a note for a house or rent plan and follow it up. When it is brought in, your reward lands in your wallet.',
  },
  {
    icon: Percent,
    title: 'Initial Support',
    rate: (p: Props) => `${p.initialSupportPct ?? 2}% of their first money in`,
    body: 'When a partner you brought in starts funding, you earn a share of that first amount.',
  },
  {
    icon: Repeat,
    title: 'Top-ups',
    rate: (p: Props) => `${p.topUpPct ?? 1}% of every top-up`,
    body: 'Every time they add more money later, you earn again.',
  },
];

export function ProxyHowItWorksDialog({ noteRate, initialSupportPct, topUpPct }: Props) {
  const p: Props = { noteRate, initialSupportPct, topUpPct };
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="shrink-0 gap-1 px-2.5 text-[11px] md:text-xs">
          <HelpCircle className="h-3.5 w-3.5" />
          How it works
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg gap-3 p-4 sm:gap-4 sm:p-5">
        <DialogHeader>
          <DialogTitle>How proxy agents earn</DialogTitle>
          <DialogDescription className="text-xs sm:text-sm">
            Three ways to earn, all paid into your Welile wallet and ready to withdraw.
          </DialogDescription>
        </DialogHeader>

        <ol className="space-y-2">
          {STEPS.map((s, i) => (
            <li key={s.title} className="flex gap-2.5 rounded-lg border border-border p-2.5">
              <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                <s.icon className="h-3.5 w-3.5" />
              </span>
              <div className="min-w-0">
                <p className="text-sm font-semibold leading-tight">
                  {i + 1}. {s.title}
                  <span className="ml-1.5 font-normal text-muted-foreground">{s.rate(p)}</span>
                </p>
                <p className="mt-0.5 text-xs leading-snug text-muted-foreground">{s.body}</p>
              </div>
            </li>
          ))}
        </ol>

        <div className="space-y-1.5 rounded-lg bg-muted/50 p-2.5 text-xs leading-snug text-muted-foreground">
          <p className="flex items-center gap-1.5 font-semibold text-foreground">
            <Wallet className="h-3.5 w-3.5 text-primary" /> When you get paid
          </p>
          <p>
            <span className="font-medium text-foreground">Earned Commission</span> is money already in
            your wallet — withdraw it any time.
          </p>
          <p>
            Notes still waiting to be brought in show as <span className="font-medium text-foreground">Pending</span> and
            earn nothing yet, so follow up on them.
          </p>
          <p>Commission on a partner&rsquo;s money is released once the deposit is confirmed.</p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
