import { AlertTriangle, CheckCircle2, Info } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  HOME_CHECK_FILTERED_TEXT, HOME_CHECK_MATCH_TEXT, HOME_CHECK_PLACE_FILTER_TEXT, HOME_CHECK_TOLERANCE_PCT, HOME_CHECK_TOLERANCE_UGX,
} from '@/lib/paymentBehaviorHomeCheck';
import type { HomeCheckState } from '@/hooks/tenantOpsWorkspace/usePaymentBehaviorHomeCheck';
import type { HomeCheck } from '@/lib/paymentBehaviorHomeCheck';
import { pct, ugx } from './labels';

/**
 * Plain-text reconciliation with Tenant Ops Home, at the top of the Overview. Home is the reference
 * for Expected, Collected, Short and % covered; this strip shows those four figures for the tab's
 * dates next to the tab's own billed, counted and short, and says plainly whether they agree.
 */
export function HomeCheckStrip({
  state, check, message, placeFilterOn,
}: { state: HomeCheckState; check: HomeCheck | null; message: string | null; placeFilterOn: boolean }) {
  if (state === 'filtered') {
    return (
      <div className="space-y-1 px-1 text-xs leading-relaxed text-muted-foreground" data-testid="home-check" data-state="filtered">
        <p className="flex items-start gap-2"><Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />{HOME_CHECK_FILTERED_TEXT}</p>
        {placeFilterOn && <p className="pl-[22px]">{HOME_CHECK_PLACE_FILTER_TEXT}</p>}
      </div>
    );
  }

  if (state === 'unavailable') {
    return (
      <p className="px-1 text-xs text-muted-foreground" data-testid="home-check" data-state="unavailable">
        Could not read Tenant Ops Home to compare right now.
      </p>
    );
  }

  const rows: { label: string; home: string; tab: string; off: boolean }[] = check
    ? [
        { label: 'Expected / billed', home: ugx(check.home.expected), tab: ugx(check.tab.expected), off: check.diff.expected > HOME_CHECK_TOLERANCE_UGX },
        { label: 'Collected / counted', home: ugx(check.home.collected), tab: ugx(check.tab.collected), off: check.diff.collected > HOME_CHECK_TOLERANCE_UGX },
        { label: 'Short', home: ugx(check.home.short), tab: ugx(check.tab.short), off: check.diff.short > HOME_CHECK_TOLERANCE_UGX },
        { label: '% covered', home: `${check.home.coveragePct}%`, tab: pct(check.tab.coveragePct), off: check.diff.coveragePct > HOME_CHECK_TOLERANCE_PCT },
      ]
    : [];

  return (
    <section className="space-y-2 px-1" aria-label="Check against Tenant Ops Home" data-testid="home-check" data-state={state}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h4 className="text-xs font-semibold">Check against Tenant Ops Home</h4>
        {state === 'match' && (
          <p className="flex items-center gap-1.5 text-[11px] font-medium text-success">
            <CheckCircle2 className="h-3.5 w-3.5" />{HOME_CHECK_MATCH_TEXT}
          </p>
        )}
        {state === 'checking' && <p className="text-[11px] text-muted-foreground">Checking…</p>}
      </div>

      {check && (
        <dl className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-x-4 gap-y-1 text-xs tabular-nums sm:max-w-xl">
          <dt className="text-[11px] text-muted-foreground" />
          <dd className="text-right text-[11px] font-semibold text-muted-foreground">Home</dd>
          <dd className="text-right text-[11px] font-semibold text-muted-foreground">This tab</dd>
          {rows.map((r) => (
            <div key={r.label} className="contents">
              <dt className="text-muted-foreground">{r.label}</dt>
              <dd className="text-right font-medium">{r.home}</dd>
              <dd className={cn('text-right font-medium', state === 'differ' && r.off && 'text-warning')}>{r.tab}</dd>
            </div>
          ))}
        </dl>
      )}

      {state === 'differ' && message && (
        <p role="alert" className="flex items-start gap-2 text-xs font-medium leading-relaxed text-warning">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{message}
        </p>
      )}
    </section>
  );
}
