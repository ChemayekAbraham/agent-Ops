import { useEffect } from 'react';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { TrendingUp, Sparkles, PartyPopper } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import confetti from 'canvas-confetti';
import { formatUGX } from '@/lib/rentCalculations';

interface CommissionCelebrationProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  commissionAmount: number;
  paymentAmount: number;
  tenantName: string;
  /** Optional auto-dismiss delay in ms (set 0 to disable) */
  autoDismissMs?: number;
}

/**
 * Celebration modal shown after every commission earned.
 * Pure UI — does NOT call the database. Receives commission amount as a prop.
 */
export function CommissionCelebration({
  open,
  onOpenChange,
  commissionAmount,
  paymentAmount,
  tenantName,
  autoDismissMs = 5000,
}: CommissionCelebrationProps) {
  // Fire confetti when opened
  useEffect(() => {
    if (!open) return;

    const end = Date.now() + 1500;
    const colors = ['#10b981', '#f59e0b', '#3b82f6', '#ec4899'];

    const frame = () => {
      confetti({
        particleCount: 4,
        angle: 60,
        spread: 70,
        origin: { x: 0, y: 0.7 },
        colors,
        zIndex: 9999,
      });
      confetti({
        particleCount: 4,
        angle: 120,
        spread: 70,
        origin: { x: 1, y: 0.7 },
        colors,
        zIndex: 9999,
      });
      if (Date.now() < end) requestAnimationFrame(frame);
    };

    // Big initial burst
    confetti({
      particleCount: 120,
      spread: 100,
      origin: { y: 0.5 },
      colors,
      zIndex: 9999,
    });
    frame();

    // Auto-dismiss
    if (autoDismissMs && autoDismissMs > 0) {
      const t = setTimeout(() => onOpenChange(false), autoDismissMs);
      return () => clearTimeout(t);
    }
  }, [open, autoDismissMs, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm border-0 bg-gradient-to-br from-success/15 via-background to-primary/10 overflow-hidden">
        <AnimatePresence>
          {open && (
            <motion.div
              initial={{ scale: 0.7, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.7, opacity: 0 }}
              transition={{ type: 'spring', stiffness: 200, damping: 18 }}
              className="flex flex-col items-center text-center py-3 space-y-3"
            >
              {/* Animated coin/icon */}
              <motion.div
                initial={{ rotate: -180, scale: 0 }}
                animate={{ rotate: 0, scale: 1 }}
                transition={{ type: 'spring', stiffness: 180, damping: 12, delay: 0.1 }}
                className="relative"
              >
                <div className="w-20 h-20 rounded-full bg-gradient-to-br from-success to-success/70 flex items-center justify-center shadow-xl shadow-success/30">
                  <TrendingUp className="h-10 w-10 text-success-foreground" strokeWidth={2.5} />
                </div>
                <motion.div
                  animate={{ rotate: 360 }}
                  transition={{ duration: 8, repeat: Infinity, ease: 'linear' }}
                  className="absolute -top-2 -right-2"
                >
                  <Sparkles className="h-6 w-6 text-amber-500" />
                </motion.div>
                <motion.div
                  animate={{ y: [-4, 4, -4] }}
                  transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
                  className="absolute -bottom-1 -left-2"
                >
                  <PartyPopper className="h-5 w-5 text-primary" />
                </motion.div>
              </motion.div>

              <motion.div
                initial={{ y: 10, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                transition={{ delay: 0.25 }}
                className="space-y-1"
              >
                <p className="text-xs uppercase tracking-widest text-muted-foreground font-bold">
                  Commission Earned
                </p>
                <p className="text-4xl font-black font-mono text-success">
                  +{formatUGX(commissionAmount)}
                </p>
              </motion.div>

              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.4 }}
                className="bg-card/60 backdrop-blur rounded-xl px-4 py-2.5 border border-border/40 w-full"
              >
                <p className="text-xs text-muted-foreground">
                  From <span className="font-semibold text-foreground">{tenantName}</span>'s payment
                </p>
                <p className="text-sm font-mono font-bold mt-0.5">
                  {formatUGX(paymentAmount)} allocated
                </p>
              </motion.div>

              <motion.p
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.5 }}
                className="text-xs text-muted-foreground"
              >
                🎉 Credited instantly to your commission wallet
              </motion.p>

              <Button
                onClick={() => onOpenChange(false)}
                className="w-full h-11 font-bold mt-1"
              >
                Awesome!
              </Button>
            </motion.div>
          )}
        </AnimatePresence>
      </DialogContent>
    </Dialog>
  );
}
