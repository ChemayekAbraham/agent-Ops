import { MessageCircle } from 'lucide-react';

interface WhatsAppAgentButtonProps {
  phone: string | null | undefined;
  agentName: string | null | undefined;
  houseTitle: string;
  compact?: boolean;
}

function formatWhatsAppNumber(phone: string): string {
  // Convert Ugandan local format to international
  let cleaned = phone.replace(/\s+/g, '').replace(/[^0-9+]/g, '');
  if (cleaned.startsWith('0')) {
    cleaned = '256' + cleaned.slice(1);
  } else if (cleaned.startsWith('+')) {
    cleaned = cleaned.slice(1);
  }
  return cleaned;
}

export function WhatsAppAgentButton({ phone, agentName, houseTitle, compact }: WhatsAppAgentButtonProps) {
  if (!phone) return null;

  const waNumber = formatWhatsAppNumber(phone);
  const message = encodeURIComponent(
    `Hi${agentName ? ` ${agentName}` : ''}, I'm interested in the house listing: "${houseTitle}" on Welile. Is it still available?`
  );
  const url = `https://wa.me/${waNumber}?text=${message}`;

  if (compact) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-[hsl(142,70%,45%)] hover:bg-[hsl(142,70%,40%)] text-white font-semibold text-[10px] transition-colors touch-manipulation active:scale-[0.97] shrink-0"
      >
        <MessageCircle className="h-3 w-3" />
        Chat
      </a>
    );
  }

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-[hsl(142,70%,45%)] hover:bg-[hsl(142,70%,40%)] text-white font-semibold text-sm transition-colors touch-manipulation active:scale-[0.97]"
    >
      <MessageCircle className="h-4 w-4" />
      Chat with Agent{agentName ? ` · ${agentName.split(' ')[0]}` : ''}
    </a>
  );
}
