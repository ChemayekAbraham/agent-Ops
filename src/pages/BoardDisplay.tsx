import { useCallback, useEffect, useState } from 'react';
import { loadBoardDisplay, loadBoardList } from '@/lib/boardDisplayClient';
import {
  BOARD_IDLE_MS,
  BOARD_POLL_MS,
  BOARD_RETRY_MS,
  type BoardFeed,
  type BoardMetric,
  type BoardPeriod,
  boardDisplayToken,
  boardIsStale,
  isBoardLinkError,
  readBoardPeriod,
  storeBoardPeriod,
} from '@/lib/boardDisplay';
import { FundersScreen, OpsMapScreen, PipelineScreen, useBoardScreenControl } from './board';

/**
 * The boardroom screen (/b/:code, /board/:code): a 16:9 TV display of the
 * funders' board totals, public behind a token. It boots on its own from
 * main.tsx — no sign-in, no app shell, no pop-ups. A light board: one period
 * toggle above four big tiles (E94: posted, sold, selected and waiting); a tap
 * on a tile lists the requests behind it, tenant name first, then the agent,
 * landlord and funder. The server sends names only to a link locked to the
 * office network; never phones or request ids (readBoardFeed and
 * readBoardList whitelist their contracts).
 *
 * The three screens and the switcher live in src/pages/board (shared with the
 * Command Centre's Boardroom tab); this page owns the token, the polling, the
 * clock, the idle cursor, the wake lock and the remembered period.
 */

const safeStorage = () => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

export default function BoardDisplay() {
  const token = boardDisplayToken(window.location.pathname, window.location.search);
  const [feed, setFeed] = useState<BoardFeed | null>(null);
  const [error, setError] = useState<{ text: string; link: boolean } | null>(null);
  const [lastGood, setLastGood] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [idle, setIdle] = useState(false);
  const [period, setPeriodState] = useState<BoardPeriod>(() => readBoardPeriod(safeStorage()));
  // E97: the screen asked for and auto-rotate, kept in the URL hash so a TV restart keeps them.
  const { wanted, switcher } = useBoardScreenControl(feed);
  const setPeriod = useCallback((p: BoardPeriod) => {
    setPeriodState(p);
    storeBoardPeriod(safeStorage(), p);
  }, []);
  const loadList = useCallback(
    (p: BoardPeriod, kind: BoardMetric, signal: AbortSignal) => loadBoardList(token, p, kind, signal),
    [token],
  );

  // Not for search engines.
  useEffect(() => {
    const existing = document.querySelector<HTMLMetaElement>('meta[name="robots"]');
    const oldContent = existing?.content;
    const robots = existing ?? document.createElement('meta');
    robots.name = 'robots';
    robots.content = 'noindex,nofollow';
    if (!existing) document.head.appendChild(robots);
    const title = document.title;
    document.title = 'Welile — Ops Command Centre';
    return () => {
      document.title = title;
      if (existing) existing.content = oldContent ?? '';
      else robots.remove();
    };
  }, []);

  // Every 30 s; after an error, again in 60 s. The last totals stay up unless the link itself is refused.
  // A new screen asked for refetches at once (p_screen); the screen on show stays up until it arrives.
  useEffect(() => {
    let cancelled = false;
    let timer: number;
    const controller = new AbortController();
    async function refresh() {
      let delay = BOARD_POLL_MS;
      try {
        const data = await loadBoardDisplay(token, controller.signal, wanted);
        if (!cancelled) {
          setFeed(data);
          setLastGood(Date.now());
          setError(null);
        }
      } catch (err) {
        delay = BOARD_RETRY_MS;
        if (!cancelled) {
          const link = isBoardLinkError(err);
          setError({ text: err instanceof Error && err.message ? err.message : 'This display is temporarily unavailable.', link });
          if (link) setFeed(null);
        }
      }
      if (!cancelled) timer = window.setTimeout(refresh, delay);
    }
    void refresh();
    return () => {
      cancelled = true;
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [token, wanted]);

  // The clock, and the cursor and buttons hide after 3 s without input.
  useEffect(() => {
    const clock = window.setInterval(() => setNow(Date.now()), 1_000);
    let timer: number;
    const active = () => {
      setIdle(false);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setIdle(true), BOARD_IDLE_MS);
    };
    active();
    const events = ['pointermove', 'pointerdown', 'keydown'] as const;
    events.forEach((e) => window.addEventListener(e, active));
    return () => {
      window.clearInterval(clock);
      window.clearTimeout(timer);
      events.forEach((e) => window.removeEventListener(e, active));
    };
  }, []);

  // Keep the screen awake while the display is visible.
  useEffect(() => {
    let disposed = false;
    let lock: { release(): Promise<void>; released: boolean } | undefined;
    let acquiring = false;
    const wake = navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<{ release(): Promise<void>; released: boolean }> } };
    async function acquire() {
      if (disposed || document.visibilityState !== 'visible' || !wake.wakeLock || acquiring || (lock && !lock.released)) return;
      acquiring = true;
      try {
        const next = await wake.wakeLock.request('screen');
        if (disposed) await next.release();
        else lock = next;
      } catch {
        /* Some TV browsers have no wake lock. */
      } finally {
        acquiring = false;
      }
    }
    void acquire();
    document.addEventListener('visibilitychange', acquire);
    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', acquire);
      void lock?.release().catch(() => {});
    };
  }, []);

  const stale = boardIsStale(lastGood, now);
  const fatal = !!error && (error.link || !feed);

  // E96: a link set to screen 3 (the ops command map) or screen 2 (the pipeline) gets its own layout.
  // The polling, the 60 s retry and a refused link taking the whole screen stay exactly as below.
  if (feed && !fatal && feed.display.screen === 'map' && feed.map) {
    return <OpsMapScreen switcher={switcher} label={feed.display.label} map={feed.map} now={now} stale={stale} errorText={error?.text ?? null} idle={idle} />;
  }
  if (feed && !fatal && feed.display.screen === 'pipeline') {
    return <PipelineScreen switcher={switcher} label={feed.display.label} stages={feed.stages ?? []} now={now} stale={stale} errorText={error?.text ?? null} idle={idle} />;
  }
  return (
    <FundersScreen
      feed={feed}
      period={period}
      onPeriodChange={setPeriod}
      loadList={loadList}
      now={now}
      stale={stale}
      error={error ? { text: error.text, fatal } : null}
      idle={idle}
      switcher={switcher}
    />
  );
}
