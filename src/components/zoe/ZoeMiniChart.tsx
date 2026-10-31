import React from 'react';
import { BarChart3, TrendingUp } from 'lucide-react';

export interface ZoeChartPoint {
  label: string;
  value: number;
  formatted?: string;
}

export interface ZoeChartData {
  type: 'bar' | 'line';
  title: string;
  summary: string;
  xKey: string;
  yKey: string;
  isUgx: boolean;
  data: ZoeChartPoint[];
}

export function extractZoeChartFromMessage(
  reportPayload?: Record<string, unknown> | null,
): ZoeChartData | null {
  if (!reportPayload || typeof reportPayload !== 'object') return null;
  const rawChart = reportPayload.chart;
  if (rawChart && typeof rawChart === 'object' && !Array.isArray(rawChart)) {
    const c = rawChart as Record<string, unknown>;
    if (
      (c.type === 'bar' || c.type === 'line') &&
      typeof c.title === 'string' &&
      typeof c.summary === 'string' &&
      Array.isArray(c.data) &&
      c.data.length >= 2
    ) {
      return {
        type: c.type,
        title: c.title,
        summary: c.summary,
        xKey: typeof c.xKey === 'string' ? c.xKey : 'label',
        yKey: typeof c.yKey === 'string' ? c.yKey : 'value',
        isUgx: Boolean(c.isUgx),
        data: c.data
          .filter((p) => p && typeof p === 'object')
          .map((p) => {
            const pt = p as Record<string, unknown>;
            return {
              label: String(pt.label ?? ''),
              value: Number(pt.value ?? 0),
              formatted: typeof pt.formatted === 'string' ? pt.formatted : undefined,
            };
          }),
      };
    }
  }
  return null;
}

function formatChartValue(point: ZoeChartPoint, isUgx: boolean): string {
  if (point.formatted) return point.formatted;
  if (isUgx) {
    return `UGX ${Math.round(point.value).toLocaleString('en-US')}`;
  }
  return Math.round(point.value).toLocaleString('en-US');
}

export const ZoeMiniChart: React.FC<{ chart: ZoeChartData }> = ({ chart }) => {
  if (!chart.data || chart.data.length < 2) return null;

  const maxVal = Math.max(...chart.data.map((d) => Math.abs(d.value)), 1);

  return (
    <div
      data-testid="zoe-mini-chart"
      className="my-2 max-w-md rounded-lg border border-border/80 bg-muted/20 p-2.5 space-y-2"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          {chart.type === 'line' ? (
            <TrendingUp className="h-3.5 w-3.5 text-primary shrink-0" aria-hidden="true" />
          ) : (
            <BarChart3 className="h-3.5 w-3.5 text-primary shrink-0" aria-hidden="true" />
          )}
          <span className="truncate text-xs font-semibold text-foreground">
            {chart.title}
          </span>
        </div>
        <span className="rounded bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
          {chart.type === 'line' ? 'Time series' : 'Ranking'}
        </span>
      </div>

      {/* One-line written summary */}
      <p
        data-testid="zoe-mini-chart-summary"
        className="text-xs leading-relaxed text-muted-foreground"
      >
        {chart.summary}
      </p>

      {chart.type === 'line' ? (
        <div className="space-y-1.5">
          <svg
            viewBox="0 0 300 68"
            className="h-14 w-full overflow-visible"
            role="img"
            aria-label={chart.title}
          >
            {(() => {
              const pts = chart.data.map((pt, idx) => {
                const x =
                  chart.data.length === 1
                    ? 150
                    : 12 + (idx / (chart.data.length - 1)) * 276;
                const y = 58 - (Math.max(pt.value, 0) / maxVal) * 44;
                return { x, y, pt };
              });
              const polyPoints = pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
              return (
                <>
                  <polyline
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    className="text-primary"
                    points={polyPoints}
                  />
                  {pts.map((p, idx) => (
                    <circle
                      key={idx}
                      cx={p.x}
                      cy={p.y}
                      r="3"
                      className="fill-primary"
                    />
                  ))}
                </>
              );
            })()}
          </svg>
          <div className="grid grid-cols-2 gap-1 sm:grid-cols-3">
            {chart.data.slice(0, 6).map((pt, idx) => (
              <div
                key={idx}
                className="flex items-center justify-between gap-1 rounded border border-border/60 bg-background/80 px-2 py-1 text-xs"
              >
                <span className="truncate text-muted-foreground">{pt.label}</span>
                <span className="font-semibold text-foreground shrink-0">
                  {formatChartValue(pt, chart.isUgx)}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="space-y-1.5">
          {chart.data.slice(0, 6).map((pt, idx) => {
            const pct = Math.max(4, Math.min(100, Math.round((Math.abs(pt.value) / maxVal) * 100)));
            return (
              <div key={idx} className="space-y-1">
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="truncate font-medium text-foreground">{pt.label}</span>
                  <span className="shrink-0 font-mono text-xs text-muted-foreground">
                    {formatChartValue(pt, chart.isUgx)}
                  </span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary transition-all"
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default ZoeMiniChart;
