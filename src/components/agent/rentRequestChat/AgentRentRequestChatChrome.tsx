import type { ReactNode } from 'react';
import { ArrowLeft, Check, FileText, Loader2, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export function RentRequestChatHeader({
  onClose,
  onForm,
  formBusy,
  savedHint,
}: {
  onClose: () => void;
  onForm?: () => void;
  formBusy?: boolean;
  savedHint?: string | null;
}) {
  return (
    <header
      data-testid="rent-request-chat"
      className="shrink-0 bg-primary text-primary-foreground px-2 pt-[max(0.4rem,env(safe-area-inset-top))] pb-2 flex items-center gap-1"
    >
      <button
        type="button"
        onClick={onClose}
        className="h-11 w-11 shrink-0 rounded-full flex items-center justify-center hover:bg-white/10 active:bg-white/20"
        aria-label="Close rent request chat"
      >
        <ArrowLeft className="h-5 w-5" />
      </button>
      <div className="min-w-0 flex-1">
        <p className="text-[15px] font-semibold leading-tight truncate">Rent request</p>
        <p className="text-[11px] text-primary-foreground/80 truncate">
          {savedHint || 'One question at a time'}
        </p>
      </div>
      {onForm && (
        <button
          type="button"
          onClick={onForm}
          disabled={formBusy}
          className="h-11 px-2 shrink-0 rounded-full flex items-center gap-1 text-[11px] font-semibold hover:bg-white/10 disabled:opacity-60"
          aria-label="Preview blank field form"
        >
          {formBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
          Form
        </button>
      )}
    </header>
  );
}

export function RentRequestChatProgress({
  index,
  total,
  label,
}: {
  index: number;
  total: number;
  label: string;
}) {
  const pct = total > 0 ? Math.round(((index + 1) / total) * 100) : 0;
  return (
    <div className="shrink-0 bg-primary px-3 pb-2" aria-live="polite">
      <div className="flex items-center justify-between text-[11px] font-semibold text-primary-foreground/90 mb-1">
        <span>{label}</span>
        <span>{index + 1} of {total}</span>
      </div>
      <div className="h-1 rounded-full bg-primary-foreground/25 overflow-hidden">
        <div className="h-full bg-primary-foreground transition-all duration-300" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function RentRequestChatBubble({
  from,
  children,
}: {
  from: 'bot' | 'me';
  children: ReactNode;
}) {
  const mine = from === 'me';
  return (
    <div className={cn('flex', mine ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[85%] px-3 py-2 text-[14px] leading-snug shadow-sm whitespace-pre-wrap',
          mine
            ? 'bg-primary/30 text-foreground border border-primary/25 rounded-2xl rounded-tr-sm'
            : 'bg-card text-card-foreground rounded-2xl rounded-tl-sm',
        )}
      >
        {children}
      </div>
    </div>
  );
}

export function RentRequestChatFooter({
  onBack,
  onSend,
  onSkip,
  sendLabel,
  error,
  busy,
}: {
  onBack: () => void;
  onSend: () => void;
  onSkip?: () => void;
  sendLabel: string;
  error?: string | null;
  busy?: boolean;
}) {
  return (
    <div className="shrink-0 border-t border-primary/20 bg-primary/10 px-2 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] space-y-1.5">
      {error && (
        <p role="alert" className="px-2 text-[12px] font-semibold text-red-700">
          {error}
        </p>
      )}
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          className="h-11 rounded-full bg-white px-4"
          onClick={onBack}
          disabled={busy}
        >
          Back
        </Button>
        {onSkip && (
          <Button
            type="button"
            variant="ghost"
            className="h-11 rounded-full px-3"
            onClick={onSkip}
            disabled={busy}
          >
            Skip
          </Button>
        )}
        <Button
          type="button"
          className="h-11 flex-1 rounded-full bg-primary text-primary-foreground hover:bg-primary/90 font-semibold"
          onClick={onSend}
          disabled={busy}
          aria-label={sendLabel}
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : sendLabel === 'Submit' ? <Check className="h-4 w-4" /> : <Send className="h-4 w-4" />}
          {busy ? 'Sending…' : sendLabel}
        </Button>
      </div>
    </div>
  );
}
