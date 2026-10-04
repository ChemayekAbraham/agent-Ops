import { MessageCircle, Phone, Star, User } from 'lucide-react';

interface AgentContactBarProps {
  phone: string | null | undefined;
  agentName: string | null | undefined;
  agentRating?: number | null;
  houseTitle: string;
  compact?: boolean;
}

function formatWhatsAppNumber(phone: string): string {
  let cleaned = phone.replace(/\s+/g, '').replace(/[^0-9+]/g, '');
  if (cleaned.startsWith('0')) {
    cleaned = '256' + cleaned.slice(1);
  } else if (cleaned.startsWith('+')) {
    cleaned = cleaned.slice(1);
  }
  return cleaned;
}

export function AgentContactBar({ phone, agentName, agentRating, houseTitle, compact }: AgentContactBarProps) {
  if (!phone) return null;

  const waNumber = formatWhatsAppNumber(phone);
  const message = encodeURIComponent(
    `Hi${agentName ? ` ${agentName}` : ''}, I'm interested in the house listing: "${houseTitle}" on Welile. Is it still available?`
  );
  const waUrl = `https://wa.me/${waNumber}?text=${message}`;
  const telUrl = `tel:${phone.replace(/\s+/g, '')}`;

  if (compact) {
    return (
      <div className="flex items-center gap-2">
        <div className="flex flex-col items-end text-right min-w-0">
          {agentName && (
            <span className="text-xs font-medium text-foreground truncate max-w-[120px] leading-tight">
              {agentName}
            </span>
          )}
          {typeof agentRating === 'number' && (
            <span className="text-[10px] text-amber-500 flex items-center gap-0.5 leading-tight">
              <Star className="h-2.5 w-2.5 fill-amber-500" />
              {agentRating.toFixed(1)}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <a
            href={telUrl}
            onClick={(e) => e.stopPropagation()}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-primary hover:bg-primary/90 text-primary-foreground font-semibold text-[10px] transition-colors touch-manipulation active:scale-[0.97] shrink-0"
            aria-label="Call agent"
          >
            <Phone className="h-3 w-3" />
            Call
          </a>
          <a
            href={waUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-[hsl(142,70%,45%)] hover:bg-[hsl(142,70%,40%)] text-white font-semibold text-[10px] transition-colors touch-manipulation active:scale-[0.97] shrink-0"
          >
            <MessageCircle className="h-3 w-3" />
            Chat
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5 w-full">
      {agentName && (
        <span className="text-xs text-muted-foreground flex items-center gap-1 justify-center">
          <User className="h-3 w-3" />
          Listed by {agentName}
          {typeof agentRating === 'number' && (
            <span className="text-amber-500 flex items-center gap-0.5 ml-1">
              <Star className="h-3 w-3 fill-amber-500" />
              {agentRating.toFixed(1)}
            </span>
          )}
        </span>
      )}
      <div className="flex items-center gap-2 w-full">
        <a
          href={telUrl}
          onClick={(e) => e.stopPropagation()}
          className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-primary hover:bg-primary/90 text-primary-foreground font-semibold text-sm transition-colors touch-manipulation active:scale-[0.97]"
          aria-label="Call agent"
        >
          <Phone className="h-4 w-4" />
          Call
        </a>
        <a
          href={waUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-[hsl(142,70%,45%)] hover:bg-[hsl(142,70%,40%)] text-white font-semibold text-sm transition-colors touch-manipulation active:scale-[0.97]"
        >
          <MessageCircle className="h-4 w-4" />
          WhatsApp
        </a>
      </div>
    </div>
  );
}
