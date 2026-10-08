import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { AlertTriangle, Clock, FileText, Home, UserCheck, X } from 'lucide-react';
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useOverdueVettingAlert } from '@/hooks/useOverdueVettingAlert';
import { formatAge, type OverdueKind } from '@/lib/vettingOverdueCopy';
import { focusVettingItem } from './vettingNav';

const KIND_ICON: Record<OverdueKind, typeof FileText> = { rent_plan: FileText, landlord: Home, lc1: UserCheck };
const KIND_LABEL: Record<OverdueKind, string> = { rent_plan: 'Rent Plan', landlord: 'Landlord', lc1: 'LC1 chairperson' };

function usePrefersReducedMotion() {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!mq) return;
    setReduce(mq.matches);
    const on = () => setReduce(mq.matches);
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, []);
  return reduce;
}

/** 60-second countdown ring shown on the secondary button. */
function CountdownRing({ seconds }: { seconds: number }) {
  const r = 7; const c = 2 * Math.PI * r;
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden className="shrink-0 -rotate-90">
      <circle cx="9" cy="9" r={r} fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2" />
      <circle
        cx="9" cy="9" r={r} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
        strokeDasharray={c}
        style={{ animation: `ovd-ring ${seconds}s linear forwards`, ['--ovd-c' as string]: `${c}` }}
      />
    </svg>
  );
}

export function OverdueVettingDialog({ suppressed }: { suppressed?: boolean }) {
  const { open, data, copy, remindLater } = useOverdueVettingAlert({ suppressed });
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const reduce = usePrefersReducedMotion();
  const primaryRef = useRef<HTMLButtonElement>(null);

  if (!copy || !data) return null;
  const escalated = copy.tone === 'escalated';
  const ToneIcon = escalated ? AlertTriangle : Clock;
  const rows = (data.oldest ?? []).slice(0, 3);
  const seconds = data.remind_after_seconds ?? 60;

  const review = () => {
    const first = rows[0];
    remindLater();
    if (first) focusVettingItem(navigate, pathname, { kind: first.kind, id: first.id });
  };

  return (
    <AlertDialog open={open} onOpenChange={(o) => { if (!o) remindLater(); }}>
      <AlertDialogContent
        role="alertdialog"
        aria-labelledby="overdue-vetting-title"
        className={cn('overflow-hidden p-0 gap-0 sm:max-w-md', !reduce && 'ovd-enter')}
        onEscapeKeyDown={(e) => { e.preventDefault(); remindLater(); }}
        onPointerDownOutside={() => remindLater()}
        onOpenAutoFocus={(e) => { e.preventDefault(); primaryRef.current?.focus(); }}
      >
        <style>{`
          @keyframes ovd-rise { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
          @keyframes ovd-slide { from { opacity: 0; transform: translateX(-8px); } to { opacity: 1; transform: translateX(0); } }
          @keyframes ovd-ring { from { stroke-dashoffset: 0; } to { stroke-dashoffset: var(--ovd-c); } }
          .ovd-enter { animation: ovd-rise 180ms ease-out both; }
          .ovd-row { animation: ovd-slide 220ms ease-out both; }
        `}</style>

        <div
          className={cn(
            'flex items-center gap-2 px-5 py-3 border-b',
            escalated ? 'bg-destructive/10 border-destructive/30 text-destructive' : 'bg-warning/15 border-warning/40 text-foreground',
          )}
        >
          <ToneIcon className="h-5 w-5 shrink-0" aria-hidden />
          <AlertDialogTitle id="overdue-vetting-title" className="flex-1 text-base font-semibold">
            {copy.title}
          </AlertDialogTitle>
          <button
            type="button"
            onClick={remindLater}
            aria-label={copy.secondaryLabel}
            className="rounded-md p-1 opacity-80 hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          <AlertDialogDescription className="text-sm text-foreground">{copy.body}</AlertDialogDescription>

          {rows.length > 0 && (
            <ul className="divide-y divide-border rounded-lg border border-border">
              {rows.map((it, i) => {
                const Icon = KIND_ICON[it.kind];
                return (
                  <li
                    key={`${it.kind}-${it.id}`}
                    className={cn('flex items-center gap-3 px-3 py-2', !reduce && 'ovd-row')}
                    style={reduce ? undefined : { animationDelay: `${120 + i * 60}ms` }}
                  >
                    <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-label={KIND_LABEL[it.kind]} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-foreground">{it.label ?? KIND_LABEL[it.kind]}</p>
                      <p className="text-[11px] text-muted-foreground">{KIND_LABEL[it.kind]}</p>
                    </div>
                    <span
                      className={cn(
                        'shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-semibold tabular-nums',
                        escalated ? 'border-destructive/40 bg-destructive/10 text-destructive' : 'border-warning/50 bg-warning/15 text-foreground',
                      )}
                    >
                      {formatAge(it.age_hours)}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}

          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="outline" onClick={remindLater} className="gap-2">
              {!reduce && <CountdownRing seconds={seconds} />}
              {copy.secondaryLabel}
            </Button>
            <Button ref={primaryRef} onClick={review} variant={escalated ? 'destructive' : 'default'}>
              {copy.primaryLabel}
            </Button>
          </div>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}
