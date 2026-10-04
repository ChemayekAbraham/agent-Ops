import { motion } from 'framer-motion';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { hapticTap } from '@/lib/haptics';
import { Trophy, Home, TrendingUp, Coins } from 'lucide-react';
import bannerImg from '@/assets/leaderboard-banner.jpg';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const STEPS = [
  {
    icon: Home,
    tint: '#9334EB',
    title: 'Get sub-agents active',
    body: 'They list houses, submit rent requests, or allocate rent.',
  },
  {
    icon: TrendingUp,
    tint: '#6D28D9',
    title: 'Climb the ranks',
    body: 'More active sub-agents = higher rank. Resets weekly & monthly.',
  },
];

export function LeaderboardHowItWorksDialog({ open, onOpenChange }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-sm rounded-3xl border-0 p-0 overflow-hidden gap-0"
        overlayClassName="backdrop-blur-sm bg-background/70"
      >
        {/* Hero banner */}
        <div className="relative">
          <img
            src={bannerImg}
            alt="Agent leaderboard trophy podium"
            className="h-36 w-full object-cover"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/10 to-transparent" />
          <div className="absolute inset-x-0 bottom-0 p-4">
            <div className="flex items-center gap-2 text-white">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-white/20 backdrop-blur-md ring-1 ring-white/25">
                <Trophy className="h-5 w-5" style={{ color: '#FACC15' }} strokeWidth={2.3} />
              </span>
              <DialogTitle className="text-lg font-extrabold tracking-tight drop-shadow">
                How it works
              </DialogTitle>
            </div>
          </div>
        </div>

        {/* Body */}
        <div className="p-5 space-y-3">
          <DialogDescription className="sr-only">
            A quick guide to how the agent leaderboard works and the rewards you earn.
          </DialogDescription>

          {STEPS.map((step, i) => {
            const Icon = step.icon;
            return (
              <motion.div
                key={step.title}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.05 + i * 0.07 }}
                className="flex items-start gap-3 rounded-2xl border border-violet-500/15 bg-violet-500/5 p-3.5"
              >
                <span
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl"
                  style={{ background: `${step.tint}1a` }}
                >
                  <Icon className="h-5 w-5" style={{ color: step.tint }} />
                </span>
                <div>
                  <p className="text-sm font-bold text-foreground">{step.title}</p>
                  <p className="text-[13px] leading-snug text-muted-foreground">{step.body}</p>
                </div>
              </motion.div>
            );
          })}

          {/* Reward highlight */}
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.24 }}
            className="flex items-start gap-3 rounded-2xl border border-amber-500/25 bg-amber-500/10 p-3.5"
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-amber-500/15">
              <Coins className="h-5 w-5 text-amber-600" />
            </span>
            <div>
              <p className="text-sm font-bold text-foreground">Your reward</p>
              <p className="text-[13px] leading-snug text-muted-foreground">
                Earn a <span className="font-extrabold text-amber-600">2% lifetime override</span> on
                every sub-agent's rent commissions — for as long as they earn.
              </p>
            </div>
          </motion.div>

          <Button
            onClick={() => {
              hapticTap();
              onOpenChange(false);
            }}
            className="mt-1 w-full h-12 rounded-2xl text-[15px] font-bold text-white shadow-md active:scale-[0.98] transition-transform"
            style={{ background: 'linear-gradient(135deg, #9334EB, #6D28D9)' }}
          >
            Got it
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default LeaderboardHowItWorksDialog;