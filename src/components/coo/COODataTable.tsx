import { useState, useMemo } from 'react';
import { Download, ChevronLeft, ChevronRight, ChevronUp, ChevronDown, ChevronsUpDown, Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  Drawer, DrawerContent, DrawerHeader, DrawerTitle
} from '@/components/ui/drawer';

export interface COOColumn<T = any> {
  key: string;
  label: string;
  render?: (row: T) => React.ReactNode;
  align?: 'left' | 'right' | 'center';
  /** If true, this column is only shown in the detail drawer, not in the main table */
  detailOnly?: boolean;
  /** Disable sorting for this column */
  sortable?: boolean;
}

interface COODataTableProps<T = any> {
  columns: COOColumn<T>[];
  data: T[];
  title: string;
  pageSize?: number;
  exportFilename?: string;
  detailColumns?: COOColumn<T>[];
}

function exportToCSV<T>(columns: COOColumn<T>[], data: T[], filename: string) {
  const exportCols = columns.filter(c => !c.detailOnly);
  const header = exportCols.map(c => c.label).join(',');
  const rows = data.map(row =>
    exportCols.map(c => {
      const val = (row as any)[c.key];
      const str = String(val ?? '').replace(/,/g, ' ').replace(/\n/g, ' ');
      return `"${str}"`;
    }).join(',')
  );
  const csv = [header, ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${filename}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

type SortDir = 'asc' | 'desc' | null;

export default function COODataTable<T>({ columns, data, title, pageSize = 15, exportFilename, detailColumns }: COODataTableProps<T>) {
  const [page, setPage] = useState(0);
  const [selectedRow, setSelectedRow] = useState<T | null>(null);
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>(null);
  const [search, setSearch] = useState('');

  const tableCols = columns.filter(c => !c.detailOnly);
  const allDetailCols = [...columns, ...(detailColumns || [])];

  // Filter
  const filtered = useMemo(() => {
    if (!search.trim()) return data;
    const q = search.toLowerCase();
    return data.filter(row =>
      tableCols.some(col => {
        const val = (row as any)[col.key];
        return val != null && String(val).toLowerCase().includes(q);
      })
    );
  }, [data, search, tableCols]);

  // Sort
  const sorted = useMemo(() => {
    if (!sortKey || !sortDir) return filtered;
    return [...filtered].sort((a, b) => {
      const av = (a as any)[sortKey];
      const bv = (b as any)[sortKey];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === 'number' && typeof bv === 'number') {
        return sortDir === 'asc' ? av - bv : bv - av;
      }
      const sa = String(av).toLowerCase();
      const sb = String(bv).toLowerCase();
      return sortDir === 'asc' ? sa.localeCompare(sb) : sb.localeCompare(sa);
    });
  }, [filtered, sortKey, sortDir]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const safePage = Math.min(page, totalPages - 1);
  const paged = sorted.slice(safePage * pageSize, (safePage + 1) * pageSize);

  function handleSort(key: string) {
    if (sortKey === key) {
      if (sortDir === 'asc') setSortDir('desc');
      else if (sortDir === 'desc') { setSortKey(null); setSortDir(null); }
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
    setPage(0);
  }

  function handleSearch(val: string) {
    setSearch(val);
    setPage(0);
  }

  function SortIcon({ colKey }: { colKey: string }) {
    if (sortKey !== colKey) return <ChevronsUpDown className="h-2.5 w-2.5 opacity-30" />;
    if (sortDir === 'asc') return <ChevronUp className="h-2.5 w-2.5 text-primary" />;
    return <ChevronDown className="h-2.5 w-2.5 text-primary" />;
  }

  return (
    <>
      <div className="space-y-2">
        {/* Header bar */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-xs sm:text-sm font-bold uppercase tracking-widest text-muted-foreground shrink-0">{title}</h3>
          <div className="flex items-center gap-1.5 sm:gap-2">
            {/* Search */}
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
              <input
                type="text"
                value={search}
                onChange={e => handleSearch(e.target.value)}
                placeholder="Search…"
                className="h-7 w-24 sm:w-36 rounded-md border border-border/60 bg-muted/30 pl-6 pr-6 text-xs placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/40 transition-colors"
              />
              {search && (
                <button onClick={() => handleSearch('')} className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-muted">
                  <X className="h-2.5 w-2.5 text-muted-foreground" />
                </button>
              )}
            </div>
            <button
              onClick={() => exportToCSV(columns, data, exportFilename || title.toLowerCase().replace(/\s+/g, '-'))}
              className="flex items-center gap-1 sm:gap-1.5 text-[11px] sm:text-xs font-semibold text-primary hover:text-primary/80 transition-colors px-2 sm:px-3 py-1.5 rounded-lg bg-primary/10 hover:bg-primary/15 active:scale-95 shrink-0"
            >
              <Download className="h-3 w-3 sm:h-3.5 sm:w-3.5" />
              Export
            </button>
          </div>
        </div>

        {/* Table */}
        <div className="rounded-xl border border-border/80 bg-card overflow-hidden shadow-sm">
          <div className="overflow-x-auto -webkit-overflow-scrolling-touch">
            <table className="w-full text-[11px] sm:text-[13px] min-w-[480px]">
              <thead>
                <tr className="border-b-2 border-border bg-muted/50">
                  <th className="px-1.5 sm:px-3 py-1.5 sm:py-2 text-[8px] sm:text-[9px] font-black uppercase tracking-[0.15em] text-muted-foreground text-center w-8 sm:w-10">#</th>
                  {tableCols.map(col => {
                    const isSortable = col.sortable !== false;
                    return (
                      <th
                        key={col.key}
                        onClick={() => isSortable && handleSort(col.key)}
                        className={cn(
                          'px-1.5 sm:px-3 py-1.5 sm:py-2 text-[8px] sm:text-[9px] font-black uppercase tracking-[0.15em] text-muted-foreground whitespace-nowrap border-l border-border/40 select-none',
                          col.align === 'right' ? 'text-right' : col.align === 'center' ? 'text-center' : 'text-left',
                          isSortable && 'cursor-pointer hover:text-foreground hover:bg-muted/60 transition-colors'
                        )}
                      >
                        <span className="inline-flex items-center gap-1">
                          {col.label}
                          {isSortable && <SortIcon colKey={col.key} />}
                        </span>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody className="divide-y divide-border/30">
                {paged.length === 0 ? (
                  <tr>
                    <td colSpan={tableCols.length + 1} className="px-3 py-10 text-center text-xs text-muted-foreground italic">
                      {search ? 'No matching records' : 'No records found'}
                    </td>
                  </tr>
                ) : (
                  paged.map((row, i) => {
                    const rowIndex = safePage * pageSize + i + 1;
                    return (
                      <tr
                        key={i}
                        onClick={() => setSelectedRow(row)}
                        className={cn(
                          'transition-colors cursor-pointer active:bg-primary/10',
                          i % 2 === 0 ? 'bg-card' : 'bg-muted/20',
                          'hover:bg-primary/[0.07]'
                        )}
                      >
                        <td className="px-1.5 sm:px-3 py-1.5 sm:py-2 text-[9px] sm:text-[10px] font-bold text-muted-foreground/60 text-center tabular-nums">{rowIndex}</td>
                        {tableCols.map(col => (
                          <td
                            key={col.key}
                            className={cn(
                              'px-1.5 sm:px-3 py-1.5 sm:py-2 tabular-nums border-l border-border/20 max-w-[120px] sm:max-w-none truncate',
                              col.align === 'right' ? 'text-right font-semibold' : col.align === 'center' ? 'text-center' : 'text-left',
                              col.align === 'right' && 'tracking-tight'
                            )}
                          >
                            {col.render ? col.render(row) : String((row as any)[col.key] ?? '—')}
                          </td>
                        ))}
                      </tr>
                    );
                  })
                )}
              </tbody>
              {paged.length > 0 && (
                <tfoot>
                  <tr className="border-t-2 border-border bg-muted/40">
                    <td className="px-1.5 sm:px-3 py-1 sm:py-1.5 text-[8px] sm:text-[9px] font-black text-muted-foreground" colSpan={tableCols.length + 1}>
                      {filtered.length === data.length
                        ? `${data.length} RECORD${data.length !== 1 ? 'S' : ''} TOTAL`
                        : `${filtered.length} OF ${data.length} RECORDS (FILTERED)`
                      }
                    </td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-between px-1.5 sm:px-3 py-1 sm:py-1.5 border-t border-border/60 bg-muted/30">
              <span className="text-[9px] sm:text-[10px] font-bold text-muted-foreground tabular-nums tracking-wide">
                {safePage * pageSize + 1}–{Math.min((safePage + 1) * pageSize, sorted.length)} OF {sorted.length}
              </span>
              <div className="flex items-center gap-0.5">
                <button
                  onClick={() => setPage(p => Math.max(0, p - 1))}
                  disabled={safePage === 0}
                  className="p-1 rounded hover:bg-muted disabled:opacity-20 active:scale-95 transition-colors"
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                </button>
                <span className="text-[10px] font-bold tabular-nums text-muted-foreground px-1.5">
                  {safePage + 1}/{totalPages}
                </span>
                <button
                  onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                  disabled={safePage >= totalPages - 1}
                  className="p-1 rounded hover:bg-muted disabled:opacity-20 active:scale-95 transition-colors"
                >
                  <ChevronRight className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Row Detail Drawer */}
      <Drawer open={!!selectedRow} onOpenChange={(open) => { if (!open) setSelectedRow(null); }}>
        <DrawerContent>
          <DrawerHeader>
            <DrawerTitle className="text-base font-black tracking-tight">Record Details</DrawerTitle>
          </DrawerHeader>
          {selectedRow && (
            <div className="p-4 pb-8 space-y-2 max-h-[60vh] overflow-y-auto">
              {allDetailCols.map(col => {
                const rawVal = (selectedRow as any)[col.key];
                const display = col.render ? col.render(selectedRow) : String(rawVal ?? '—');
                return (
                  <div key={col.key} className="flex items-start justify-between py-2.5 px-3 rounded-xl bg-muted/50 gap-4">
                    <span className="text-xs font-bold uppercase tracking-widest text-muted-foreground shrink-0">{col.label}</span>
                    <span className="text-sm font-semibold text-right">{display}</span>
                  </div>
                );
              })}
            </div>
          )}
        </DrawerContent>
      </Drawer>
    </>
  );
}
