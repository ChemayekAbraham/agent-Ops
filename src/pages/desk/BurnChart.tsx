import { useMemo } from 'react';
import { fmt } from './format';
import { shortDayOf, useBudgetBurn, weekdayOf, type BurnDay } from './deskBriefApi';
import { LABEL, PANEL, statusText } from './deskTheme';
import { Skeleton } from './Skeleton';

/**
 * The CFO's week, as bars of what was spent against the line of what was
 * budgeted.
 *
 * Drawn as plain SVG rather than a chart library: it is seven bars and one
 * line, and inline SVG inherits the desk's own colour tokens, so the chart
 * follows the light and dark themes without a second palette to keep in step.
 *
 * The budget line breaks wherever a day has no daily budget set, because
 * joining across that gap would draw a budget that was never agreed.
 */

const W = 700;
const H = 200;
const PAD_L = 8;
const PAD_R = 8;
const PAD_T = 16;
const PAD_B = 28;

type Pt = { x: number; y: number | null };

function useGeometry(days: BurnDay[]) {
  return useMemo(() => {
    const n = Math.max(1, days.length);
    const plotW = W - PAD_L - PAD_R;
    const plotH = H - PAD_T - PAD_B;
    const slot = plotW / n;
    const barW = Math.max(8, slot * 0.52);

    const peak = Math.max(
      1,
      ...days.map((d) => Math.max(Number(d.spent) || 0, Number(d.daily_budget) || 0)),
    );
    const y = (v: number) => PAD_T + plotH - (v / peak) * plotH;

    const bars = days.map((d, i) => {
      const spent = Number(d.spent) || 0;
      const top = y(spent);
      return {
        key: d.day,
        x: PAD_L + slot * i + (slot - barW) / 2,
        y: top,
        w: barW,
        h: Math.max(spent > 0 ? 2 : 0, PAD_T + plotH - top),
        label: shortDayOf(d.day),
        spent,
        budget: d.daily_budget === null || d.daily_budget === undefined ? null : Number(d.daily_budget),
        cx: PAD_L + slot * i + slot / 2,
      };
    });

    const points: Pt[] = bars.map((b) => ({ x: b.cx, y: b.budget === null ? null : y(b.budget) }));

    // Break the line at every gap: one path segment per run of set days.
    const segments: string[] = [];
    let run: Pt[] = [];
    for (const p of points) {
      if (p.y === null) {
        if (run.length > 1) segments.push(run.map((q, i) => `${i ? 'L' : 'M'}${q.x} ${q.y}`).join(' '));
        run = [];
      } else run.push(p);
    }
    if (run.length > 1) segments.push(run.map((q, i) => `${i ? 'L' : 'M'}${q.x} ${q.y}`).join(' '));

    return { bars, points, segments, baseline: PAD_T + plotH };
  }, [days]);
}

export function BurnChart({ board, enabled }: { board: boolean; enabled: boolean }) {
  const q = useBudgetBurn(enabled);
  const days = (q.data?.days ?? []) as BurnDay[];
  const geo = useGeometry(days);

  if (!enabled) return null;

  const noWeek = !q.isLoading && !q.error && !q.data?.week_start;
  const remaining = q.data?.remaining ?? null;
  const header = q.data?.lasts_the_week
    ? `UGX ${fmt('ugxfull', remaining)} left · lasts the week`
    : `UGX ${fmt('ugxfull', remaining)} left · runs out on ${weekdayOf(q.data?.runs_out_on)}`;

  return (
    <section className={`${PANEL} space-y-3 p-4 sm:p-5`} aria-label="Weekly float budget burn">
      <div className="space-y-1">
        <h2 className={`${board ? 'text-lg' : 'text-base'} font-semibold text-foreground`}>This week&rsquo;s float budget</h2>
        {q.isLoading && <Skeleton className="h-5 w-64" />}
        {q.error && <p className={`text-sm ${statusText.bad}`}>The burn chart could not load. The figures below still work.</p>}
        {noWeek && (
          <p className={`${board ? 'text-base' : 'text-sm'} ${statusText.warn}`}>
            {q.data?.message ?? 'No CFO weekly budget set for this week'}
          </p>
        )}
        {!q.isLoading && !q.error && q.data?.week_start && (
          <p className={`${board ? 'text-lg' : 'text-base'} font-medium text-foreground`}>{header}</p>
        )}
      </div>

      {!q.isLoading && !q.error && q.data?.week_start && days.length > 0 && (
        <>
          <svg
            viewBox={`0 0 ${W} ${H}`}
            className="h-auto w-full"
            role="img"
            aria-label={`Spending each day this week against the daily budget. ${header}.`}
          >
            <line
              x1={PAD_L}
              x2={W - PAD_R}
              y1={geo.baseline}
              y2={geo.baseline}
              stroke="hsl(var(--foreground) / 0.18)"
              strokeWidth="1"
            />

            {geo.bars.map((b) => (
              <g key={b.key}>
                <rect x={b.x} y={b.y} width={b.w} height={b.h} rx="4" fill="hsl(var(--primary) / 0.75)">
                  <title>{`${b.label}: spent UGX ${fmt('ugxfull', b.spent)}${
                    b.budget === null ? ', no daily budget set' : `, budget UGX ${fmt('ugxfull', b.budget)}`
                  }`}</title>
                </rect>
                <text
                  x={b.cx}
                  y={H - 9}
                  textAnchor="middle"
                  className="desk-chart-axis"
                  fill="hsl(var(--foreground) / 0.7)"
                  fontSize="13"
                >
                  {b.label}
                </text>
              </g>
            ))}

            {geo.segments.map((d, i) => (
              <path key={i} d={d} fill="none" stroke="hsl(var(--desk-warn))" strokeWidth="2" strokeDasharray="5 4" />
            ))}
            {geo.points.map((p, i) =>
              p.y === null ? null : (
                <circle key={i} cx={p.x} cy={p.y} r="3" fill="hsl(var(--desk-warn))" />
              ),
            )}
          </svg>

          <p className={LABEL}>
            <span className="inline-block h-2 w-3 rounded-sm align-middle" style={{ background: 'hsl(var(--primary) / 0.75)' }} aria-hidden />{' '}
            Spent each day ·{' '}
            <span
              className="inline-block h-0 w-3 align-middle"
              style={{ borderTop: '2px dashed hsl(var(--desk-warn))' }}
              aria-hidden
            />{' '}
            Daily budget (no line where none was set) · Week of{' '}
            {q.data.week_start} to {q.data.week_end}
          </p>
        </>
      )}
    </section>
  );
}
