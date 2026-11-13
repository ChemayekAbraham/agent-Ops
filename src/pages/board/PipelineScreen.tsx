import { useMemo, type ReactNode } from 'react';
import { pipelineLead, stageTiles, type MapStage } from '@/lib/boardMap';
import { OpsTopBar, StageStrip, useOpsFonts } from './OpsChrome';

/**
 * Boardroom screen 2, the PIPELINE (display.screen = 'pipeline'): the lead
 * line in the desks' own words, then the full stage row, Submitted → … →
 * Funders dashboard → Selected, waiting, as two rows of four at 1920×1080.
 * The same tiles as the strip under the map (stageTiles), bigger, with each
 * stage's waiting UGX and 7-day rate. Every figure is the server's.
 */
export function PipelineScreen({
  label,
  stages,
  now,
  stale,
  errorText,
  idle,
  switcher,
}: {
  /** E97: the screen switcher, when the link may switch. */
  switcher?: ReactNode;
  label: string;
  stages: MapStage[];
  now: number;
  stale: boolean;
  errorText: string | null;
  idle: boolean;
}) {
  useOpsFonts();
  const tiles = useMemo(() => stageTiles(stages, null), [stages]);
  const lead = pipelineLead(stages);
  return (
    <main className={`ops-board ${idle ? 'ops-idle' : ''}`} data-board-state="live" data-screen="pipeline">
      <OpsTopBar switcher={switcher} label={label} stale={stale} errorText={errorText} now={now} />
      {tiles.length === 0 ? (
        <p className="ops-message">The pipeline figures are not available yet.</p>
      ) : (
        <>
          {lead && <p className="ops-lead" data-pipeline-lead>{lead}</p>}
          <StageStrip tiles={tiles} layout="grid" />
        </>
      )}
    </main>
  );
}
