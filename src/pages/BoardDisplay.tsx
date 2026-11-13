import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Maximize, Radio, X } from 'lucide-react';
import logo from '@/assets/welile-logo.png';
import { loadBoardDisplay, loadBoardList } from '@/lib/boardDisplayClient';
import {
  BOARD_IDLE_MS,
  BOARD_NOW_METRICS,
  BOARD_PANEL_IDLE_MS,
  BOARD_PERIODS,
  BOARD_PERIOD_LABELS,
  BOARD_POLL_MS,
  BOARD_PULSE_MS,
  BOARD_RETRY_MS,
  BOARD_ROTATE_MS,
  BOARD_SORTS,
  type BoardFeed,
  type BoardList,
  type BoardMetric,
  type BoardPeriod,
  type BoardScreen,
  type BoardSort,
  boardDays,
  boardDisplayToken,
  boardHash,
  nextBoardScreen,
  readBoardHash,
  boardIsStale,
  boardMoney,
  boardUpdatedText,
  isBoardLinkError,
  kampalaClock,
  kampalaDate,
  readBoardPeriod,
  sortBoardRows,
  storeBoardPeriod,
} from '@/lib/boardDisplay';
import { OpsMapScreen } from './board/OpsMapScreen';
import { PipelineScreen } from './board/PipelineScreen';
import { ScreenSwitcher } from './board/ScreenSwitcher';

/**
 * The boardroom screen (/b/:code, /board/:code): a 16:9 TV display of the
 * funders' board totals, public behind a token. It boots on its own from
 * main.tsx — no sign-in, no app shell, no pop-ups. A light board: one period
 * toggle above four big tiles (E94: posted, sold, selected and waiting); a tap
 * on a tile lists the requests behind it, tenant name first, then the agent,
 * landlord and funder. The server sends names only to a link locked to the
 * office network; never phones or request ids (readBoardFeed and
 * readBoardList whitelist their contracts).
 */

const METRICS: { key: BoardMetric; title: string; caption: string }[] = [
  { key: 'posted', title: 'Rent requests posted', caption: "From the COO to the funders' board" },
  { key: 'sold', title: 'Rent requests sold', caption: 'Landlord paid — OTP confirmed' },
  { key: 'selected', title: 'Selected, waiting', caption: 'Funder took it, landlord not yet paid' },
  { key: 'waiting', title: 'Waiting for funder', caption: 'On the funders board now' },
];
/** Posted and sold follow the period; selected and waiting are right now. */
const whenLabel = (key: BoardMetric, period: BoardPeriod) => (BOARD_NOW_METRICS.includes(key) ? 'Now' : BOARD_PERIOD_LABELS[period]);
const safeStorage = () => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

/** A number that pulses for 0.8 s when it changes (not on its first appearance). */
function ChangedNumber({ value, money = false }: { value: number | null; money?: boolean }) {
  const previous = useRef(value);
  const [pulse, setPulse] = useState(false);
  useEffect(() => {
    if (previous.current === value) return;
    const had = previous.current != null;
    previous.current = value;
    if (!had) return;
    setPulse(true);
    const timer = window.setTimeout(() => setPulse(false), BOARD_PULSE_MS);
    return () => window.clearTimeout(timer);
  }, [value]);
  const text = value == null ? '—' : money ? boardMoney(value) : value.toLocaleString('en-GB');
  return <span className={pulse ? 'board-number board-number-changed' : 'board-number'} data-changed={pulse || undefined}>{text}</span>;
}

/**
 * The requests behind one tile: a side panel on a wide screen, a bottom sheet
 * on a narrow one (CSS decides). Close button and Esc; closes itself after a
 * minute with no touch so the room is back on the tiles; refreshes every 30 s
 * while open. Newest selected first, with oldest-first and amount toggles.
 * Each row: the tenant's name, then small "Agent:", "Landlord:", "Funder:"
 * lines, then ref, area, rent, status and dates.
 */
function ListPanel({ token, period, kind, onClose }: { token: string; period: BoardPeriod; kind: BoardMetric; onClose: () => void }) {
  const [list, setList] = useState<BoardList | null>(null);
  const [error, setError] = useState('');
  const [sort, setSort] = useState<BoardSort>('newest');
  const closeRef = useRef<HTMLButtonElement>(null);
  const title = METRICS.find((m) => m.key === kind)?.title ?? kind;
  const rows = useMemo(() => (list ? sortBoardRows(list.rows, sort) : []), [list, sort]);

  useEffect(() => {
    let cancelled = false;
    let timer: number;
    const controller = new AbortController();
    async function refresh() {
      try {
        const data = await loadBoardList(token, period, kind, controller.signal);
        if (!cancelled) {
          setList(data);
          setError('');
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error && err.message ? err.message : 'This list is temporarily unavailable.');
      }
      if (!cancelled) timer = window.setTimeout(refresh, BOARD_POLL_MS);
    }
    void refresh();
    return () => {
      cancelled = true;
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [token, period, kind]);

  // Esc closes; any touch, key or scroll restarts the one-minute auto-close.
  useEffect(() => {
    closeRef.current?.focus();
    let timer = window.setTimeout(onClose, BOARD_PANEL_IDLE_MS);
    const touched = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(onClose, BOARD_PANEL_IDLE_MS);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else touched();
    };
    const events = ['pointerdown', 'pointermove', 'wheel', 'touchstart', 'scroll'] as const;
    events.forEach((e) => window.addEventListener(e, touched, { passive: true, capture: true }));
    window.addEventListener('keydown', onKey);
    return () => {
      window.clearTimeout(timer);
      events.forEach((e) => window.removeEventListener(e, touched, { capture: true }));
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div className="board-panel-wrap" role="dialog" aria-modal="true" aria-label={title}>
      <button type="button" className="board-panel-backdrop" aria-label="Close" tabIndex={-1} onClick={onClose} />
      <section className={`board-panel board-${kind}`}>
        <header className="board-panel-header">
          <div>
            <h2>{title}</h2>
            <p data-board-list-summary>
              {whenLabel(kind, period)}
              {list && (
                <>
                  {' · '}
                  <strong>
                    {list.count.toLocaleString('en-GB')} {list.count === 1 ? 'request' : 'requests'}
                  </strong>
                  {' · '}
                  <strong>{boardMoney(list.ugx)}</strong>
                </>
              )}
              {list && list.shown < list.count && <> · newest {list.shown.toLocaleString('en-GB')} of {list.count.toLocaleString('en-GB')}</>}
            </p>
          </div>
          <button ref={closeRef} type="button" className="board-panel-close" onClick={onClose} aria-label="Close">
            <X aria-hidden="true" />
          </button>
        </header>
        {error && <p role="alert" className="board-panel-error">{error}</p>}
        {list && list.rows.length > 1 && (
          <div className="board-sort" role="group" aria-label="Order">
            {BOARD_SORTS.map((o) => (
              <button key={o.value} type="button" className="board-period" aria-pressed={sort === o.value} onClick={() => setSort(o.value)}>
                {o.label}
              </button>
            ))}
          </div>
        )}
        {!list ? (
          !error && <p className="board-panel-empty">Loading…</p>
        ) : list.rows.length === 0 ? (
          <p className="board-panel-empty">{BOARD_NOW_METRICS.includes(kind) ? 'Nothing right now' : 'Nothing in this period'}</p>
        ) : (
          <ul className="board-list" aria-label={title}>
            {rows.map((r, i) => (
              <li key={`${r.ref}-${i}`} className="board-list-row" data-board-row>
                <div className="board-list-top">
                  <span className="board-list-tenant" data-board-tenant>{r.tenant ?? '—'}</span>
                  <strong className="board-list-rent">{r.rent == null ? '—' : boardMoney(r.rent)}</strong>
                </div>
                <div className="board-list-people">
                  <span>Agent: <b>{r.agent ?? '—'}</b></span>
                  <span>Landlord: <b>{r.landlord ?? '—'}</b></span>
                  <span>Funder: <b>{r.funder ?? '—'}</b></span>
                </div>
                <div className="board-list-meta">
                  <span className="board-list-ref">{r.ref}</span>
                  {r.area && <span>{r.area}</span>}
                  {r.status_label && <span className="board-list-status">{r.status_label}</span>}
                  <span>Posted {kampalaDate(r.posted_at)}</span>
                  {!r.selected_at && <span>{boardDays(r.days_since_posted)} since posted</span>}
                  {r.selected_at && <span data-board-selected>Selected {kampalaDate(r.selected_at)}</span>}
                  {r.otp_verified_at && <span data-board-otp>OTP {kampalaDate(r.otp_verified_at)}</span>}
                  {kind === 'sold' && <span data-board-released>Money released {kampalaDate(r.money_released_at)}</span>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

export default function BoardDisplay() {
  const token = boardDisplayToken(window.location.pathname, window.location.search);
  const [feed, setFeed] = useState<BoardFeed | null>(null);
  const [error, setError] = useState<{ text: string; link: boolean } | null>(null);
  const [lastGood, setLastGood] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [idle, setIdle] = useState(false);
  const [period, setPeriodState] = useState<BoardPeriod>(() => readBoardPeriod(safeStorage()));
  const [open, setOpen] = useState<BoardMetric | null>(null);
  // E97: the screen asked for (null = the link's own) and auto-rotate, from the URL hash so a TV restart keeps them.
  const [wanted, setWanted] = useState<BoardScreen | null>(() => readBoardHash(window.location.hash).screen);
  const [rotate, setRotate] = useState<boolean>(() => readBoardHash(window.location.hash).rotate);
  const setPeriod = (p: BoardPeriod) => {
    setPeriodState(p);
    storeBoardPeriod(safeStorage(), p);
  };
  const close = useCallback(() => setOpen(null), []);

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

  const canSwitch = feed?.display.canSwitch === true;
  const shown = feed?.display.screen ?? null;
  const screensKey = (feed?.display.screens ?? []).map((s) => s.key).join(',');

  // E97 auto-rotate: a minute on each screen, Funders → Pipeline → Ops map, then round again.
  useEffect(() => {
    if (!rotate || !canSwitch || !shown || !feed) return;
    const t = window.setTimeout(() => setWanted(nextBoardScreen(feed.display.screens, shown)), BOARD_ROTATE_MS);
    return () => window.clearTimeout(t);
    // feed is read for its screen list only; screensKey stands for it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rotate, canSwitch, shown, screensKey]);

  // The URL hash follows the choice (#funders / #pipeline / #map / #rotate), with no reload and no history entry.
  useEffect(() => {
    if (!canSwitch) return;
    const hash = boardHash(wanted, rotate);
    if (window.location.hash === hash || (!hash && !window.location.hash)) return;
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${hash}`);
  }, [wanted, rotate, canSwitch]);

  // A tap on a tab is the room's choice: that screen, and auto-rotate off.
  const pickScreen = useCallback((s: BoardScreen) => {
    setRotate(false);
    setWanted(s);
  }, []);
  const toggleRotate = useCallback(() => setRotate((r) => !r), []);

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

  // E97: the switcher, only on a link that may switch.
  const switcher =
    feed && canSwitch ? (
      <ScreenSwitcher screens={feed.display.screens} active={feed.display.screen} rotate={rotate} onPick={pickScreen} onRotate={toggleRotate} />
    ) : null;

  // E96: a link set to screen 3 (the ops command map) or screen 2 (the pipeline) gets its own layout.
  // The polling, the 60 s retry and a refused link taking the whole screen stay exactly as below.
  if (feed && !fatal && feed.display.screen === 'map' && feed.map) {
    return <OpsMapScreen switcher={switcher} label={feed.display.label} map={feed.map} now={now} stale={stale} errorText={error?.text ?? null} idle={idle} />;
  }
  if (feed && !fatal && feed.display.screen === 'pipeline') {
    return <PipelineScreen switcher={switcher} label={feed.display.label} stages={feed.stages ?? []} now={now} stale={stale} errorText={error?.text ?? null} idle={idle} />;
  }

  return (
    <main className={`board-display ${idle ? 'board-idle' : ''}`} data-board-state={fatal ? 'error' : feed ? 'live' : 'connecting'}>
      <header className="board-topbar">
        <div className="board-brand">
          <img src={logo} alt="Welile" />
          <div>
            <h1>Ops Command Centre</h1>
            <p>{feed?.display.label || 'Boardroom display'}</p>
          </div>
        </div>
        {!fatal && switcher}
        {feed && !fatal && (
          <div className={`board-live ${stale ? 'text-warning' : 'text-success'}`} data-stale={stale || undefined}>
            <Radio aria-hidden="true" />
            <div>
              <strong>{boardUpdatedText(feed.generated_at)}</strong>
              {error && <span role="alert">{error.text} · trying again in 60 s</span>}
            </div>
          </div>
        )}
        <div className="board-clock" aria-label="Time in Kampala">
          <strong>{kampalaClock(now)}</strong>
          <span>Kampala</span>
        </div>
        <button
          type="button"
          className="board-fullscreen"
          aria-label="Full screen"
          title="Full screen"
          onClick={() => {
            void document.documentElement.requestFullscreen?.().catch(() => {});
          }}
        >
          <Maximize aria-hidden="true" />
        </button>
      </header>

      {fatal && error ? (
        <section className="board-message" role="alert">
          <h2>{error.text}</h2>
          <p>Trying again every 60 seconds.</p>
        </section>
      ) : !feed ? (
        <section className="board-message">
          <h2>Connecting to the command centre…</h2>
        </section>
      ) : (
        <>
          <div className="board-periods" role="group" aria-label="Period">
            {BOARD_PERIODS.map((p) => (
              <button key={p} type="button" aria-pressed={period === p} className="board-period" onClick={() => setPeriod(p)}>
                {BOARD_PERIOD_LABELS[p]}
              </button>
            ))}
          </div>
          <section className="board-hero" aria-label={`Rent requests · ${BOARD_PERIOD_LABELS[period]}`}>
            {METRICS.map(({ key, title, caption }) => (
              <button key={key} type="button" aria-haspopup="dialog" className={`board-tile board-${key}`} data-metric={key} onClick={() => setOpen(key)}>
                <span className="board-tile-when">{whenLabel(key, period)}</span>
                <h2>{title}</h2>
                <div className="board-hero-count"><ChangedNumber key={period} value={feed.headline[period][key].n} /></div>
                <div className="board-hero-money"><ChangedNumber key={period} value={feed.headline[period][key].ugx} money /></div>
                <p>{caption}</p>
              </button>
            ))}
          </section>
        </>
      )}
      {open && feed && !fatal && <ListPanel token={token} period={period} kind={open} onClose={close} />}
    </main>
  );
}
