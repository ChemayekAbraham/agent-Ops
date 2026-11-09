import { useEffect, useRef, useState } from 'react';
import { Maximize, Radio, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import logo from '@/assets/welile-logo.png';
import { loadBoardDisplay } from '@/lib/boardDisplayClient';
import { BOARD_IDLE_MS, BOARD_POLL_MS, BOARD_PULSE_MS, BOARD_RETRY_MS, BoardFeed, BoardMetric, boardDisplayToken, boardIsStale, boardMoney, kampalaClock } from '@/lib/boardDisplay';

const metrics: { key: BoardMetric; title: string; caption: string }[] = [
  { key: 'posted', title: 'Rent requests posted', caption: "From the COO to the funders' board" },
  { key: 'sold', title: 'Rent requests sold', caption: 'Partner took it and money released to the landlord' },
  { key: 'waiting', title: 'Waiting for funder', caption: 'Posted and not yet sold' },
];
function ChangedNumber({ value, money = false }: { value: number | null; money?: boolean }) {
  const previous = useRef(value);
  const [pulse, setPulse] = useState(false);
  useEffect(() => {
    if (previous.current === value) return;
    previous.current = value; setPulse(true);
    const timer = window.setTimeout(() => setPulse(false), BOARD_PULSE_MS);
    return () => window.clearTimeout(timer);
  }, [value]);
  return <span className={pulse ? 'board-number board-number-changed' : 'board-number'}>{value == null ? '—' : money ? boardMoney(value) : value.toLocaleString('en-GB')}</span>;
}
export default function BoardDisplay() {
  const token = boardDisplayToken(window.location.pathname, window.location.search);
  const [feed, setFeed] = useState<BoardFeed | null>(null);
  const [error, setError] = useState('');
  const [lastGood, setLastGood] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [idle, setIdle] = useState(false);
  useEffect(() => {
    const existing = document.querySelector<HTMLMetaElement>('meta[name="robots"]');
    const oldContent = existing?.content;
    const robots = existing ?? document.createElement('meta');
    robots.name = 'robots'; robots.content = 'noindex,nofollow';
    if (!existing) document.head.appendChild(robots);
    const title = document.title; document.title = 'Welile — Ops Command Centre Display';
    return () => { document.title = title; if (existing) existing.content = oldContent ?? ''; else robots.remove(); };
  }, []);
  useEffect(() => {
    let cancelled = false;
    let timer: number;
    const controller = new AbortController();
    async function refresh() {
      let delay = BOARD_POLL_MS;
      try {
        const data = await loadBoardDisplay(token, controller.signal);
        if (!cancelled) { setFeed(data); setLastGood(Date.now()); setError(''); }
      } catch (err) {
        delay = BOARD_RETRY_MS;
        if (!cancelled) setError(err instanceof Error ? err.message : 'This display is temporarily unavailable.');
      }
      if (!cancelled) timer = window.setTimeout(refresh, delay);
    }
    void refresh();
    return () => { cancelled = true; controller.abort(); window.clearTimeout(timer); };
  }, [token]);
  useEffect(() => {
    const clock = window.setInterval(() => setNow(Date.now()), 1_000);
    let timer: number;
    const active = () => { setIdle(false); window.clearTimeout(timer); timer = window.setTimeout(() => setIdle(true), BOARD_IDLE_MS); };
    active();
    window.addEventListener('pointermove', active); window.addEventListener('keydown', active); window.addEventListener('pointerdown', active);
    return () => { window.clearInterval(clock); window.clearTimeout(timer); window.removeEventListener('pointermove', active); window.removeEventListener('keydown', active); window.removeEventListener('pointerdown', active); };
  }, []);
  useEffect(() => {
    let disposed = false;
    let lock: { release(): Promise<void>; released: boolean } | undefined;
    let acquiring = false;
    const wake = navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<{ release(): Promise<void>; released: boolean }> } };
    async function acquire() {
      if (disposed || document.visibilityState !== 'visible' || !wake.wakeLock || acquiring || (lock && !lock.released)) return;
      acquiring = true;
      try { const next = await wake.wakeLock.request('screen'); if (disposed) await next.release(); else lock = next; } catch { /* TV/browser may not support wake lock. */ }
      finally { acquiring = false; }
    }
    void acquire(); document.addEventListener('visibilitychange', acquire);
    return () => { disposed = true; document.removeEventListener('visibilitychange', acquire); void lock?.release().catch(() => {}); };
  }, []);
  const stale = boardIsStale(lastGood, now);
  return <main className={`board-display dark bg-background text-foreground ${idle ? 'board-idle' : ''}`}>
    <header className="board-topbar">
      <div className="board-brand"><img src={logo} alt="Welile" /><div><h1>Ops Command Centre</h1><p>{feed?.display.label || 'Boardroom display'}</p></div></div>
      <div className={`board-live ${stale ? 'text-warning' : 'text-success'}`}><Radio aria-hidden="true" /><div><strong>LIVE · {kampalaClock(now)} Kampala</strong><span>{feed ? `updated ${kampalaClock(feed.generated_at)} Kampala${stale ? ' · update delayed' : ''}` : 'Connecting'}</span></div></div>
      <Button variant="outline" size="sm" className="board-fullscreen" onClick={() => { void document.documentElement.requestFullscreen?.().catch(() => {}); }}><Maximize />Full screen</Button>
    </header>
    {!feed ? <section className="board-connection"><Radio className="text-muted-foreground" /><h2>{error ? 'Display unavailable' : 'Connecting to the command centre'}</h2><p role={error ? 'alert' : undefined}>{error || 'Loading current totals…'}</p></section> : <>
      {error && <p role="alert" className="board-error text-warning">{error}</p>}
      <div className="board-section-heading"><h2>Today</h2><span>Rent requests · live position</span></div>
      <section className="board-hero" aria-label="Today's rent requests">
        {metrics.map(({ key, title, caption }) => <article key={key} className={`board-tile board-${key} bg-card border border-border`}><h3>{title}</h3><div className="board-hero-count"><ChangedNumber value={feed.headline.today[key].n} /></div><div className="board-hero-money"><ChangedNumber value={feed.headline.today[key].ugx} money /></div><p>{caption}</p></article>)}
      </section>
      <section className="board-comparison" aria-label="Period comparison"><table><thead><tr><th scope="col">Rent requests</th>{['7 days', '30 days', '90 days', 'All time'].map(p => <th key={p} scope="col">{p}</th>)}</tr></thead><tbody>{metrics.map(({ key }) => <tr key={key}><th scope="row" className={`board-${key}`}>{key === 'posted' ? 'Posted' : key === 'sold' ? 'Sold' : 'Waiting'}</th>{(['7d', '30d', '90d', 'all'] as const).map(period => <td key={period}><strong><ChangedNumber value={feed.headline[period][key].n} /></strong><small><ChangedNumber value={feed.headline[period][key].ugx} money /></small></td>)}</tr>)}</tbody></table></section>
      <div className="board-section-heading"><h2>Pipeline</h2><span>Waiting · completed · pace</span></div>
      <section className="board-pipeline" aria-label="Operations pipeline">{feed.stages.map((stage, index) => <article className="board-stage bg-card border border-border" key={`${stage.ord}-${stage.stage}`}><div className="board-stage-heading"><span>{String(stage.ord).padStart(2, '0')}</span><h3>{stage.stage}</h3>{index < feed.stages.length - 1 && <ArrowRight aria-hidden="true" />}</div>{stage.waiting == null ? <div className="board-stage-waiting"><ChangedNumber value={stage.done_24h} /><small>done 24 h</small></div> : <><div className="board-stage-waiting"><ChangedNumber value={stage.waiting} /><small>waiting</small></div><div className="board-stage-money"><ChangedNumber value={stage.waiting_ugx} money /></div></>}<footer><span>done 24 h <strong><ChangedNumber value={stage.done_24h} /></strong></span><span>days to clear <strong><ChangedNumber value={stage.days_to_clear} /></strong></span></footer></article>)}</section>
    </>}
  </main>;
}