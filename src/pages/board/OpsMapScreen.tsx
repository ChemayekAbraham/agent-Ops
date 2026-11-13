import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import {
  LAYER_DEFAULTS,
  LAYER_LABEL,
  LAYER_ORDER,
  countText,
  desksSub,
  hoursText,
  hoursTone,
  layerCount,
  motionLine,
  stageTiles,
  ugxBare,
  ugxShort,
  type BoardMap,
  type LayerKey,
} from '@/lib/boardMap';
import { OpsTopBar, StageStrip, useOpsFonts } from './OpsChrome';
import { OpsMap, type Picked } from './OpsMap';

/**
 * Boardroom screen 3, the OPS COMMAND MAP (E96), as in the approved preview:
 * top bar with READINESS, six KPI tiles, layer switches with GPS coverage, the
 * map, alerts by severity, money in motion (oldest first) and the pipeline
 * strip. Every figure is the server's; one it did not send reads "—".
 * Names appear only when the server sends them (an office-locked link).
 */

const toneClass = (t: ReturnType<typeof hoursTone>) => (t === 'red' ? 'ops-tone-red' : t === 'amber' ? 'ops-tone-amber' : '');
/** The names card closes itself after this long, so the room is back on the map. */
export const CARD_IDLE_MS = 45_000;

function Kpis({ map }: { map: BoardMap }) {
  const k = map.kpis;
  const oldest = k.selected.oldestHours;
  return (
    <section className="ops-kpis ops-mono" aria-label="Headline figures">
      <div className="ops-kpi ops-kpi-sold" data-kpi="sold_today">
        <span className="ops-kpi-label">SOLD TODAY · LANDLORD PAID, OTP</span>
        <span className="ops-kpi-row"><span className="ops-kpi-value">{countText(k.soldToday.n)}</span><span className="ops-kpi-ugx">{ugxShort(k.soldToday.ugx)}</span></span>
      </div>
      <div className="ops-kpi ops-kpi-selected" data-kpi="selected">
        <span className="ops-kpi-label">SELECTED, WAITING · WITH AGENTS</span>
        <span className="ops-kpi-row">
          <span className="ops-kpi-value">{countText(k.selected.n)}</span>
          <span className="ops-kpi-ugx">{ugxShort(k.selected.ugx)}</span>
          {oldest !== null && (k.selected.n ?? 0) > 0 && <span className={`ops-kpi-sub ${toneClass(hoursTone(oldest))}`} data-oldest={hoursTone(oldest)}>OLDEST {hoursText(oldest).toUpperCase()}</span>}
        </span>
      </div>
      <div className="ops-kpi ops-kpi-board" data-kpi="on_board">
        <span className="ops-kpi-label">ON FUNDERS BOARD · NOT TAKEN</span>
        <span className="ops-kpi-row"><span className="ops-kpi-value">{countText(k.onBoard.n)}</span><span className="ops-kpi-ugx">{ugxShort(k.onBoard.ugx)}</span></span>
      </div>
      <div className="ops-kpi ops-kpi-desks" data-kpi="in_desks">
        <span className="ops-kpi-label">IN THE DESKS</span>
        <span className="ops-kpi-row"><span className="ops-kpi-value">{countText(k.inDesks)}</span><span className="ops-kpi-sub">{desksSub(map.stages)}</span></span>
      </div>
      <div className="ops-kpi" data-kpi="repaying">
        <span className="ops-kpi-label">REPAYING · LIVE PLANS</span>
        <span className="ops-kpi-row">
          <span className="ops-kpi-value">{countText(k.repaying)}</span>
          {k.arrearsPingsToday !== null && <span className={`ops-kpi-sub ${k.arrearsPingsToday > 0 ? 'ops-tone-red' : ''}`}>{countText(k.arrearsPingsToday)} ARREARS PINGS</span>}
        </span>
      </div>
      <div className="ops-kpi" data-kpi="agents">
        <span className="ops-kpi-label">FIELD AGENTS · 60 DAYS</span>
        <span className="ops-kpi-row">
          <span className="ops-kpi-value">{countText(k.agentsActive60d)}</span>
          {k.agentsFrozen !== null && <span className={`ops-kpi-sub ${k.agentsFrozen > 0 ? 'ops-tone-amber' : ''}`}>{countText(k.agentsFrozen)} FROZEN</span>}
        </span>
      </div>
    </section>
  );
}

function Layers({ map, visible, onToggle }: { map: BoardMap; visible: Record<LayerKey, boolean>; onToggle: (k: LayerKey) => void }) {
  const c = map.coverage;
  return (
    <aside className="ops-rail" aria-label="Map layers">
      <span className="ops-rail-title ops-mono">LAYERS</span>
      {LAYER_ORDER.map((k) => (
        <button key={k} type="button" className="ops-layer" aria-pressed={visible[k]} data-layer={k} onClick={() => onToggle(k)}>
          <span className={`ops-swatch ops-sw-${k}`} aria-hidden="true" />
          <span className="ops-layer-name">{LAYER_LABEL[k]}</span>
          <span className="ops-layer-count">{countText(layerCount(map, k))}</span>
        </button>
      ))}
      <div className="ops-coverage ops-mono" data-coverage>
        <span>GPS COVERAGE</span>
        {c.desksGps !== null && <span><b>Desks {countText(c.desksGps)}{map.kpis.inDesks !== null ? ` / ${countText(map.kpis.inDesks)}` : ''}</b></span>}
        {c.desksExcludedLegacy !== null && c.desksExcludedLegacy > 0 && <span>{countText(c.desksExcludedLegacy)} legacy Kigishu not mapped</span>}
        {c.repayingGps !== null && <span><b>Repaying {countText(c.repayingGps)}{c.repayingTotal !== null ? ` / ${countText(c.repayingTotal)}` : ''}</b></span>}
        {c.agentsWithBase !== null && <span><b>Agent bases {countText(c.agentsWithBase)}</b></span>}
      </div>
    </aside>
  );
}

function NamesCard({ picked, names, onClose }: { picked: Picked; names: boolean; onClose: () => void }) {
  const p = picked.point;
  const people = [
    ['Tenant', p.tenant],
    ['Agent', p.agent],
    ['Funder', p.funder],
    ['Landlord', p.landlord],
  ].filter(([, v]) => !!v) as [string, string][];
  useEffect(() => {
    const t = window.setTimeout(onClose, CARD_IDLE_MS);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener('keydown', onKey);
    };
  }, [picked, onClose]);
  return (
    <div className={`ops-card ops-card-${picked.kind}`} role="dialog" aria-label={picked.kind === 'sold' ? 'Sold' : 'Selected, waiting'} data-names-card={picked.kind}>
      <div className="ops-card-head">
        <div>
          <p className="ops-card-kind ops-mono">{picked.kind === 'sold' ? 'SOLD · LANDLORD PAID' : 'SELECTED · MONEY WITH AGENT'}</p>
          <p className="ops-card-title">{p.tenant ?? p.area ?? 'Rent request'}</p>
        </div>
        <button type="button" className="ops-card-close" onClick={onClose} aria-label="Close">
          <X aria-hidden="true" />
        </button>
      </div>
      <p className="ops-card-line ops-mono">
        {ugxShort(p.ugx)}
        {p.hours !== null && <span className={toneClass(hoursTone(picked.kind === 'selected' ? p.hours : null))}> · {hoursText(p.hours)}</span>}
        {p.area && p.tenant ? ` · ${p.area}` : ''}
      </p>
      {people.map(([role, name]) => (
        <p key={role} className="ops-card-line">
          {role}: <b>{name}</b>
        </p>
      ))}
      {people.length === 0 && !names && <p className="ops-card-line">Names show only on the office-network link.</p>}
    </div>
  );
}

function Alerts({ map }: { map: BoardMap }) {
  return (
    <div className="ops-panel ops-panel-grow" aria-label="Alerts by severity">
      <span className="ops-rail-title ops-mono">ALERTS · BY SEVERITY</span>
      {map.alerts.length === 0 ? (
        <p className="ops-empty">No alerts.</p>
      ) : (
        map.alerts.map((a, i) => (
          <div key={`${a.kind}-${i}`} className={`ops-alert ops-alert-${a.severity}`} data-alert={a.severity}>
            <span className="ops-alert-kind ops-mono">{a.severity.toUpperCase()}{a.kind ? ` · ${a.kind.toUpperCase()}` : ''}</span>
            <span className="ops-alert-text">{a.text}</span>
          </div>
        ))
      )}
    </div>
  );
}

function Motion({ map }: { map: BoardMap }) {
  return (
    <div className="ops-panel ops-panel-motion" aria-label="Money in motion">
      <span className="ops-rail-title ops-mono">MONEY IN MOTION · FUNDER → AGENT → LANDLORD</span>
      {map.moneyInMotion.length === 0 ? (
        <p className="ops-empty">No money waiting with agents.</p>
      ) : (
        map.moneyInMotion.map((m, i) => (
          <div key={i} className="ops-motion" data-motion={hoursTone(m.hours)}>
            <span className="ops-motion-name">{m.tenant ?? 'Selected tenant'}</span>
            <span className={`ops-motion-hours ops-mono ${toneClass(hoursTone(m.hours))}`}>{hoursText(m.hours)}</span>
            <span className="ops-motion-line">{motionLine(m)}</span>
            <span className="ops-motion-ugx ops-mono">{ugxBare(m.ugx)}</span>
          </div>
        ))
      )}
    </div>
  );
}

export function OpsMapScreen({
  label,
  map,
  now,
  stale,
  errorText,
  idle,
  switcher,
}: {
  /** E97: the screen switcher, when the link may switch. */
  switcher?: ReactNode;
  label: string;
  map: BoardMap;
  now: number;
  stale: boolean;
  errorText: string | null;
  idle: boolean;
}) {
  useOpsFonts();
  const [visible, setVisible] = useState<Record<LayerKey, boolean>>(LAYER_DEFAULTS);
  const [picked, setPicked] = useState<Picked | null>(null);
  const toggle = useCallback((k: LayerKey) => setVisible((v) => ({ ...v, [k]: !v[k] })), []);
  const closeCard = useCallback(() => setPicked(null), []);
  const tiles = useMemo(() => stageTiles(map.stages, map.kpis.soldToday), [map]);

  return (
    <main className={`ops-board ${idle ? 'ops-idle' : ''}`} data-board-state="live" data-screen="map">
      <OpsTopBar switcher={switcher} label={label} readiness={map.readiness} readinessRule={map.readinessRule} stale={stale} errorText={errorText} now={now} officeOnly={map.names} />
      <Kpis map={map} />
      <div className="ops-main">
        <Layers map={map} visible={visible} onToggle={toggle} />
        <section className="ops-map" aria-label="Operations map">
          <OpsMap data={map} visible={visible} onPick={setPicked} />
          {picked && <NamesCard picked={picked} names={map.names} onClose={closeCard} />}
        </section>
        <aside className="ops-right" aria-label="Alerts and money in motion">
          <Alerts map={map} />
          <Motion map={map} />
        </aside>
      </div>
      <StageStrip tiles={tiles} layout="strip" />
    </main>
  );
}
