import { useEffect, useRef, useState } from 'react';
import { Bug, X, Trash2, AlertTriangle } from 'lucide-react';
import {
  CREDIT_DEBUG_EVENT,
  type CreditLoadingEntry,
  getCreditDebugLog,
  clearCreditDebugLog,
  isCreditDebugEnabled,
} from '@/lib/creditLoadingDebug';

// Guard so the panel renders only once even if multiple credit cards mount.
let mountedCount = 0;

const TYPE_STYLES: Record<string, { label: string; cls: string }> = {
  'cold-load': { label: 'COLD LOAD (skeleton)', cls: 'bg-destructive/15 text-destructive' },
  'background-refresh': { label: 'background refresh', cls: 'bg-primary/15 text-primary' },
  'cache-hit': { label: 'cache hit', cls: 'bg-success/15 text-success' },
  'realtime-refetch': { label: 'realtime refetch', cls: 'bg-accent text-accent-foreground' },
  'done': { label: 'done', cls: 'bg-muted text-muted-foreground' },
};

export function CreditLoadingDebugPanel() {
  const [enabled] = useState(() => isCreditDebugEnabled());
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<CreditLoadingEntry[]>(() => getCreditDebugLog());
  const isPrimary = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    // Only the first-mounted instance owns the on-screen panel.
    mountedCount += 1;
    isPrimary.current = mountedCount === 1;
    return () => { mountedCount -= 1; };
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    const handler = () => setEntries(getCreditDebugLog());
    window.addEventListener(CREDIT_DEBUG_EVENT, handler);
    return () => window.removeEventListener(CREDIT_DEBUG_EVENT, handler);
  }, [enabled]);

  if (!enabled || !isPrimary.current) return null;

  const coldLoads = entries.filter((e) => e.type === 'cold-load').length;

  return (
    <div className="fixed bottom-4 right-4 z-[200] flex flex-col items-end gap-2 pointer-events-none">
      {open && (
        <div className="pointer-events-auto w-[280px] max-h-[50vh] flex flex-col rounded-xl border border-border bg-background/95 backdrop-blur shadow-xl overflow-hidden animate-fade-in">
          <div className="flex items-center justify-between px-3 py-2 border-b border-border">
            <div className="flex items-center gap-1.5">
              <Bug className="h-3.5 w-3.5 text-primary" />
              <span className="text-xs font-semibold">Credit loading log</span>
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={() => clearCreditDebugLog()}
                className="p-1 rounded hover:bg-muted text-muted-foreground"
                aria-label="Clear log"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
              <button
                onClick={() => setOpen(false)}
                className="p-1 rounded hover:bg-muted text-muted-foreground"
                aria-label="Close"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          <div className="px-3 py-2 border-b border-border text-[11px] flex items-center gap-1.5">
            {coldLoads <= 1 ? (
              <span className="text-success">{coldLoads} cold load — no skeleton flashing</span>
            ) : (
              <span className="text-destructive flex items-center gap-1">
                <AlertTriangle className="h-3 w-3" /> {coldLoads} cold loads — skeleton re-shown!
              </span>
            )}
          </div>

          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            {entries.length === 0 && (
              <p className="text-[11px] text-muted-foreground text-center py-3">No events yet…</p>
            )}
            {[...entries].reverse().map((e) => {
              const style = TYPE_STYLES[e.type] ?? TYPE_STYLES.done;
              return (
                <div key={e.id} className="flex items-start gap-2 text-[10px] leading-tight">
                  <span className="text-muted-foreground tabular-nums shrink-0">
                    {new Date(e.ts).toLocaleTimeString(undefined, { hour12: false })}
                  </span>
                  <span className={`px-1.5 py-0.5 rounded font-medium shrink-0 ${style.cls}`}>
                    {style.label}
                  </span>
                  {e.note && <span className="text-muted-foreground truncate">{e.note}</span>}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <button
        onClick={() => setOpen((v) => !v)}
        className="pointer-events-auto flex items-center gap-1.5 px-3 py-2 rounded-full bg-primary text-primary-foreground shadow-lg text-xs font-medium active:scale-95 transition-transform"
      >
        <Bug className="h-3.5 w-3.5" />
        {entries.length}
      </button>
    </div>
  );
}
