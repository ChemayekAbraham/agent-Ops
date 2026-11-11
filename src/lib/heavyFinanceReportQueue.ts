import type { QueryClient, QueryKey } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/**
 * Staff finance statements that scan the general ledger. One browser tab may
 * run only one of these at a time. Identical in-flight arguments share one
 * request. Callers pass the React Query abort signal so a report that has not
 * started yet is dropped when the user leaves that tab.
 *
 * get_platform_cash_summary and get_financial_statement_ledger_sums are here
 * for the same reason: each scans the ledger for about 20 seconds, and a
 * retry storm of the two together exhausted the database. The database also
 * allows only one computation of a given argument set at a time.
 */
export const HEAVY_FINANCE_REPORTS = [
  'fin_balance_sheet',
  'fin_income_statement',
  'fin_cash_flow',
  'get_statement_of_financial_position',
  'get_statement_of_cash_flows',
  'get_platform_cash_summary',
  'get_financial_statement_ledger_sums',
] as const;

export type HeavyFinanceReportName = (typeof HEAVY_FINANCE_REPORTS)[number];

/** Shown instead of retrying a statement timeout or a 5xx response. */
export const HEAVY_REPORT_SLOW_MESSAGE = 'Report is taking long, try again';

/** Cached reports are reused for at least this long, including after a remount. */
export const HEAVY_FINANCE_REPORT_STALE_MS = 5 * 60 * 1000;

/**
 * React Query settings for every heavy finance statement.
 * Before: app defaults (retry 2, or 3 on a slow network; refetch on mount when stale).
 * The position query also retried every error except statement timeout 57014, twice.
 * After: no retry, including when a tab is opened again, no focus/reconnect/interval
 * refetch, and no refetch on mount once a result is cached.
 */
export const heavyFinanceReportQueryOptions = {
  retry: false as const,
  retryOnMount: false as const,
  refetchOnWindowFocus: false as const,
  refetchOnMount: false as const,
  refetchOnReconnect: false as const,
  staleTime: HEAVY_FINANCE_REPORT_STALE_MS,
  refetchInterval: false as const,
};

type ErrorLike = {
  code?: unknown;
  status?: unknown;
  statusCode?: unknown;
  message?: unknown;
};

function numericStatus(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d{3}$/.test(value)) return Number(value);
  return undefined;
}

/** Statement timeout (57014) or an HTTP 5xx from PostgREST / the gateway. */
export function isSlowFinanceReportError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as ErrorLike;
  const code = typeof candidate.code === 'string' || typeof candidate.code === 'number'
    ? String(candidate.code)
    : '';
  if (code === '57014' || /^5\d\d$/.test(code)) return true;
  const status = numericStatus(candidate.status) ?? numericStatus(candidate.statusCode);
  if (status !== undefined && status >= 500 && status <= 599) return true;
  const message = typeof candidate.message === 'string' ? candidate.message.toLowerCase() : '';
  if (!message) return false;
  if (
    message.includes('statement timeout')
    || message.includes('canceling statement')
    || message.includes('cancelling statement')
  ) return true;
  if (
    message.includes('bad gateway')
    || message.includes('gateway timeout')
    || message.includes('service unavailable')
    || message.includes('internal server error')
  ) return true;
  return false;
}

export function financeReportErrorMessage(error: unknown): string {
  if (isSlowFinanceReportError(error)) return HEAVY_REPORT_SLOW_MESSAGE;
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === 'object' && typeof (error as ErrorLike).message === 'string') {
    const message = (error as ErrorLike).message as string;
    if (message) return message;
  }
  return 'Could not load this report';
}

export function heavyFinanceReportQueryKey(name: HeavyFinanceReportName, args: Record<string, unknown>): QueryKey {
  return ['heavy-finance-report', name, stableArgs(args)];
}

/**
 * A cancelled observer must not throw the result away: the statement may already
 * be running, and opening the same tab again should reuse it.
 */
export function rememberHeavyReportResult<T>(
  client: QueryClient,
  queryKey: QueryKey,
  signal: AbortSignal,
  data: T,
): T {
  if (signal.aborted) client.setQueryData(queryKey, data);
  return data;
}

type Job = {
  key: string;
  priority: number;
  seq: number;
  started: boolean;
  settled: boolean;
  /** True when any caller did not pass a signal, so the job must run. */
  uncancellable: boolean;
  signals: Set<AbortSignal>;
  task: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  promise: Promise<unknown>;
};

let seq = 0;
let active: Job | null = null;
const waiting: Job[] = [];
const inflight = new Map<string, Job>();

function abortError(): DOMException {
  return new DOMException('The report request was cancelled', 'AbortError');
}

function stableArgs(args: Record<string, unknown>): string {
  const keys = Object.keys(args).sort();
  return JSON.stringify(keys.map((key) => [key, args[key]]));
}

function allAborted(job: Job): boolean {
  if (job.uncancellable || job.signals.size === 0) return false;
  for (const signal of job.signals) {
    if (!signal.aborted) return false;
  }
  return true;
}

function settleAbort(job: Job) {
  if (job.started || job.settled) return;
  job.settled = true;
  const index = waiting.indexOf(job);
  if (index >= 0) waiting.splice(index, 1);
  if (inflight.get(job.key) === job) inflight.delete(job.key);
  job.reject(abortError());
}

function watch(job: Job, signal?: AbortSignal) {
  if (!signal) {
    job.uncancellable = true;
    return;
  }
  job.signals.add(signal);
  if (signal.aborted) {
    if (!job.started && allAborted(job)) settleAbort(job);
    return;
  }
  signal.addEventListener('abort', () => {
    if (!job.started && allAborted(job)) settleAbort(job);
  }, { once: true });
}

function pump() {
  if (active) return;
  for (let i = waiting.length - 1; i >= 0; i -= 1) {
    if (allAborted(waiting[i])) settleAbort(waiting[i]);
  }
  if (waiting.length === 0) return;
  waiting.sort((a, b) => b.priority - a.priority || a.seq - b.seq);
  const job = waiting.shift();
  if (!job) return;
  if (allAborted(job)) {
    settleAbort(job);
    pump();
    return;
  }
  active = job;
  job.started = true;
  job.task().then(
    (value) => {
      if (job.settled) return;
      job.settled = true;
      job.resolve(value);
    },
    (error: unknown) => {
      if (job.settled) return;
      job.settled = true;
      job.reject(error);
    },
  ).finally(() => {
    if (inflight.get(job.key) === job) inflight.delete(job.key);
    if (active === job) active = null;
    pump();
  });
}

async function callRpc(name: HeavyFinanceReportName, args: Record<string, unknown>): Promise<unknown> {
  // The generated `rpc` type is a generic overload set, so it does not overlap
  // with the plain call shape used here; go through `unknown`. A function with
  // no arguments is called with no params object, matching supabase.rpc(name).
  const rpc = supabase.rpc as unknown as (
    fn: string,
    params?: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: unknown }>;
  const { data, error } = Object.keys(args).length === 0
    ? await rpc(name)
    : await rpc(name, args);
  if (error) throw error;
  return data;
}

/**
 * Run one heavy finance statement.
 * `active` (the default) is the report on screen and jumps ahead of any report
 * still waiting that was marked inactive. A report that has already started is
 * left to finish — Postgres will not drop it if the browser disconnects.
 */
export function runHeavyFinanceReport<T>(
  name: HeavyFinanceReportName,
  args: Record<string, unknown>,
  options?: { active?: boolean; signal?: AbortSignal },
): Promise<T> {
  const key = `${name}:${stableArgs(args)}`;
  const existing = inflight.get(key);
  if (existing) {
    if (options?.active !== false && existing.priority < 1) existing.priority = 1;
    watch(existing, options?.signal);
    if (!existing.started && allAborted(existing)) settleAbort(existing);
    return existing.promise as Promise<T>;
  }

  let resolve!: (value: unknown) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  const job: Job = {
    key,
    priority: options?.active === false ? 0 : 1,
    seq: ++seq,
    started: false,
    settled: false,
    uncancellable: false,
    signals: new Set(),
    task: () => callRpc(name, args),
    resolve,
    reject,
    promise,
  };

  inflight.set(key, job);
  watch(job, options?.signal);
  if (job.settled) return promise as Promise<T>;
  waiting.push(job);
  pump();
  return promise as Promise<T>;
}

/** Test-only. Drops queued work so cases do not share a mutex. */
export function resetHeavyFinanceReportQueueForTests() {
  waiting.splice(0, waiting.length);
  inflight.clear();
  active = null;
  seq = 0;
}
