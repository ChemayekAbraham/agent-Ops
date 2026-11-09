import { useEffect, useRef, useState } from 'react';
import { Maximize, Radio } from 'lucide-react';
import logo from '@/assets/welile-logo.png';
import { loadBoardDisplay } from '@/lib/boardDisplayClient';
import {
  BOARD_IDLE_MS,
  BOARD_POLL_MS,
  BOARD_PULSE_MS,
  BOARD_RETRY_MS,
  type BoardFeed,
  type BoardMetric,
  type BoardStage,
  boardDisplayToken,
  boardIsStale,
  boardMoney,
  boardStageDoneOnly,
  boardUpdatedText,
  isBoardLinkError,
  kampalaClock,
} from '@/lib/boardDisplay';

/**
 * The boardroom screen (/b/:code, /board/:code): a 16:9 TV display of the
 * funders' board totals, public behind a token. It boots on its own from
 * main.tsx — no sign-in, no app shell, no pop-ups — and reads only totals:
 * never names, phones or request ids (readBoardFeed whitelists the contract).
 */

const METRICS: { key: BoardMetric; title: string; row: string; caption: string }[] = [
  { key: 'posted', title: 'Rent requests posted', row: 'Posted', caption: "From the COO to the funders' board" },
  { key: 'sold', title: 'Rent requests sold', row: 'Sold', caption: 'Partner took it and money released to the landlord' },
  { key: 'waiting', title: 'Waiting for funder', row: 'Waiting', caption: 'Posted and not yet sold' },
];
const PERIODS = [
  { key: '7d', label: '7 days' },
  { key: '30d', label: '30 days' },
  { key: '90d', label: '90 days' },
  { key: 'all', label: 'All time' },
] as const;

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

function StageCard({ stage }: { stage: BoardStage }) {
  const doneOnly = boardStageDoneOnly(stage);
  return (
    <article className="board-stage" data-stage={stage.ord}>
      <h3>{stage.stage}</h3>
      {doneOnly ? (
        <>
          <div className="board-stage-big"><ChangedNumber value={stage.done_24h} /></div>
          <p className="board-stage-sub">came in · last 24 h</p>
        </>
      ) : (
        <>
          <div className="board-stage-big"><ChangedNumber value={stage.waiting} /></div>
          <p className="board-stage-sub">waiting · <ChangedNumber value={stage.waiting_ugx} money /></p>
          <dl className="board-stage-facts">
            <div><dt>Done 24 h</dt><dd><ChangedNumber value={stage.done_24h} /></dd></div>
            <div><dt>Days to clear</dt><dd><ChangedNumber value={stage.days_to_clear} /></dd></div>
          </dl>
        </>
      )}
    </article>
  );
}

export default function BoardDisplay() {
  const token = boardDisplayToken(window.location.pathname, window.location.search);
  const [feed, setFeed] = useState<BoardFeed | null>(null);
  const [error, setError] = useState<{ text: string; link: boolean } | null>(null);
  const [lastGood, setLastGood] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [idle, setIdle] = useState(false);

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
  useEffect(() => {
    let cancelled = false;
    let timer: number;
    const controller = new AbortController();
    async function refresh() {
      let delay = BOARD_POLL_MS;
      try {
        const data = await loadBoardDisplay(token, controller.signal);
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
  }, [token]);

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

  return (
    <main className={`board-display dark ${idle ? 'board-idle' : ''}`} data-board-state={fatal ? 'error' : feed ? 'live' : 'connecting'}>
      <header className="board-topbar">
        <div className="board-brand">
          <img src={logo} alt="Welile" />
          <div>
            <h1>Ops Command Centre</h1>
            <p>{feed?.display.label || 'Boardroom display'}</p>
          </div>
        </div>
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
          <section className="board-hero" aria-label="Today">
            {METRICS.map(({ key, title, caption }) => (
              <article key={key} className={`board-tile board-${key}`} data-metric={key}>
                <span className="board-tile-when">Today</span>
                <h2>{title}</h2>
                <div className="board-hero-count"><ChangedNumber value={feed.headline.today[key].n} /></div>
                <div className="board-hero-money"><ChangedNumber value={feed.headline.today[key].ugx} money /></div>
                <p>{caption}</p>
              </article>
            ))}
          </section>

          <section className="board-comparison" aria-label="Rent requests by period">
            <table>
              <thead>
                <tr>
                  <th scope="col"><span className="sr-only">Rent requests</span></th>
                  {PERIODS.map((p) => <th key={p.key} scope="col">{p.label}</th>)}
                </tr>
              </thead>
              <tbody>
                {METRICS.map(({ key, row }) => (
                  <tr key={key} className={`board-${key}`}>
                    <th scope="row">{row}</th>
                    {PERIODS.map((p) => (
                      <td key={p.key}>
                        <strong><ChangedNumber value={feed.headline[p.key][key].n} /></strong>
                        <small><ChangedNumber value={feed.headline[p.key][key].ugx} money /></small>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="board-pipeline" aria-label="Pipeline">
            {feed.stages.map((stage) => <StageCard key={`${stage.ord}-${stage.stage}`} stage={stage} />)}
          </section>
        </>
      )}
    </main>
  );
}
