import { useMemo, useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import { ChevronDown, Download } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { formatUGX } from '@/lib/rentCalculations';
import type { TppoZoneAReport } from '@/components/tenant-ops/tppo/tppoTypes';

interface MovementPeriod {
  period_index: number;
  period_start: string;
  period_end: string;
  still_counting: boolean;
  opening_arrears: number;
  accrued: number;
  cleared_by_payment: number;
  closing_arrears: number;
}

interface MovementPayload {
  periods: MovementPeriod[];
}

/** Kampala-local today as YYYY-MM-DD. */
function kampalaToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Kampala',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function toUtc(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function isoOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The Wednesday on or before `anchor` — the report week runs Wed → next Tue. */
function weekStartWednesday(anchor: string): string {
  const d = toUtc(anchor);
  const back = (d.getUTCDay() - 3 + 7) % 7; // 3 = Wednesday
  d.setUTCDate(d.getUTCDate() - back);
  return isoOf(d);
}

function sevenDays(anchor: string): string[] {
  const start = toUtc(weekStartWednesday(anchor));
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    return isoOf(d);
  });
}

function dayLabel(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    timeZone: 'UTC',
  }).format(toUtc(iso));
}

const money = (v: number | null | undefined) =>
  v === null || v === undefined ? '—' : formatUGX(v);

const pct = (v: number | null | undefined) =>
  v === null || v === undefined ? '—' : `${v.toFixed(1)}%`;

const signedPct = (v: number | null | undefined) => {
  if (v === null || v === undefined) return '—';
  const sign = v > 0 ? '+' : v < 0 ? '−' : '';
  return `${sign}${Math.abs(v).toFixed(1)}%`;
};

interface DayColumn {
  date: string;
  label: string;
  closed: boolean;
  hasData: boolean;
  collectedRate: number | null;
  arrearsAccumulated: number | null;
  arrearsCollected: number | null;
  arrearsClosing: number | null;
  repaymentRate: number | null;
  changeOnPriorDay: number | null;
}

export function WeeklyArrearsSheet({ anchor }: { anchor: string }) {
  const [open, setOpen] = useState(true);
  const today = kampalaToday();
  const days = useMemo(() => sevenDays(anchor), [anchor]);
  const weekStart = days[0];
  const weekEnd = days[6];

  const zoneQueries = useQueries({
    queries: days.map((date) => ({
      queryKey: ['tppo-report-zone-a', 'day', date],
      staleTime: 30_000,
      enabled: date <= today,
      queryFn: async (): Promise<TppoZoneAReport> => {
        const { data, error } = await supabase.rpc('tppo_get_report_zone_a', {
          p_granularity: 'day',
          p_anchor: date,
        });
        if (error) throw error;
        return (data ?? {}) as unknown as TppoZoneAReport;
      },
    })),
  });

  const movementQueries = useQueries({
    queries: days.map((date) => ({
      queryKey: ['tppo-arrears-movement', 'day', date],
      staleTime: 30_000,
      enabled: date <= today,
      queryFn: async (): Promise<MovementPayload> => {
        const { data, error } = await supabase.rpc('tppo_arrears_movement', {
          p_granularity: 'day',
          p_anchor: date,
        });
        if (error) throw error;
        return (data ?? {}) as unknown as MovementPayload;
      },
    })),
  });

  const loading =
    zoneQueries.some((q) => q.isLoading) || movementQueries.some((q) => q.isLoading);
  const errorMessage =
    (zoneQueries.find((q) => q.error)?.error as Error | undefined)?.message ??
    (movementQueries.find((q) => q.error)?.error as Error | undefined)?.message ??
    null;

  const columns: DayColumn[] = useMemo(() => {
    const rows: DayColumn[] = days.map((date, i) => {
      const zone = zoneQueries[i]?.data ?? null;
      const movement = movementQueries[i]?.data ?? null;
      const period =
        movement?.periods?.find((p) => p.period_index === 2) ??
        movement?.periods?.[(movement?.periods?.length ?? 1) - 1] ??
        null;

      const hasData = Boolean(period) && date <= today;
      // Arrears accumulated by the close of the day: what was already owed at the
      // start plus what this day's schedules fell due — before anything was paid.
      const accumulated = period ? period.opening_arrears + period.accrued : null;
      const collected = period ? period.cleared_by_payment : null;
      const closing =
        accumulated === null || collected === null ? null : accumulated - collected;

      return {
        date,
        label: dayLabel(date),
        closed: date < today,
        hasData,
        collectedRate: zone?.collection_rate_pct ?? null,
        arrearsAccumulated: accumulated,
        arrearsCollected: collected,
        arrearsClosing: closing,
        repaymentRate:
          accumulated && accumulated > 0 && collected !== null
            ? (collected / accumulated) * 100
            : null,
        changeOnPriorDay: null,
      };
    });

    for (let i = 1; i < rows.length; i += 1) {
      const from = rows[i - 1].arrearsClosing;
      const to = rows[i].arrearsClosing;
      rows[i].changeOnPriorDay =
        from && from !== 0 && to !== null ? ((to - from) / Math.abs(from)) * 100 : null;
    }
    return rows;
  }, [days, zoneQueries, movementQueries, today]);

  const bodyRows = [
    {
      label: 'Rent collected at close',
      values: columns.map((c) => (c.hasData ? pct(c.collectedRate) : '—')),
    },
    {
      label: 'Arrears accumulated by close',
      values: columns.map((c) => (c.hasData ? money(c.arrearsAccumulated) : '—')),
    },
    {
      label: 'Arrears collected that day',
      values: columns.map((c) => (c.hasData ? money(c.arrearsCollected) : '—')),
    },
    {
      label: 'Actual arrears at close',
      values: columns.map((c) => (c.hasData ? money(c.arrearsClosing) : '—')),
    },
  ];

  const varianceRows = [
    {
      label: 'Arrears repaid, share of what was owed',
      values: columns.map((c) => (c.hasData ? pct(c.repaymentRate) : '—')),
    },
    {
      label: 'Arrears change on the day before',
      values: columns.map((c) => (c.hasData ? signedPct(c.changeOnPriorDay) : '—')),
    },
  ];

  const [exporting, setExporting] = useState(false);

  const downloadPdf = async () => {
    setExporting(true);
    try {
      const { default: jsPDF } = await import('jspdf');
      const autoTableMod: any = await import('jspdf-autotable');
      const autoTable = autoTableMod.default || autoTableMod;

      const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'landscape' });
      const margin = 10;
      doc.setFontSize(14);
      doc.setTextColor(108, 33, 196);
      doc.text('Weekly collections and arrears', margin, 14);
      doc.setFontSize(9);
      doc.setTextColor(100, 116, 139);
      doc.text(
        `${dayLabel(weekStart)} to ${dayLabel(weekEnd)} · Africa/Kampala · self-updating at each day close`,
        margin,
        19,
      );

      autoTable(doc, {
        startY: 25,
        margin: { left: margin, right: margin },
        head: [['', ...columns.map((c) => c.label)]],
        body: bodyRows.map((r) => [r.label, ...r.values]),
        styles: { fontSize: 8, cellPadding: 1.6 },
        headStyles: { fillColor: [108, 33, 196], textColor: 255, fontSize: 8 },
        columnStyles: { 0: { fontStyle: 'bold', cellWidth: 55 } },
      });

      const afterFirst = (doc as any).lastAutoTable?.finalY ?? 60;
      doc.setFontSize(11);
      doc.setTextColor(30, 41, 59);
      doc.text('Arrears repayment behaviour', margin, afterFirst + 10);

      autoTable(doc, {
        startY: afterFirst + 14,
        margin: { left: margin, right: margin },
        head: [['', ...columns.map((c) => c.label)]],
        body: varianceRows.map((r) => [r.label, ...r.values]),
        styles: { fontSize: 8, cellPadding: 1.6 },
        headStyles: { fillColor: [71, 85, 105], textColor: 255, fontSize: 8 },
        columnStyles: { 0: { fontStyle: 'bold', cellWidth: 55 } },
      });

      doc.save(`Welile_Weekly_Arrears_${weekStart}_to_${weekEnd}.pdf`);
    } finally {
      setExporting(false);
    }
  };

  return (
    <section
      aria-label="Weekly collections and arrears"
      className="rounded-xl border border-border bg-card p-4 shadow-sm"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex min-h-11 flex-1 items-start justify-between gap-3 text-left"
        >
          <span className="min-w-0">
            <span className="block text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Weekly collections and arrears
            </span>
            <span className="mt-1 block text-[11px] text-muted-foreground">
              {dayLabel(weekStart)} to {dayLabel(weekEnd)} · updates at each day close
            </span>
          </span>
          <ChevronDown
            className={`mt-1 h-4 w-4 shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`}
            aria-hidden="true"
          />
        </button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={downloadPdf}
          disabled={loading || exporting}
          className="min-h-11 shrink-0 gap-1.5 sm:min-h-9"
        >
          <Download className="h-4 w-4" aria-hidden="true" />
          {exporting ? 'Preparing…' : 'Download PDF'}
        </Button>
      </div>

      {open && (
        <div className="mt-4">
          {errorMessage ? (
            <p className="text-sm text-destructive">{errorMessage}</p>
          ) : loading ? (
            <p className="text-sm text-muted-foreground">Loading the week…</p>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[46rem] text-sm">
                  <thead>
                    <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                      <th scope="col" className="py-2 pr-3 text-left font-medium">
                        Measure
                      </th>
                      {columns.map((c) => (
                        <th
                          key={c.date}
                          scope="col"
                          className={`py-2 pr-3 text-right font-medium ${c.date === today ? 'text-primary' : ''}`}
                        >
                          {c.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {bodyRows.map((row) => (
                      <tr key={row.label} className="border-b border-border/60">
                        <td className="py-2 pr-3 font-medium text-foreground">{row.label}</td>
                        {row.values.map((v, i) => (
                          <td
                            key={columns[i].date}
                            className={`py-2 pr-3 text-right tabular-nums font-mono ${columns[i].date === today ? 'bg-primary/5' : ''}`}
                          >
                            {v}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="mt-5 rounded-md border border-border p-3">
                <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Arrears repayment behaviour
                </h4>
                <div className="mt-2 overflow-x-auto">
                  <table className="w-full min-w-[46rem] text-sm">
                    <thead>
                      <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                        <th scope="col" className="py-2 pr-3 text-left font-medium">
                          Measure
                        </th>
                        {columns.map((c) => (
                          <th key={c.date} scope="col" className="py-2 pr-3 text-right font-medium">
                            {c.label}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {varianceRows.map((row) => (
                        <tr key={row.label} className="border-b border-border/60">
                          <td className="py-2 pr-3 font-medium text-foreground">{row.label}</td>
                          {row.values.map((v, i) => (
                            <td
                              key={columns[i].date}
                              className="py-2 pr-3 text-right tabular-nums font-mono"
                            >
                              {v}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <p className="mt-3 text-[11px] text-muted-foreground">
                Each day column closes on its own figures. Arrears accumulated by close is what was
                already owed at the start of the day plus what fell due that day; the arrears
                collected that day is taken off it to give the actual arrears at close, which becomes
                the next day&apos;s opening balance. Days that have not happened yet show a dash and
                fill in as each day closes, so the week is complete and printable on the following
                Wednesday.
              </p>
            </>
          )}
        </div>
      )}
    </section>
  );
}

export default WeeklyArrearsSheet;
