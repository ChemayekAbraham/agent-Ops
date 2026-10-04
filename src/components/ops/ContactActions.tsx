import { Phone, MessageSquare, MessageCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

function toIntl(raw: string): string {
  const digits = (raw ?? '').replace(/\D/g, '');
  if (!digits) return '';
  const national = digits.startsWith('0') ? digits.slice(1) : digits;
  return national.startsWith('256') ? national : '256' + national;
}

export function toWhatsAppUrl(raw: string, message?: string): string {
  const intl = toIntl(raw);
  const text = encodeURIComponent(message ?? 'Hello, this is Welile Ops.');
  return `https://wa.me/${intl}?text=${text}`;
}

type Props = {
  phone?: string | null;
  message?: string;
  size?: 'xs' | 'sm';
  className?: string;
  showLabels?: boolean;
  showSms?: boolean;
};

/**
 * Renders Call + WhatsApp (+ optional SMS) quick-action buttons next to a phone.
 * Stops click propagation so it can live inside larger clickable rows.
 */
export function ContactActions({
  phone,
  message,
  size = 'sm',
  className,
  showLabels = false,
  showSms = false,
}: Props) {
  const has = !!phone && phone.replace(/\D/g, '').length >= 7;
  const tel = has ? `tel:+${toIntl(phone!)}` : '#';
  const wa = has ? toWhatsAppUrl(phone!, message) : '#';
  const sms = has ? `sms:+${toIntl(phone!)}` : '#';
  const btn =
    size === 'xs'
      ? 'h-6 px-1.5 text-[10px]'
      : 'h-7 px-2 text-[11px]';
  const icon = size === 'xs' ? 'h-3 w-3' : 'h-3.5 w-3.5';
  return (
    <div className={cn('inline-flex items-center gap-1', className)} onClick={(e) => e.stopPropagation()}>
      <a
        href={tel}
        aria-disabled={!has}
        className={cn(
          'inline-flex items-center gap-1 rounded-md border border-border bg-background hover:bg-accent transition-colors',
          btn,
          !has && 'opacity-40 pointer-events-none',
        )}
        title={has ? `Call ${phone}` : 'No phone on file'}
      >
        <Phone className={cn(icon, 'text-primary')} />
        {showLabels && <span>Call</span>}
      </a>
      <a
        href={wa}
        target="_blank"
        rel="noopener noreferrer"
        aria-disabled={!has}
        className={cn(
          'inline-flex items-center gap-1 rounded-md border border-emerald-200 bg-emerald-50 hover:bg-emerald-100 text-emerald-700 transition-colors dark:bg-emerald-950 dark:border-emerald-900 dark:text-emerald-300',
          btn,
          !has && 'opacity-40 pointer-events-none',
        )}
        title={has ? `WhatsApp ${phone}` : 'No phone on file'}
      >
        <MessageCircle className={icon} />
        {showLabels && <span>WhatsApp</span>}
      </a>
      {showSms && (
        <a
          href={sms}
          aria-disabled={!has}
          className={cn(
            'inline-flex items-center gap-1 rounded-md border border-border bg-background hover:bg-accent transition-colors',
            btn,
            !has && 'opacity-40 pointer-events-none',
          )}
          title={has ? `SMS ${phone}` : 'No phone on file'}
        >
          <MessageSquare className={cn(icon, 'text-muted-foreground')} />
          {showLabels && <span>SMS</span>}
        </a>
      )}
    </div>
  );
}