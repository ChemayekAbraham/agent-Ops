/**
 * Reads Tenant Ops Home's own figures for the tab's chosen dates (the same `useTenantOpsHomeRange` call
 * and the same start/end Home would use) and lines them up with the Payment Behavior summary, so any
 * drift between the two is shown on screen, in the console and in the PDF. Read-only; the Home hook is
 * used as it is.
 *
 * States: `filtered` (a filter is on, so Home cannot be compared), `checking` (either side still loading,
 * or a difference was just seen and both are being re-read once to rule out a payment landing between the
 * two reads), `match`, `differ`, `unavailable` (Home could not be read).
 */
import { useCallback, useEffect, useRef } from 'react';
import { useTenantOpsHomeRange } from '@/hooks/useTenantOpsHomeRange';
import { formatUGX } from '@/lib/rentCalculations';
import { compareWithHome, homeDifferenceMessage, type HomeCheck, type TabSummaryForCheck } from '@/lib/paymentBehaviorHomeCheck';

export type HomeCheckState = 'filtered' | 'checking' | 'match' | 'differ' | 'unavailable';

interface OverviewQueryLike {
  data?: { summary: TabSummaryForCheck } | undefined;
  isPlaceholderData: boolean;
  isFetching: boolean;
  refetch: () => Promise<unknown>;
}

export function usePaymentBehaviorHomeCheck(
  startIso: string,
  endIso: string,
  filtered: boolean,
  overview: OverviewQueryLike,
) {
  const home = useTenantOpsHomeRange(startIso, endIso, !filtered);
  const retried = useRef<string | null>(null);
  const warned = useRef<string | null>(null);

  const summary = overview.data?.summary;
  const homeReady = !filtered && home.isSuccess && !home.isPlaceholderData;
  const tabReady = !!summary && !overview.isPlaceholderData;
  const check: HomeCheck | null = homeReady && tabReady && home.data ? compareWithHome(home.data, summary!) : null;
  const fetching = home.isFetching || overview.isFetching;
  const signature = `${startIso}|${endIso}`;

  const { refetch: refetchHome } = home;
  const { refetch: refetchOverview } = overview;

  // A difference seen right after one side refreshed may only be a payment landing between the two
  // reads, so re-read both once before calling it a real difference.
  useEffect(() => {
    if (!check) return;
    if (check.status === 'match') { retried.current = null; return; }
    if (!fetching && retried.current !== signature) {
      retried.current = signature;
      void refetchHome();
      void refetchOverview();
    }
  }, [check, fetching, signature, refetchHome, refetchOverview]);

  const confirmedDiffer = check?.status === 'differ' && !fetching && retried.current === signature;

  useEffect(() => {
    if (!check || !confirmedDiffer) return;
    const key = `${signature}|${JSON.stringify(check.home)}|${JSON.stringify(check.tab)}`;
    if (warned.current === key) return;
    warned.current = key;
    console.warn('[PaymentBehavior] figures differ from Tenant Ops Home (Home is the reference)', {
      range: { startIso, endIso },
      home: check.home,
      tab: check.tab,
      difference: check.diff,
    });
  }, [check, confirmedDiffer, signature, startIso, endIso]);

  let state: HomeCheckState;
  if (filtered) state = 'filtered';
  else if (home.isError && !home.data) state = 'unavailable';
  else if (!check) state = 'checking';
  else if (check.status === 'match') state = 'match';
  else state = confirmedDiffer ? 'differ' : 'checking';

  /** For the PDF: re-read Home now and compare it with the report's own summary. */
  const checkAgainst = useCallback(async (reportSummary: TabSummaryForCheck): Promise<HomeCheck | null> => {
    if (filtered) return null;
    const fresh = await refetchHome();
    return fresh.data ? compareWithHome(fresh.data, reportSummary) : null;
  }, [filtered, refetchHome]);

  return {
    state,
    check,
    message: check && state === 'differ' ? homeDifferenceMessage(check, formatUGX) : null,
    checkAgainst,
  };
}
