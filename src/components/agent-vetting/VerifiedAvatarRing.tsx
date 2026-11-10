import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export type AgentVerifiedState = 'verified' | 'unverified' | null | undefined;

const SCALLOP =
  'M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z';

interface Props {
  state: AgentVerifiedState;
  size?: 'sm' | 'md' | 'lg';
  children: ReactNode;
  className?: string;
}

/**
 * Presentation-only ring + badge around an avatar. `state` comes from
 * useAgentVerifiedState(); null/undefined renders the avatar untouched.
 */
export function VerifiedAvatarRing({ state, size = 'md', children, className }: Props) {
  if (state !== 'verified' && state !== 'unverified') return <>{children}</>;
  const verified = state === 'verified';
  const badge = size === 'lg' ? 'h-[18px] w-[18px]' : 'h-3.5 w-3.5';

  return (
    <span
      className={cn(
        'relative inline-flex shrink-0 rounded-full border-[3px]',
        verified ? 'border-primary' : 'border-destructive',
        className,
      )}
      data-verified-state={state}
    >
      {children}
      <span
        className={cn(
          'absolute -bottom-1 -right-1 z-10 flex items-center justify-center rounded-full bg-background p-px',
          !verified && 'motion-safe:animate-[pulse_2.6s_ease-in-out_infinite]',
        )}
      >
        {verified ? (
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#16A34A" stroke="#16A34A" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={badge} aria-hidden="true">
            <path d={SCALLOP} />
            <path d="m9 12 2 2 4-4" stroke="white" />
          </svg>
        ) : (
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={cn(badge, 'fill-destructive stroke-destructive')} aria-hidden="true">
            <path d={SCALLOP} />
            <path d="M12 7.5v5" stroke="white" strokeWidth="3" />
            <path d="M12 16.5h.01" stroke="white" strokeWidth="3.5" />
          </svg>
        )}
        <span className="sr-only">{verified ? 'Verified agent' : 'Not verified'}</span>
      </span>
    </span>
  );
}
