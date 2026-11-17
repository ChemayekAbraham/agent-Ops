import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { MAP, STAGES_RAW } from '@/lib/boardMap.fixtures';
import { readBoardMap, readStages } from '@/lib/boardMap';

/** The boardroom's PIPELINE and OPS MAP screens are light by default; ?theme=dark brings back the dark look. */

const h = vi.hoisted(() => ({ mapProps: [] as Record<string, unknown>[] }));
// The map itself needs Google; what the screen hands it is what matters here.
vi.mock('@/pages/board/OpsMap', () => ({
  OpsMap: (p: Record<string, unknown>) => {
    h.mapProps.push(p);
    return <div data-ops-map-stub={String(p.theme)} />;
  },
}));

import { PipelineScreen } from '@/pages/board/PipelineScreen';
import { OpsMapScreen } from '@/pages/board/OpsMapScreen';
import { LIGHT, LIGHT_MAP_STYLE, MAP_COLORS, contrast, readOpsTheme } from '@/pages/board/opsTheme';

const map = readBoardMap(MAP, STAGES_RAW)!;
const stages = readStages(STAGES_RAW);
const NOW = Date.parse('2026-11-16T09:00:00Z');
const setUrl = (search: string) => window.history.replaceState(null, '', `/board/abc${search}`);
afterEach(() => {
  setUrl('');
  h.mapProps = [];
});

describe('light by default', () => {
  it('the pipeline screen renders with the light tokens', () => {
    setUrl('');
    const { container } = render(<PipelineScreen label="Boardroom" stages={stages} now={NOW} stale={false} errorText={null} idle={false} />);
    const main = container.querySelector('main.ops-board') as HTMLElement;
    expect(main.classList.contains('ops-light')).toBe(true);
    expect(main.getAttribute('data-ops-theme')).toBe('light');
    // Every number and label stays.
    expect(container.querySelectorAll('.ops-stage').length).toBe(8);
  });

  it('the ops map screen renders light, and hands the map the light theme', () => {
    setUrl('');
    const { container } = render(<OpsMapScreen label="Boardroom" map={map} now={NOW} stale={false} errorText={null} idle={false} />);
    expect(container.querySelector('main.ops-board')?.classList.contains('ops-light')).toBe(true);
    expect(h.mapProps.at(-1)?.theme).toBe('light');
    expect(container.querySelectorAll('.ops-layer').length).toBeGreaterThan(0);
  });
});

describe('?theme=dark', () => {
  it('brings back the dark look on both screens', () => {
    expect(readOpsTheme('?theme=dark')).toBe('dark');
    expect(readOpsTheme('?theme=light')).toBe('light');
    expect(readOpsTheme('')).toBe('light');
    setUrl('?theme=dark');
    const a = render(<PipelineScreen label="Boardroom" stages={stages} now={NOW} stale={false} errorText={null} idle={false} />);
    expect(a.container.querySelector('main.ops-board')?.getAttribute('data-ops-theme')).toBe('dark');
    expect(a.container.querySelector('main.ops-board')?.classList.contains('ops-light')).toBe(false);
    a.unmount();
    const b = render(<OpsMapScreen label="Boardroom" map={map} now={NOW} stale={false} errorText={null} idle={false} />);
    expect(b.container.querySelector('main.ops-board')?.getAttribute('data-ops-theme')).toBe('dark');
    expect(h.mapProps.at(-1)?.theme).toBe('dark');
  });
});

describe('contrast', () => {
  it('every main text colour on its background is at least 4.5:1; the big numbers (ink) at least 7:1', () => {
    for (const bg of [LIGHT.panel, LIGHT.ground]) {
      for (const fg of [LIGHT.ink, LIGHT.muted, LIGHT.accent, LIGHT.green, LIGHT.amber, LIGHT.red, LIGHT.blue]) {
        expect(contrast(fg, bg), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
      expect(contrast(LIGHT.ink, bg), `big numbers on ${bg}`).toBeGreaterThanOrEqual(7);
    }
    // The active screen tab: white on Welile purple.
    expect(contrast('#FFFFFF', LIGHT.accent)).toBeGreaterThanOrEqual(4.5);
  });

  it('the stylesheet carries the same light tokens, and the big numbers are ink in light', () => {
    const css = readFileSync(resolve(__dirname, '../pages/board/opsBoard.css'), 'utf8');
    const block = css.slice(css.indexOf('.ops-board.ops-light {'));
    for (const v of [LIGHT.ground, LIGHT.panel, LIGHT.line, LIGHT.ink, LIGHT.muted, LIGHT.accent, LIGHT.green, LIGHT.amber, LIGHT.red, LIGHT.blue]) {
      expect(block).toContain(v);
    }
    expect(css).toContain('.ops-light .ops-kpi-value, .ops-light .ops-stage-value { color: var(--ink) !important; }');
  });
});

describe('the light map', () => {
  it('white land, light grey roads, pale blue water; markers in the status colours with a white outline', () => {
    const style = (t: string) => LIGHT_MAP_STYLE.find((s) => s.featureType === t && s.elementType === 'geometry')?.stylers?.[0];
    expect(style('landscape')).toEqual({ color: '#FFFFFF' });
    expect(style('water')).toEqual({ color: '#CFE3F5' });
    expect(style('road')).toEqual({ color: '#E6E5EE' });
    expect(MAP_COLORS.light).toEqual(
      expect.objectContaining({ sold: LIGHT.green, selected: LIGHT.amber, desks: LIGHT.blue, arrears: LIGHT.red, onBoard: LIGHT.accent, outline: '#FFFFFF' }),
    );
  });
});
