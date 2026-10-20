import { useEffect } from 'react';
import { X } from 'lucide-react';
import type { RenderedNudge } from '@/lib/agentNudges';

interface Props {
  nudge: RenderedNudge;
  ctaLabel?: string;
  onCta?: () => void;
  onClose: () => void;
}

/** Action links are hidden for now; flip to true to show them again. */
const SHOW_CTA = false;

const TONE_NOTES: Record<string, number[]> = {
  celebrate: [659.25, 783.99, 1046.5],
  nudge: [587.33, 880],
  info: [523.25],
};

let audioCtx: AudioContext | null = null;

/** Short, soft chime generated in the browser (no sound files). Fails silently. */
function playChime(tone: string) {
  try {
    if (typeof window === 'undefined') return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    if (!Ctx) return;
    audioCtx = audioCtx ?? new Ctx();
    const ctx = audioCtx;
    if (ctx.state === 'suspended') void ctx.resume();
    const notes = TONE_NOTES[tone] ?? TONE_NOTES.info;
    notes.forEach((freq, i) => {
      const start = ctx.currentTime + i * 0.12;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.12, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.35);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.4);
    });
  } catch {
    /* sound is optional */
  }
}

/** Wraps digits/amounts so they stand out in the system colour. */
function renderWithNumbers(text: string) {
  const parts = text.split(/(#[0-9]+|\d[\d,]*(?:\.\d+)?)/g);
  return parts.map((part, i) =>
    /^(#[0-9]+|\d[\d,]*(?:\.\d+)?)$/.test(part) ? (
      <span key={i} className="font-bold text-primary">
        {part}
      </span>
    ) : (
      part
    )
  );
}

/** Simple, calm nudge toast: plain card, text only. */
export function AgentNudgeToast({ nudge, ctaLabel, onCta, onClose }: Props) {
  useEffect(() => {
    playChime(nudge.tone);
  }, [nudge]);

  return (
    <div
      role="status"
      className="relative w-[calc(100vw-2rem)] max-w-[420px] rounded-lg border-2 border-primary/70 bg-card p-3 pr-9 text-card-foreground shadow-md"
    >
      <p className="text-sm font-bold leading-tight">{renderWithNumbers(nudge.title)}</p>
      <p className="mt-1 text-sm font-semibold leading-snug text-muted-foreground">
        {renderWithNumbers(nudge.body)}
      </p>
      {SHOW_CTA && ctaLabel && onCta && (
        <button
          type="button"
          onClick={onCta}
          className="mt-1.5 text-sm font-medium text-primary underline underline-offset-2 hover:text-primary/80"
        >
          {ctaLabel}
        </button>
      )}
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

export default AgentNudgeToast;
