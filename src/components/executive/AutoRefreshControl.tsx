import { useEffect, useState } from 'react';
import { Timer } from 'lucide-react';

export type AutoRefreshMs = 0 | 15_000 | 30_000 | 60_000 | 300_000;

const OPTIONS: { value: AutoRefreshMs; label: string }[] = [
  { value: 0, label: 'Off' },
  { value: 15_000, label: '15s' },
  { value: 30_000, label: '30s' },
  { value: 60_000, label: '1m' },
  { value: 300_000, label: '5m' },
];

const STORAGE_KEY = 'welile.auto-refresh.rent-capacity';

export function useAutoRefreshInterval(defaultMs: AutoRefreshMs = 30_000) {
  const [ms, setMs] = useState<AutoRefreshMs>(() => {
    if (typeof window === 'undefined') return defaultMs;
    const raw = Number(window.localStorage.getItem(STORAGE_KEY));
    const allowed = OPTIONS.map((o) => o.value) as number[];
    return (allowed.includes(raw) ? (raw as AutoRefreshMs) : defaultMs);
  });
  useEffect(() => {
    try { window.localStorage.setItem(STORAGE_KEY, String(ms)); } catch { /* noop */ }
  }, [ms]);
  return [ms, setMs] as const;
}

/** Compact segmented control for picking a live auto-refresh interval. */
export function AutoRefreshControl({
  value,
  onChange,
  className = '',
}: {
  value: AutoRefreshMs;
  onChange: (ms: AutoRefreshMs) => void;
  className?: string;
}) {
  return (
    <div
      className={`inline-flex items-center gap-1 rounded-lg border border-border bg-background/80 px-1.5 py-1 ${className}`}
      title="Auto-refresh interval"
    >
      <Timer className="h-3 w-3 text-muted-foreground" aria-hidden />
      <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mr-0.5">
        Auto
      </span>
      {OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={`h-5 px-1.5 rounded-md text-[10px] font-semibold transition-colors ${
            value === o.value
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground hover:bg-muted'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export default AutoRefreshControl;