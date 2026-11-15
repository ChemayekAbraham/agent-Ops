import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ReferenceLine } from 'recharts';
import { rpc } from '../reviewApi';
import { FOCUS, LABEL } from '../deskTheme';
import { isMissingDbObject } from '../deskLive';
import { stackLayout } from '../ui';

/**
 * Change markers (E110): releases, rule changes and switches, from
 * `change_markers(p_days)` (or a card's own `markers`). One shared look:
 * vertical lines on a daily chart, coloured by kind, with the labels on hover
 * or tap; and the same marks as a strip beside cards that are not charts.
 *
 * Colours (dataviz slots 7, 6, 5; validated light and dark): release violet,
 * rule green, switch magenta. Light magenta is under 3:1 on the surface, so a
 * mark always comes with its kind in words.
 */

export type MarkerKind = 'release' | 'rule' | 'switch';
export type Marker = { at: string | null; day: string; kind: string; label: string; ref?: string | null };
export const MARKER_KINDS: MarkerKind[] = ['release', 'rule', 'switch'];
export const MARKER_WORDS: Record<MarkerKind, string> = { release: 'Release', rule: 'Rule change', switch: 'Switch' };
/** "release:publish" and "release:commit" are both releases. */
export const markerKind = (k: string): MarkerKind => {
  const base = String(k ?? '').split(':')[0] as MarkerKind;
  return MARKER_KINDS.includes(base) ? base : 'rule';
};
export const MARKER_CSS = `.change-markers{--mk-release:#6250d6;--mk-rule:#008300;--mk-switch:#e87ba4}
.dark .change-markers{--mk-release:#9085e9;--mk-rule:#0ca30c;--mk-switch:#d55181}`;
export const markerColor = (k: MarkerKind) => `var(--mk-${k})`;

export function readMarkers(v: unknown): Marker[] {
  return (Array.isArray(v) ? v : [])
    .map((x: Record<string, unknown>) => ({
      at: x.at ? String(x.at) : null,
      day: String(x.day ?? x.at ?? '').slice(0, 10),
      kind: String(x.kind ?? 'rule'),
      label: String(x.label ?? ''),
      ref: x.ref ? String(x.ref) : null,
    }))
    .filter((m) => /^\d{4}-\d{2}-\d{2}$/.test(m.day));
}

/** One mark per day: its markers, and the kind that colours it (release, then switch, then rule). */
export type DayMarks = { day: string; kind: MarkerKind; markers: Marker[] };
const RANK: Record<MarkerKind, number> = { release: 0, switch: 1, rule: 2 };
export function marksByDay(markers: Marker[]): DayMarks[] {
  const by = new Map<string, Marker[]>();
  for (const m of markers) by.set(m.day, [...(by.get(m.day) ?? []), m]);
  return Array.from(by.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, ms]) => ({ day, markers: ms, kind: ms.map((m) => markerKind(m.kind)).sort((a, b) => RANK[a] - RANK[b])[0] }));
}
export const markText = (m: Marker) => `${MARKER_WORDS[markerKind(m.kind)]}: ${m.label}`;

export function useChangeMarkers(days = 30) {
  return useQuery({
    queryKey: ['desk-feed', 'change-markers', days],
    queryFn: async () => {
      const { data, error } = await rpc('change_markers', { p_days: days });
      if (error) throw error;
      return readMarkers(data);
    },
    staleTime: 5 * 60_000,
    retry: (n, e) => !isMissingDbObject(e) && (e as { code?: string })?.code !== '42501' && n < 1,
  });
}
/** The markers, or [] while loading, missing on the server (PGRST202) or refused: the cards never wait or fail for them. */
export function useChangeMarkerList(days = 30): Marker[] {
  const q = useChangeMarkers(days);
  return q.data ?? [];
}

/** The kinds in words, beside their colours. */
export function MarkerLegend() {
  return (
    <span className="change-markers flex flex-wrap items-center gap-3" aria-label="Change markers">
      <style>{MARKER_CSS}</style>
      {MARKER_KINDS.map((k) => (
        <span key={k} className="flex items-center gap-1 text-xs text-muted-foreground">
          <span aria-hidden style={{ width: 2, height: 12, background: markerColor(k), display: 'inline-block' }} />
          {MARKER_WORDS[k]}
        </span>
      ))}
    </span>
  );
}

/**
 * The lines for a recharts chart whose x values are `xFor(day)`. Returned as
 * an array of <ReferenceLine> (recharts needs them as direct children). A
 * line's flag shows its labels on hover (<title>) and picks the day on tap.
 */
export function markerLines(marks: DayMarks[], xFor: (day: string) => string | null, onPick: (m: DayMarks) => void) {
  return marks
    .map((m) => ({ m, x: xFor(m.day) }))
    .filter((v): v is { m: DayMarks; x: string } => v.x !== null)
    .map(({ m, x }) => (
      <ReferenceLine
        key={`mk-${m.day}`}
        x={x}
        stroke={markerColor(m.kind)}
        strokeWidth={1.5}
        strokeDasharray="3 3"
        ifOverflow="extendDomain"
        label={(props: { viewBox?: { x?: number; y?: number } }) => {
          const vx = props.viewBox?.x ?? 0;
          const vy = props.viewBox?.y ?? 0;
          return (
            <g data-marker-day={m.day} data-marker-kind={m.kind} style={{ cursor: 'pointer' }} onClick={() => onPick(m)} role="button" aria-label={`${m.day}: ${m.markers.map(markText).join('; ')}`}>
              <title>{m.markers.map(markText).join('\n')}</title>
              {/* A hit area wider than the line, for a finger. */}
              <rect x={vx - 8} y={vy - 2} width={16} height={16} fill="transparent" />
              <circle cx={vx} cy={vy + 4} r={4} fill={markerColor(m.kind)} />
            </g>
          );
        }}
      />
    ));
}

/** What a tapped day changed, under the chart. */
export function PickedMarks({ picked, onClose }: { picked: DayMarks | null; onClose: () => void }) {
  if (!picked) return null;
  return (
    <div className="rounded-md border border-[var(--desk-line-color)] p-2" style={stackLayout(4)} data-picked-markers={picked.day}>
      <div className="flex items-center justify-between gap-2">
        <span className={LABEL}>{picked.day}</span>
        <button type="button" onClick={onClose} className={`text-xs text-muted-foreground underline underline-offset-4 ${FOCUS}`}>
          Close
        </button>
      </div>
      <ul style={{ ...stackLayout(2), margin: 0, padding: 0, listStyle: 'none' }}>
        {picked.markers.map((m, i) => (
          <li key={`${m.label}-${i}`} className="text-sm text-foreground" style={{ overflowWrap: 'anywhere' }}>
            {markText(m)}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The same marks beside a card that is not a chart (the demand alarm, the
 * arrears watch, a cohort month): the days in [from, to] that changed
 * something, each a coloured tick; a tap lists that day's changes.
 */
export function MarkerStrip({ markers, from, to, label = 'Changes' }: { markers: Marker[]; from: string; to: string; label?: string }) {
  const [picked, setPicked] = useState<DayMarks | null>(null);
  const marks = marksByDay(markers.filter((m) => m.day >= from && m.day <= to));
  if (marks.length === 0) return null;
  return (
    <div className="change-markers" style={stackLayout(6)} data-marker-strip={`${from}..${to}`}>
      <style>{MARKER_CSS}</style>
      <div className="flex flex-wrap items-center gap-2">
        {label && <span className={LABEL}>{label}</span>}
        {marks.map((m) => (
          <button
            key={m.day}
            type="button"
            onClick={() => setPicked(picked?.day === m.day ? null : m)}
            title={m.markers.map(markText).join('\n')}
            aria-label={`${m.day}: ${m.markers.map(markText).join('; ')}`}
            aria-pressed={picked?.day === m.day}
            className={`flex items-center gap-1 rounded px-1 text-xs text-muted-foreground ${FOCUS}`}
            data-strip-day={m.day}
            data-marker-kind={m.kind}
          >
            <span aria-hidden style={{ width: 2, height: 12, background: markerColor(m.kind), display: 'inline-block' }} />
            {m.day.slice(5)}
            {m.markers.length > 1 ? ` ×${m.markers.length}` : ''}
          </button>
        ))}
      </div>
      <PickedMarks picked={picked} onClose={() => setPicked(null)} />
    </div>
  );
}

/** "YYYY-MM-DD", n days before `day`. */
export function daysBefore(day: string, n: number): string {
  const d = new Date(`${day.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}
/** The last day of the month that starts on `monthStart`. */
export function monthEnd(monthStart: string): string {
  const d = new Date(`${monthStart.slice(0, 10)}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1, 0);
  return d.toISOString().slice(0, 10);
}
