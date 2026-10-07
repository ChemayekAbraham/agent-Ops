import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { kampalaTodayYmd } from '@/lib/kampalaDays';
import { useReceivablesPredictiveForecast, type ReceivablesForecast } from './useReceivables';

export const RECEIVABLE_FORECAST_PERIODS = [
  { id: '7d', label: 'Next 7 days', gran: 'day', n: 7 },
  { id: '14d', label: 'Next 14 days', gran: 'day', n: 14 },
  { id: '30d', label: 'Next 30 days', gran: 'day', n: 30 },
  { id: '60d', label: 'Next 60 days', gran: 'day', n: 60 },
  { id: '90d', label: 'Next 90 days', gran: 'day', n: 90 },
  { id: '1y', label: 'Next 1 year', gran: 'month', n: 12 },
  { id: '2y', label: 'Next 2 years', gran: 'month', n: 24 },
  { id: '3y', label: 'Next 3 years', gran: 'month', n: 36 },
  { id: '4y', label: 'Next 4 years', gran: 'month', n: 48 },
  { id: '5y', label: 'Next 5 years', gran: 'month', n: 60 },
] as const;

const ymd = (date: Date) => date.toISOString().slice(0, 10);
const average = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;

type CollectionHistory = { period_start: string; actual_amount: number };

export function completedCollectionHistory(history: CollectionHistory[], today: string, daily: boolean) {
  const current = new Date(`${today}T00:00:00Z`);
  const earliest = new Date(current);
  earliest.setUTCDate(earliest.getUTCDate() - 364);
  if (!daily) {
    current.setUTCDate(1);
    return history.filter((h) => h.period_start.slice(0, 10) >= ymd(earliest) && h.period_start.slice(0, 10) < ymd(current));
  }
  // Only whole Monday–Sunday weeks; never average today's unfinished collections.
  current.setUTCDate(current.getUTCDate() - (current.getUTCDay() + 6) % 7);
  const byDate = new Map(history.map((h) => [h.period_start.slice(0, 10), h]));
  const completed: CollectionHistory[] = [];
  for (let week = 1; week <= 8; week++) {
    const dates = Array.from({ length: 7 }, (_, day) => {
      const date = new Date(current);
      date.setUTCDate(date.getUTCDate() - week * 7 + day);
      return ymd(date);
    });
    if (dates.every((date) => byDate.has(date))) {
      for (const date of dates) {
        const entry = byDate.get(date);
        if (entry) completed.push(entry);
      }
    }
  }
  return completed;
}

/** Read-only history averages and exact scheduled amounts; no financial state is changed. */
export function useReceivablesProjection(id: string) {
  const period = RECEIVABLE_FORECAST_PERIODS.find((p) => p.id === id) ?? RECEIVABLE_FORECAST_PERIODS[0];
  const today = kampalaTodayYmd();
  const daily = period.gran === 'day';
  // The RPC caps BOTH history and forecast at p_periods. One period only returned
  // today/this month, not a historical sample. Load history independently of horizon.
  const historyQ = useReceivablesPredictiveForecast(period.gran, daily ? 60 : 12);
  const base = new Date(`${today}T00:00:00Z`);
  if (!daily) base.setUTCDate(1);
  const windows = Array.from({ length: period.n }, (_, index) => {
    const start = new Date(base);
    const next = new Date(base);
    if (daily) { start.setUTCDate(base.getUTCDate() + index); next.setUTCDate(base.getUTCDate() + index + 1); }
    else { start.setUTCMonth(base.getUTCMonth() + index); next.setUTCMonth(base.getUTCMonth() + index + 1); }
    next.setUTCDate(next.getUTCDate() - 1);
    return { start: ymd(start), from: index === 0 ? today : ymd(start), end: ymd(next), label: start.toLocaleDateString('en-GB', { timeZone: 'UTC', ...(daily ? { day: 'numeric', month: 'short' } : { month: 'short', year: 'numeric' }) }) };
  });
  const last = windows[windows.length - 1];
  const to = last?.end ?? today;
  const contractQ = useQuery({
    queryKey: ['receivables-projection-contract', today, to],
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const chunks: { from: string; to: string }[] = [];
      let cursor = new Date(`${today}T00:00:00Z`);
      while (ymd(cursor) <= to) {
        const end = new Date(cursor);
        end.setUTCDate(end.getUTCDate() + 400);
        chunks.push({ from: ymd(cursor), to: ymd(end) < to ? ymd(end) : to });
        cursor = new Date(end);
        cursor.setUTCDate(cursor.getUTCDate() + 1);
      }
      const reports = await Promise.all(chunks.map(async (chunk) => {
        const { data, error } = await supabase.rpc('get_receivables_forecast', { p_from: chunk.from, p_to: chunk.to });
        if (error) throw error;
        return data as unknown as ReceivablesForecast;
      }));
      return reports.flatMap((report) => report.days);
    },
  });
  const history = completedCollectionHistory(historyQ.data?.history ?? [], today, daily);
  const overall = average(history.map((h) => h.actual_amount));
  const rows = windows.map((window) => {
    const weekday = new Date(`${window.start}T00:00:00Z`).getUTCDay();
    const sameDay = daily ? history.filter((h) => new Date(h.period_start).getUTCDay() === weekday).map((h) => h.actual_amount) : [];
    const behavior = average(sameDay) ?? overall;
    // Both fields come from recorded obligations: fixed due dates and agreed
    // daily repayment/deduction amounts. Neither uses collection-history averages.
    const contract = contractQ.data ? contractQ.data.filter((d) => d.date.slice(0, 10) >= window.from && d.date.slice(0, 10) <= window.end).reduce((sum, d) => sum + d.scheduled + d.projected, 0) : null;
    return { key: window.start, date: daily ? window.start : window.label, label: window.label, behavior: behavior == null ? null : Math.round(behavior), contract };
  });
  return { period, daily, rows, historyQ, contractQ };
}