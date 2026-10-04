import { useMemo, useState } from 'react';
import { formatUGX } from '@/lib/rentCalculations';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { ArrowUp, ArrowDown, ArrowUpDown, BarChart3, Download } from 'lucide-react';

export type BreakdownSourceRow = {
  id: string;
  amount: number;
  created_at: string;
  agent_id: string | null;
  tenant_id: string | null;
  payment_method: string | null;
  rent_request_id: string | null;
  momo_provider: string | null;
};

type Dim = 'tenant' | 'agent' | 'method' | 'provider' | 'hour' | 'day' | 'rent_request';

const DIMS: { key: Dim; label: string; hint: string }[] = [
  { key: 'tenant', label: 'Per tenant', hint: 'Group by tenant_id' },
  { key: 'agent', label: 'Per agent', hint: 'Group by agent_id' },
  { key: 'method', label: 'Per payment method', hint: 'MoMo, cash, bank, wallet…' },
  { key: 'provider', label: 'Per MoMo provider', hint: 'MTN vs Airtel etc.' },
  { key: 'hour', label: 'Per hour of day (EAT)', hint: '00–23 Africa/Kampala' },
  { key: 'day', label: 'Per calendar day (EAT)', hint: 'YYYY-MM-DD' },
  { key: 'rent_request', label: 'Per rent request', hint: 'One repayment component per plan' },
];

type SortKey = 'label' | 'count' | 'total' | 'avg' | 'min' | 'max' | 'first' | 'last' | 'share';

function keyFor(dim: Dim, r: BreakdownSourceRow): string {
  if (dim === 'tenant') return r.tenant_id || '__none__';
  if (dim === 'agent') return r.agent_id || '__none__';
  if (dim === 'method') return (r.payment_method || 'unknown').toLowerCase();
  if (dim === 'provider') return (r.momo_provider || 'n/a').toLowerCase();
  if (dim === 'rent_request') return r.rent_request_id || '__none__';
  if (dim === 'hour') {
    return new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Kampala', hour: '2-digit', hour12: false }).format(new Date(r.created_at));
  }
  // day
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Kampala', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(r.created_at));
}

export function AmountBreakdownModal({
  open,
  onOpenChange,
  title,
  subtitle,
  rows,
  nameFor,
  initialDimension = 'tenant',
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  subtitle?: string;
  rows: BreakdownSourceRow[];
  /** Optional name resolver so tenant/agent IDs can be shown as human names. */
  nameFor?: (id: string) => string | null;
  initialDimension?: Dim;
}) {
  const [dim, setDim] = useState<Dim>(initialDimension);
  const [sortKey, setSortKey] = useState<SortKey>('total');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const grandTotal = useMemo(() => rows.reduce((s, r) => s + (Number(r.amount) || 0), 0), [rows]);

  const groups = useMemo(() => {
    const m = new Map<string, { count: number; total: number; min: number; max: number; first: number; last: number }>();
    for (const r of rows) {
      const k = keyFor(dim, r);
      const amt = Number(r.amount) || 0;
      const t = new Date(r.created_at).getTime();
      const cur = m.get(k);
      if (!cur) {
        m.set(k, { count: 1, total: amt, min: amt, max: amt, first: t, last: t });
      } else {
        cur.count += 1;
        cur.total += amt;
        if (amt < cur.min) cur.min = amt;
        if (amt > cur.max) cur.max = amt;
        if (t < cur.first) cur.first = t;
        if (t > cur.last) cur.last = t;
      }
    }
    return m;
  }, [rows, dim]);

  const labelFor = (k: string): string => {
    if (k === '__none__') return '(unassigned)';
    if (dim === 'tenant' || dim === 'agent') {
      const n = nameFor?.(k);
      return n || `${k.slice(0, 8)}…`;
    }
    if (dim === 'method' || dim === 'provider') return k.replace(/_/g, ' ');
    if (dim === 'hour') return `${k}:00`;
    if (dim === 'rent_request') return `${k.slice(0, 8)}…`;
    return k;
  };

  const table = useMemo(() => {
    const arr = Array.from(groups.entries()).map(([k, g]) => ({
      key: k,
      label: labelFor(k),
      count: g.count,
      total: g.total,
      avg: g.count > 0 ? g.total / g.count : 0,
      min: g.min,
      max: g.max,
      first: g.first,
      last: g.last,
      share: grandTotal > 0 ? g.total / grandTotal : 0,
    }));
    const dir = sortDir === 'asc' ? 1 : -1;
    arr.sort((a, b) => {
      const av = a[sortKey] as string | number;
      const bv = b[sortKey] as string | number;
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
    return arr;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups, sortKey, sortDir, grandTotal, dim]);

  const toggleSort = (k: SortKey) => {
    if (sortKey === k) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(k); setSortDir(k === 'label' ? 'asc' : 'desc'); }
  };
  const SortIcon = ({ k }: { k: SortKey }) => {
    if (sortKey !== k) return <ArrowUpDown className="h-3 w-3 opacity-40" />;
    return sortDir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />;
  };

  const fmtWhen = (ms: number) =>
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Kampala', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(ms));

  const csvEscape = (v: unknown) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const downloadCsv = () => {
    const header = ['Group', 'Key', 'Rows', 'Total UGX', 'Share %', 'Avg UGX', 'Min UGX', 'Max UGX', 'First (EAT)', 'Last (EAT)'];
    const body = table.map((r) => [r.label, r.key, r.count, Math.round(r.total), (r.share * 100).toFixed(2), Math.round(r.avg), Math.round(r.min), Math.round(r.max), fmtWhen(r.first), fmtWhen(r.last)]);
    const csv = [header, ...body].map((r) => r.map(csvEscape).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `breakdown_${dim}_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl w-[95vw] max-h-[90vh] overflow-hidden flex flex-col p-0">
        <DialogHeader className="p-4 pb-2 border-b border-border">
          <DialogTitle className="text-base inline-flex items-center gap-2">
            <BarChart3 className="h-4 w-4" /> {title}
          </DialogTitle>
          <DialogDescription className="text-[11px]">
            {subtitle || `Breaks ${formatUGX(grandTotal)} across ${rows.length.toLocaleString()} record${rows.length === 1 ? '' : 's'} into constituent sub-amounts.`}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-1.5 px-4 py-2 border-b border-border bg-muted/30">
          <span className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground mr-1">Group by:</span>
          {DIMS.map((d) => (
            <button
              key={d.key}
              type="button"
              onClick={() => setDim(d.key)}
              title={d.hint}
              className={`h-6 px-2 rounded-md text-[10px] font-semibold border transition-colors ${dim === d.key ? 'bg-primary text-primary-foreground border-primary' : 'bg-background text-foreground border-border hover:bg-muted'}`}
            >
              {d.label}
            </button>
          ))}
          <div className="ml-auto flex items-center gap-1.5">
            <span className="text-[10px] text-muted-foreground">{table.length.toLocaleString()} group{table.length === 1 ? '' : 's'}</span>
            <button
              type="button"
              onClick={downloadCsv}
              disabled={table.length === 0}
              className="h-6 px-2 rounded-md text-[10px] font-semibold inline-flex items-center gap-1 bg-background border border-border hover:bg-muted disabled:opacity-40"
            >
              <Download className="h-3 w-3" /> CSV
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-auto">
          {table.length === 0 ? (
            <p className="p-6 text-center text-[11px] text-muted-foreground">No records to break down.</p>
          ) : (
            <table className="w-full text-[11px]">
              <thead className="sticky top-0 bg-muted text-muted-foreground z-10">
                <tr>
                  {([
                    { k: 'label' as const, label: 'Group', align: 'left' },
                    { k: 'count' as const, label: 'Rows', align: 'right' },
                    { k: 'total' as const, label: 'Total', align: 'right' },
                    { k: 'share' as const, label: 'Share', align: 'right' },
                    { k: 'avg' as const, label: 'Avg', align: 'right' },
                    { k: 'min' as const, label: 'Min', align: 'right', hide: true },
                    { k: 'max' as const, label: 'Max', align: 'right', hide: true },
                    { k: 'first' as const, label: 'First', align: 'left', hide: true },
                    { k: 'last' as const, label: 'Last', align: 'left' },
                  ]).map((h) => (
                    <th
                      key={h.k}
                      className={`${h.align === 'right' ? 'text-right' : 'text-left'} font-bold uppercase tracking-wide px-2 py-1.5 text-[9px] ${h.hide ? 'hidden md:table-cell' : ''}`}
                    >
                      <button
                        type="button"
                        onClick={() => toggleSort(h.k)}
                        className="inline-flex items-center gap-1 hover:text-foreground transition-colors"
                      >
                        {h.label} <SortIcon k={h.k} />
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {table.map((r) => (
                  <tr key={r.key} className="hover:bg-primary/5">
                    <td className="px-2 py-1.5 truncate max-w-[16rem]" title={r.key}>
                      <span className="font-semibold text-foreground">{r.label}</span>
                      {(dim === 'tenant' || dim === 'agent' || dim === 'rent_request') && r.key !== '__none__' && (
                        <span className="ml-1 text-[9px] font-mono text-muted-foreground">{r.key.slice(0, 8)}</span>
                      )}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{r.count.toLocaleString()}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums font-bold text-primary">{formatUGX(r.total)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">
                      <div className="inline-flex items-center gap-1 justify-end">
                        <div className="h-1 w-10 rounded-full bg-muted overflow-hidden">
                          <div className="h-full bg-primary" style={{ width: `${Math.min(100, r.share * 100)}%` }} />
                        </div>
                        <span className="text-[10px] text-muted-foreground min-w-[2.5rem] text-right">{(r.share * 100).toFixed(1)}%</span>
                      </div>
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{formatUGX(Math.round(r.avg))}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums hidden md:table-cell">{formatUGX(r.min)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums hidden md:table-cell">{formatUGX(r.max)}</td>
                    <td className="px-2 py-1.5 tabular-nums text-muted-foreground whitespace-nowrap hidden md:table-cell">{fmtWhen(r.first)}</td>
                    <td className="px-2 py-1.5 tabular-nums text-muted-foreground whitespace-nowrap">{fmtWhen(r.last)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="sticky bottom-0 bg-muted/80 backdrop-blur border-t border-border">
                <tr>
                  <td className="px-2 py-1.5 text-[10px] font-bold uppercase tracking-wide">Total</td>
                  <td className="px-2 py-1.5 text-right tabular-nums font-bold">{rows.length.toLocaleString()}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums font-bold text-primary">{formatUGX(grandTotal)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums font-bold">100%</td>
                  <td className="px-2 py-1.5 text-right tabular-nums font-bold">{rows.length ? formatUGX(Math.round(grandTotal / rows.length)) : '—'}</td>
                  <td colSpan={4} className="hidden md:table-cell" />
                </tr>
              </tfoot>
            </table>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}