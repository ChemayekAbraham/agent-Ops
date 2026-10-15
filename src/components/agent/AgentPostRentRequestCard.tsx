import { ArrowRight, UserPlus } from 'lucide-react';
import { hapticTap } from '@/lib/haptics';
import { cn } from '@/lib/utils';

/**
 * The agent dashboard's major action: Post a rent request here.
 * Stretches proportionally to occupy the main focal area of the screen.
 */
export function AgentPostRentRequestCard({
  onOpen,
  restricted = false,
  className,
}: {
  onOpen: () => void;
  /** Merchant Agents are payout-only: hide the action. */
  restricted?: boolean;
  className?: string;
}) {
  if (restricted) return null;

  return (
    <button
      onClick={() => { hapticTap(); onOpen(); }}
      aria-label="Post a rent request here"
      title="Post a rent request here"
      className={cn(
        "flex w-full flex-col justify-between rounded-3xl border border-primary/30 bg-gradient-to-br from-primary via-primary to-purple-900 p-5 sm:p-6 text-center text-primary-foreground shadow-xl transition-all active:scale-[0.98] touch-manipulation focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 relative overflow-hidden group select-none min-h-[220px]",
        className
      )}
      style={{ WebkitTapHighlightColor: 'transparent' }}
    >
      {/* Subtle ambient lighting */}
      <div className="absolute -top-12 -right-12 h-44 w-44 rounded-full bg-white/10 blur-2xl pointer-events-none" />
      <div className="absolute -bottom-12 -left-12 h-44 w-44 rounded-full bg-black/20 blur-2xl pointer-events-none" />

      {/* Top icon badge */}
      <div className="flex w-full items-center justify-start relative z-10 shrink-0">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-white/15 backdrop-blur-md shadow-sm">
          <UserPlus className="h-5 w-5 text-white" strokeWidth={2.4} />
        </div>
      </div>

      {/* Vertically structured words spanning the card with adjusted font-size, centered with 'a rent' on same line */}
      <div className="w-full flex-1 flex flex-col justify-evenly items-center text-center py-2 relative z-10 select-none">
        <span className="text-2xl xs:text-3xl sm:text-4xl font-extrabold uppercase tracking-tight leading-none text-white/85">
          Post
        </span>
        <div className="flex items-baseline justify-center gap-2">
          <span className="text-2xl xs:text-3xl sm:text-4xl font-extrabold uppercase tracking-tight leading-none text-white/80">
            a
          </span>
          <span className="text-4xl xs:text-5xl sm:text-6xl font-black uppercase tracking-tighter leading-none text-white drop-shadow-md">
            rent
          </span>
        </div>
        <span className="text-4xl xs:text-5xl sm:text-6xl font-black uppercase tracking-tighter leading-none text-white drop-shadow-md">
          request
        </span>
        <div className="flex flex-col items-center gap-2.5">
          <span className="text-2xl xs:text-3xl sm:text-4xl font-extrabold uppercase tracking-tight leading-none text-white/85">
            here
          </span>
          <div className="flex h-10 w-10 sm:h-11 sm:w-11 items-center justify-center rounded-full bg-white/15 backdrop-blur-xs shadow-md group-hover:bg-white/25 transition-all group-hover:translate-x-0.5 mt-0.5">
            <ArrowRight className="h-5 w-5 text-white opacity-95" strokeWidth={2.5} />
          </div>
        </div>
      </div>
    </button>
  );
}

export default AgentPostRentRequestCard;
