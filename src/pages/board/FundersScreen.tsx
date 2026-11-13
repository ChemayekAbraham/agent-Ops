import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Maximize, Radio, X } from 'lucide-react';
import logo from '@/assets/welile-logo.png';
import {
  BOARD_NOW_METRICS,
  BOARD_PANEL_IDLE_MS,
  BOARD_PERIODS,
  BOARD_PERIOD_LABELS,
  BOARD_POLL_MS,
  BOARD_PULSE_MS,
  BOARD_SORTS,
  type BoardFeed,
  type BoardList,
  type BoardMetric,
  type BoardPeriod,
  type BoardSort,
  boardDays,
  boardMoney,
  boardUpdatedText,
  kampalaClock,
  kampalaDate,
  sortBoardRows,
} from '@/lib/boardDisplay';

/**
 * Boardroom screen 1, the FUNDERS board: a light 16:9 board with one period
 * toggle above four big tiles (E94: posted, sold, selected and waiting); a tap
 * on a tile lists the requests behind it, tenant name first, then the agent,
 * landlord and funder. Shared by the TV page (BoardDisplay) and the Command
 * Centre's Boardroom tab, like PipelineScreen and OpsMapScreen.
 *
 * The caller owns the data: the feed, the period (and where it is
 * remembered), the error, and how a tile's list is loaded (`loadList`: the TV
 * uses its token, a desk its signed-in client). `switcher` is the screen
 * switcher slot (E97). Before the first feed it shows "Connecting…"; a fatal
 * error takes the whole screen.
 */

/** Loads the requests behind one tile for a period. */
export type BoardListLoader = (period: BoardPeriod, kind: BoardMetric, signal: AbortSignal) => Promise<BoardList>;

const METRICS: { key: BoardMetric; title: string; caption: string }[] = [
  { key: 'posted', title: 'Rent requests posted', caption: "From the COO to the funders' board" },
  { key: 'sold', title: 'Rent requests sold', caption: 'Landlord paid — OTP confirmed' },
  { key: 'selected', title: 'Selected, waiting', caption: 'Funder took it, landlord not yet paid' },
  { key: 'waiting', title: 'Waiting for funder', caption: 'On the funders board now' },
];
/** Posted and sold follow the period; selected and waiting are right now. */
const whenLabel = (key: BoardMetric, period: BoardPeriod) => (BOARD_NOW_METRICS.includes(key) ? 'Now' : BOARD_PERIOD_LABELS[period]);
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
function ListPanel({ loadList, period, kind, onClose }: { loadList: BoardListLoader; period: BoardPeriod; kind: BoardMetric; onClose: () => void }) {
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
        const data = await loadList(period, kind, controller.signal);
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
  }, [loadList, period, kind]);

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

export function FundersScreen({
  feed,
  period,
  onPeriodChange,
  loadList,
  now,
  stale,
  error,
  idle,
  switcher,
}: {
  /** null until the first answer: "Connecting…". */
  feed: BoardFeed | null;
  period: BoardPeriod;
  onPeriodChange: (p: BoardPeriod) => void;
  loadList: BoardListLoader;
  now: number;
  stale: boolean;
  /** The last refresh's error; `fatal` (a refused link, or nothing ever loaded) takes the whole screen. */
  error: { text: string; fatal: boolean } | null;
  idle: boolean;
  /** E97: the screen switcher, when the link may switch. */
  switcher?: ReactNode;
}) {
  const [open, setOpen] = useState<BoardMetric | null>(null);
  const close = useCallback(() => setOpen(null), []);
  const fatal = !!error?.fatal;

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
              <button key={p} type="button" aria-pressed={period === p} className="board-period" onClick={() => onPeriodChange(p)}>
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
      {open && feed && !fatal && <ListPanel loadList={loadList} period={period} kind={open} onClose={close} />}
    </main>
  );
}
