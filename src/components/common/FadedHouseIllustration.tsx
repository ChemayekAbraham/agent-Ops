import type { CSSProperties } from 'react';
import { cn } from '@/lib/utils';

/**
 * A modern two-storey house and a tree, drawn in white and faded out toward the top and left,
 * so it can sit faintly behind the text of a purple card. Position it with `className`
 * (it fills the width and sits on the bottom edge by default); `opacity` is 0-1.
 */
export function FadedHouseIllustration({
  className,
  opacity = 0.16,
}: {
  className?: string;
  opacity?: number;
}) {
  const glass = 'rgba(76, 18, 133, 0.55)'; // the cards' deep purple, so windows read as cut-outs
  const fade = 'radial-gradient(ellipse 90% 95% at 72% 100%, #000 28%, transparent 78%)';
  const style: CSSProperties = { opacity, WebkitMaskImage: fade, maskImage: fade };
  return (
    <svg
      viewBox="0 0 420 280"
      fill="none"
      aria-hidden="true"
      className={cn('pointer-events-none absolute inset-x-0 bottom-0 z-0 h-auto w-full', className)}
      style={style}
    >
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

export default FadedHouseIllustration;
