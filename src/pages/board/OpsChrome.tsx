import { useEffect } from 'react';
import type { Readiness, StageTile } from '@/lib/boardMap';
import { kampalaDay } from '@/lib/boardMap';
import { kampalaClock } from '@/lib/boardDisplay';
import './opsBoard.css';

/** The ops screens' type: Space Grotesk for words, JetBrains Mono for figures. Added once, from Google Fonts. */
const FONTS_HREF =
  'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=JetBrains+Mono:wght@400;600;700&display=swap';
export function useOpsFonts() {
  useEffect(() => {
    if (document.querySelector(`link[data-ops-fonts]`)) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = FONTS_HREF;
    link.setAttribute('data-ops-fonts', '');
    document.head.appendChild(link);
  }, []);
}

/**
 * WELILE OPS COMMAND · UGANDA THEATRE · {the link's label}; the READINESS pill
 * (map only), the LIVE pill (amber once no good refresh for two minutes) and
 * the Kampala clock.
 */
export function OpsTopBar({
  label,
  readiness,
  readinessRule,
  stale,
  errorText,
  now,
  officeOnly,
}: {
  label: string;
  readiness?: Readiness | null;
  readinessRule?: string | null;
  stale: boolean;
  errorText?: string | null;
  now: number;
  officeOnly?: boolean;
}) {
  const sub = ['UGANDA THEATRE', (label || 'Boardroom display').toUpperCase(), officeOnly ? 'OFFICE NETWORK ONLY' : null].filter(Boolean).join(' · ');
  return (
    <header className="ops-top">
      <div className="ops-brand">
        <div className="ops-mark ops-mono" aria-hidden="true">W</div>
        <div>
          <h1 className="ops-title">WELILE OPS COMMAND</h1>
          <p className="ops-subtitle ops-mono">{sub}</p>
        </div>
      </div>
      <div className="ops-top-right ops-mono">
        {errorText && <span role="alert" className="ops-error-line">{errorText} · trying again in 60 s</span>}
        {readiness && (
          <div className={`ops-pill ops-pill-${readiness}`} data-readiness={readiness} title={readinessRule ?? undefined}>
            READINESS · {readiness.toUpperCase()}
          </div>
        )}
        <div className={`ops-pill ${stale ? 'ops-pill-stale' : 'ops-pill-green'}`} data-stale={stale || undefined}>
          <span className="ops-dot" aria-hidden="true" />
          {stale ? 'STALE · NOT UPDATING' : 'LIVE · 30 s'}
        </div>
        <div className="ops-clock" aria-label="Time in Kampala">
          <strong>{kampalaClock(now)}</strong>
          <span>EAT · KAMPALA · {kampalaDay(now)}</span>
        </div>
      </div>
    </header>
  );
}

/** The pipeline: one strip under the map (screen 3), or two rows of four (screen 2). Same tiles. */
export function StageStrip({ tiles, layout }: { tiles: StageTile[]; layout: 'strip' | 'grid' }) {
  return (
    <section className={layout === 'grid' ? 'ops-grid ops-mono' : 'ops-strip ops-mono'} aria-label="Pipeline">
      {tiles.map((t) => (
        <div key={t.key} className={`ops-stage ops-stage-${t.tone}`} data-stage={t.label} data-bottleneck={t.bottleneck || undefined}>
          <span className="ops-stage-label">
            {t.label}
            {t.bottleneck ? ' ▲' : ''}
          </span>
          <span className="ops-stage-value">{t.value}</span>
          <span className="ops-stage-sub">{t.sub}</span>
          {t.detail && <span className="ops-stage-detail">{t.detail}</span>}
        </div>
      ))}
    </section>
  );
}
