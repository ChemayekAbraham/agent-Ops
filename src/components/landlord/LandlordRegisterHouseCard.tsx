import { ArrowRight, Building2 } from 'lucide-react';
import { hapticTap } from '@/lib/haptics';
import { cn } from '@/lib/utils';
import { FadedHouseIllustration } from '@/components/common/FadedHouseIllustration';

/**
 * The landlord dashboard's major action: Register your house here.
 * Mirrors the agent dashboard's "Post a rent request here" card (AgentPostRentRequestCard):
 * tall gradient card, icon badge top-left, stacked words, round arrow at the bottom.
 */
export function LandlordRegisterHouseCard({
  onOpen,
  className,
}: {
  onOpen: () => void;
  className?: string;
}) {
  return (
    <button
      onClick={() => { hapticTap(); onOpen(); }}
      aria-label="Register your house here"
      title="Register your house here"
      // `agent-post-rent-request-card` keeps the gradient in low-data mode (see index.css).
      className={cn(
        "agent-post-rent-request-card flex w-full flex-col justify-between rounded-3xl border border-primary/30 bg-[#7214c9] p-5 sm:p-6 text-center text-white shadow-xl transition-all active:scale-[0.98] touch-manipulation focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 relative overflow-hidden group select-none aspect-[10/9] min-h-[290px] [container-type:inline-size]",
        className,
      )}
      style={{
        background: 'linear-gradient(135deg, #8b28f7 0%, #6d1bbd 50%, #4c1285 100%)',
        backgroundColor: '#7214c9',
        WebkitTapHighlightColor: 'transparent',
      }}
    >
      {/* The house, very faint, fading up and to the left into the gradient */}
      <FadedHouseIllustration opacity={0.16} />

      {/* Subtle ambient lighting */}
      <div className="absolute -top-12 -right-12 h-44 w-44 rounded-full bg-white/10 blur-2xl pointer-events-none" />
      <div className="absolute -bottom-12 -left-12 h-44 w-44 rounded-full bg-black/20 blur-2xl pointer-events-none" />

      {/* Top icon badge */}
      <div className="flex w-full items-center justify-start relative z-10 shrink-0">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-white/15 backdrop-blur-md shadow-sm">
          <Building2 className="h-5 w-5 text-white" strokeWidth={2.4} />
        </div>
      </div>

      {/* Stacked words */}
      {/* The words scale with the card's width (cqw), so it looks the same on a phone and in the phone-width column. */}
      <div className="w-full flex-1 flex flex-col justify-center items-center gap-[2.4cqw] text-center py-1 relative z-10 select-none">
        <span className="text-[length:clamp(20px,6.6cqw,34px)] font-extrabold uppercase tracking-tight leading-none text-white/85">
          Register
        </span>
        <div className="flex items-baseline justify-center gap-[2.4cqw]">
          <span className="text-[length:clamp(20px,6.6cqw,34px)] font-extrabold uppercase tracking-tight leading-none text-white/80">
            your
          </span>
          <span className="text-[length:clamp(30px,10.4cqw,54px)] font-black uppercase tracking-tighter leading-none text-white drop-shadow-md">
            house
          </span>
        </div>
        <span className="text-[length:clamp(30px,10.4cqw,54px)] font-black uppercase tracking-tighter leading-none text-white drop-shadow-md">
          here
        </span>
        <div className="mt-[1.2cqw] flex h-10 w-10 items-center justify-center rounded-full bg-white/15 backdrop-blur-xs shadow-md group-hover:bg-white/25 transition-all group-hover:translate-x-0.5">
          <ArrowRight className="h-5 w-5 text-white opacity-95" strokeWidth={2.5} />
        </div>
        <span className="self-end text-right text-[length:clamp(12px,4cqw,17px)] font-medium leading-tight text-white/80">
          and <span className="font-semibold text-emerald-300">start earning guaranteed<br />monthly rent</span>
        </span>
      </div>
    </button>
  );
}

export default LandlordRegisterHouseCard;
