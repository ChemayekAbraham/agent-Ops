import { ArrowRight, Building2 } from 'lucide-react';
import { hapticTap } from '@/lib/haptics';
import { cn } from '@/lib/utils';

/** A modern two-storey house and a tree, drawn in white so it can sit faintly behind the card text. */
function HouseIllustration({ className, style }: { className?: string; style?: React.CSSProperties }) {
  const glass = 'rgba(76, 18, 133, 0.55)'; // the card's deep purple, so windows read as cut-outs
  return (
    <svg viewBox="0 0 420 280" fill="none" aria-hidden="true" className={className} style={style}>
      {/* ground */}
      <path d="M0 262H420" stroke="white" strokeWidth="2" />
      {/* tree */}
      <rect x="346" y="214" width="8" height="48" rx="2" fill="white" fillOpacity="0.7" />
      <circle cx="350" cy="186" r="36" fill="white" fillOpacity="0.75" />
      <circle cx="378" cy="212" r="26" fill="white" fillOpacity="0.6" />
      <circle cx="324" cy="214" r="22" fill="white" fillOpacity="0.55" />
      {/* lower volume */}
      <rect x="40" y="172" width="250" height="90" fill="white" fillOpacity="0.9" />
      <rect x="28" y="162" width="274" height="11" rx="2" fill="white" />
      {/* upper volume */}
      <rect x="120" y="106" width="190" height="58" fill="white" fillOpacity="0.95" />
      <rect x="108" y="96" width="214" height="11" rx="2" fill="white" />
      {/* upper windows and balcony rail */}
      <rect x="140" y="118" width="40" height="38" rx="2" fill={glass} />
      <rect x="196" y="118" width="40" height="38" rx="2" fill={glass} />
      <rect x="252" y="118" width="40" height="38" rx="2" fill={glass} />
      <path d="M134 158H298" stroke={glass} strokeWidth="3" />
      {/* door and lower windows */}
      <rect x="60" y="196" width="38" height="66" rx="2" fill={glass} />
      <rect x="124" y="194" width="44" height="38" rx="2" fill={glass} />
      <rect x="182" y="194" width="44" height="38" rx="2" fill={glass} />
      <rect x="240" y="194" width="34" height="38" rx="2" fill={glass} />
      {/* shrub */}
      <ellipse cx="22" cy="254" rx="26" ry="14" fill="white" fillOpacity="0.7" />
    </svg>
  );
}

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
      <HouseIllustration
        className="pointer-events-none absolute inset-x-0 bottom-0 z-0 h-auto w-full opacity-[0.16]"
        style={{
          // Solid at the bottom right, dissolving toward the top and left.
          WebkitMaskImage: 'radial-gradient(ellipse 90% 95% at 72% 100%, #000 28%, transparent 78%)',
          maskImage: 'radial-gradient(ellipse 90% 95% at 72% 100%, #000 28%, transparent 78%)',
        }}
      />

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
