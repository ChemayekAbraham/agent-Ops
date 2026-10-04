import { useEffect, useRef } from 'react';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { formatUGX } from '@/lib/businessAdvanceCalculations';
import { PartyPopper, Briefcase, Sparkles } from 'lucide-react';

interface Props {
  open: boolean;
  onClose: () => void;
  amount: number;
  businessName?: string;
  repaymentAmount?: number;
}

/**
 * Confetti-driven celebration shown when an agent earns commission
 * from one of their business advance tenants making a repayment.
 * Uses lightweight DOM-based confetti — no external libs.
 */
export function CommissionCelebrationModal({ open, onClose, amount, businessName, repaymentAmount }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || !containerRef.current) return;
    const container = containerRef.current;
    const colors = ['#10B981', '#F59E0B', '#3B82F6', '#EC4899', '#8B5CF6'];
    const pieces: HTMLDivElement[] = [];

    for (let i = 0; i < 60; i++) {
      const piece = document.createElement('div');
      piece.style.cssText = `
        position: absolute;
        width: 8px; height: 12px;
        background: ${colors[i % colors.length]};
        left: ${Math.random() * 100}%;
        top: -10px;
        opacity: ${0.7 + Math.random() * 0.3};
        transform: rotate(${Math.random() * 360}deg);
        border-radius: 2px;
        pointer-events: none;
        animation: confetti-fall ${1.5 + Math.random() * 1.5}s linear ${Math.random() * 0.5}s forwards;
      `;
      container.appendChild(piece);
      pieces.push(piece);
    }

    // haptic + sound (best-effort)
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator) navigator.vibrate?.(80);

    const timer = setTimeout(() => {
      pieces.forEach((p) => p.remove());
    }, 3500);

    return () => {
      clearTimeout(timer);
      pieces.forEach((p) => p.remove());
    };
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm overflow-hidden">
        <style>{`
          @keyframes confetti-fall {
            to { transform: translateY(500px) rotate(720deg); opacity: 0; }
          }
        `}</style>
        <div ref={containerRef} className="absolute inset-0 pointer-events-none overflow-hidden" />

        <div className="relative text-center py-4 space-y-4">
          <div className="mx-auto h-20 w-20 rounded-full bg-gradient-to-br from-emerald-500 to-emerald-700 flex items-center justify-center shadow-lg shadow-emerald-500/30">
            <PartyPopper className="h-10 w-10 text-white" />
          </div>

          <div>
            <p className="text-xs uppercase tracking-widest text-muted-foreground font-bold">Commission earned</p>
            <p className="text-4xl font-black bg-gradient-to-r from-emerald-500 to-emerald-700 bg-clip-text text-transparent mt-1">
              +{formatUGX(amount)}
            </p>
          </div>

          {businessName && (
            <div className="px-4 py-3 rounded-xl bg-muted/50 text-sm">
              <p className="flex items-center justify-center gap-1.5 font-semibold">
                <Briefcase className="h-4 w-4 text-primary" />
                {businessName}
              </p>
              {repaymentAmount ? (
                <p className="text-xs text-muted-foreground mt-1">
                  paid back {formatUGX(repaymentAmount)}
                </p>
              ) : null}
            </div>
          )}

          <p className="text-xs text-muted-foreground flex items-center justify-center gap-1">
            <Sparkles className="h-3 w-3" /> 4% of every business advance repayment is yours.
          </p>

          <Button onClick={onClose} className="w-full bg-emerald-600 hover:bg-emerald-700">
            Awesome!
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
