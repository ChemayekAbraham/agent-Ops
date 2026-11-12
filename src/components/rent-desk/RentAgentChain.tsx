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
    <ul className={className ?? 'space-y-1.5'} data-testid="agent-chain">
      {lines.map((l) => {
        const tel = telHref(l.person.phone);
        const wa = whatsAppNumber(l.person.phone);
        return (
          <li
            key={`${l.role}-${l.person.id}`}
            className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-lg border border-border/50 bg-muted/25 px-2.5 py-1.5 text-xs"
            data-testid="agent-chain-line"
          >
            <div className="flex flex-wrap items-center gap-1.5 min-w-0">
              <span className="text-muted-foreground font-medium shrink-0">{l.role}:</span>
              {onOpenAgent ? (
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(e) => { e.stopPropagation(); onOpenAgent(l.person.id); }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      e.stopPropagation();
                      onOpenAgent(l.person.id);
                    }
                  }}
                  className="break-words text-left font-bold text-primary hover:underline cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  title="Open agent profile"
                >
                  {l.person.name}
                </span>
              ) : (
                <span className="break-words font-bold text-foreground">{l.person.name}</span>
              )}
              {afterName?.(l)}
            </div>

            {(l.person.phone || wa) && (
              <div className="flex items-center gap-2 shrink-0">
                {l.person.phone && (
                  tel ? (
                    <a
                      href={tel}
                      onClick={(e) => e.stopPropagation()}
                      className="inline-flex items-center gap-1 font-medium tabular-nums text-foreground hover:text-primary hover:underline"
                      aria-label={`Call ${l.person.name}`}
                    >
                      <Phone className="h-3 w-3 shrink-0 text-muted-foreground" />
                      <span>{l.person.phone}</span>
                    </a>
                  ) : (
                    <span className="tabular-nums text-muted-foreground">{l.person.phone}</span>
                  )
                )}
                {wa && (
                  <a
                    href={`https://wa.me/${wa}?text=${encodeURIComponent(`Hi ${l.person.name}, regarding a rent request on Welile.`)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 border border-emerald-500/25 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 dark:text-emerald-400 hover:bg-emerald-500/20 transition-colors"
                    aria-label={`WhatsApp ${l.person.name}`}
                  >
                    <MessageCircle className="h-3 w-3 shrink-0" />
                    <span>WhatsApp</span>
                  </a>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
