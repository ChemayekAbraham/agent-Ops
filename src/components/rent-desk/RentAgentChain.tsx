import type { ReactNode } from 'react';
import { MessageCircle, Phone } from 'lucide-react';
import { telHref } from '@/lib/awarenessCallLabels';
import { whatsAppNumber, type ChainLine } from '@/lib/rentAgentChain';

// The agent lines of a rent card or its Details dialog: "Sub-agent", "Main agent" (only for a verified link), or a single "Agent", plus an
// "Assigned agent" line when that is someone else. Each phone and WhatsApp link sits next to the name it belongs to. The server decided every line.

interface Props {
  lines: ChainLine[];
  /** opens the agent profile; when absent the name is plain text */
  onOpenAgent?: (agentId: string) => void;
  /** extra content shown right after a line's name (the desks put the registering agent's weekly collection % here) */
  afterName?: (line: ChainLine) => ReactNode;
  className?: string;
}

export function RentAgentChain({ lines, onOpenAgent, afterName, className }: Props) {
  if (lines.length === 0) return <p className="text-xs text-muted-foreground" data-testid="agent-chain-empty">No agent</p>;
  return (
    <ul className={className ?? 'space-y-1'} data-testid="agent-chain">
      {lines.map((l) => {
        const tel = telHref(l.person.phone);
        const wa = whatsAppNumber(l.person.phone);
        return (
          <li key={`${l.role}-${l.person.id}`} className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs" data-testid="agent-chain-line">
            <span className="text-muted-foreground">{l.role}:</span>
            {onOpenAgent ? (
              <button type="button" onClick={(e) => { e.stopPropagation(); onOpenAgent(l.person.id); }} className="min-h-6 break-words text-left font-semibold text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" title="Open agent profile">
                {l.person.name}
              </button>
            ) : (
              <span className="break-words font-semibold text-foreground">{l.person.name}</span>
            )}
            {afterName?.(l)}
            {l.person.phone && (
              tel ? (
                <a href={tel} onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-1 tabular-nums text-foreground hover:underline" aria-label={`Call ${l.person.name}`}>
                  <Phone className="h-3 w-3 shrink-0" />{l.person.phone}
                </a>
              ) : <span className="tabular-nums text-muted-foreground">{l.person.phone}</span>
            )}
            {wa && (
              <a
                href={`https://wa.me/${wa}?text=${encodeURIComponent(`Hi ${l.person.name}, regarding a rent request on Welile.`)}`}
                target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}
                className="inline-flex items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 font-medium text-foreground hover:bg-muted/70"
                aria-label={`WhatsApp ${l.person.name}`}
              >
                <MessageCircle className="h-3 w-3 shrink-0" />WhatsApp
              </a>
            )}
          </li>
        );
      })}
    </ul>
  );
}
