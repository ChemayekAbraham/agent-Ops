import { Network } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Shared "AGENT NETWORK — THE DRIVING FORCE" badge.
 * Bold, uppercase, purple background — rendered consistently across all
 * Welile Operations and COO dashboard cards where the mission label appears.
 */
export function AgentNetworkBadge({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md bg-[#9234EA] px-2 py-1 text-[11px] font-extrabold uppercase tracking-wide text-white shadow-sm',
        className,
      )}
    >
      <Network className="h-3.5 w-3.5 text-white shrink-0" />
      Agent network — the driving force
    </span>
  );
}
