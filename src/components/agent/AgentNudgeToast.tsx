import { X } from 'lucide-react';
import type { RenderedNudge } from '@/lib/agentNudges';
import { cn } from '@/lib/utils';

const CATEGORY_EMOJI: Record<string, string> = {
  rank: '🏆',
  collect: '💰',
  commission: '🤑',
  streak: '🔥',
  new_tenant: '🌱',
  celebrate: '🎉',
  morning: '☀️',
};

const TONE_STYLES = {
  celebrate: {
    card: 'bg-[linear-gradient(135deg,hsl(var(--nudge-gold)),hsl(var(--nudge-orange))_45%,hsl(var(--primary)))] text-primary-foreground border-transparent',
    badge: 'bg-background/90 text-foreground',
    cta: 'bg-background text-foreground hover:bg-background/90',
    close: 'text-primary-foreground/80 hover:bg-background/20',
    body: 'text-primary-foreground/90',
  },
  nudge: {
    card: 'bg-[linear-gradient(135deg,hsl(var(--primary)),hsl(var(--primary)/0.85))] text-primary-foreground border-transparent border-l-4 border-l-[hsl(var(--nudge-orange))]',
    badge: 'bg-[hsl(var(--nudge-orange))] text-foreground',
    cta: 'bg-[hsl(var(--nudge-orange))] text-foreground hover:opacity-90',
    close: 'text-primary-foreground/80 hover:bg-background/20',
    body: 'text-primary-foreground/90',
  },
  info: {
    card: 'bg-card text-card-foreground border-primary/20',
    badge: 'bg-primary/10 text-primary',
    cta: 'bg-primary text-primary-foreground hover:bg-primary/90',
    close: 'text-muted-foreground hover:bg-muted',
    body: 'text-muted-foreground',
  },
} as const;

const SPARKS = [
  { dx: '-40px', dy: '-24px', c: '✨' },
  { dx: '36px', dy: '-28px', c: '🎊' },
  { dx: '-28px', dy: '26px', c: '⭐' },
  { dx: '42px', dy: '20px', c: '✨' },
  { dx: '0px', dy: '-38px', c: '🎉' },
];

interface Props {
  nudge: RenderedNudge;
  ctaLabel?: string;
  onCta?: () => void;
  onClose: () => void;
}

export function AgentNudgeToast({ nudge, ctaLabel, onCta, onClose }: Props) {
  const s = TONE_STYLES[nudge.tone] ?? TONE_STYLES.info;
  const emoji = CATEGORY_EMOJI[nudge.category] ?? '👋';
  return (
    <div
      role="status"
      className={cn(
        'nudge-enter relative flex w-[calc(100vw-2rem)] max-w-[420px] items-start gap-3 overflow-hidden rounded-2xl border p-3.5 pr-9 shadow-xl',
        s.card,
      )}
    >
      <div className="relative shrink-0">
        <div className={cn('nudge-badge flex h-11 w-11 items-center justify-center rounded-full text-2xl shadow-sm', s.badge)} aria-hidden>
          {emoji}
        </div>
        {nudge.tone === 'celebrate' &&
          SPARKS.map((p, i) => (
            <span
              key={i}
              aria-hidden
              className="nudge-sparkle pointer-events-none absolute left-1/2 top-1/2 -ml-2 -mt-2 text-sm"
              style={{ ['--dx' as string]: p.dx, ['--dy' as string]: p.dy, animationDelay: `${200 + i * 60}ms` }}
            >
              {p.c}
            </span>
          ))}
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-2 min-[400px]:flex-row min-[400px]:items-center">
        <div className="min-w-0 flex-1">
          <p className="text-base font-extrabold leading-tight">{nudge.title}</p>
          <p className={cn('mt-0.5 text-sm leading-snug', s.body)}>{nudge.body}</p>
        </div>
        {ctaLabel && onCta && (
          <button
            type="button"
            onClick={onCta}
            className={cn('shrink-0 rounded-full px-4 py-2 text-sm font-bold shadow-sm transition-transform active:scale-95 w-full min-[400px]:w-auto', s.cta)}
          >
            {ctaLabel}
          </button>
        )}
      </div>

      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className={cn('absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-full', s.close)}
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

export default AgentNudgeToast;
