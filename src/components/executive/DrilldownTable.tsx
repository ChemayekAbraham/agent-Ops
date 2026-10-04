import { useMemo, useState } from 'react';
import { ChevronUp, ChevronDown, ChevronsUpDown, ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface DrilldownColumn<T = any> {
  key: string;
  label: string;
  align?: 'left' | 'right' | 'center';
  sortable?: boolean;
  /** Value used for sorting; falls back to row[key] */
  sortValue?: (row: T) => string | number | null | undefined;
  render?: (row: T) => React.ReactNode;
}

interface DrilldownTableProps<T = any> {
  columns: DrilldownColumn<T>[];
  data: T[];
  pageSize?: number;
  rowKey?: (row: T, index: number) => string;
  emptyMessage?: string;
  /** When provided, rows become clickable and invoke this with the selected row */
  onRowClick?: (row: T) => void;
}

type SortDir = 'asc' | 'desc';

export function DrilldownTable<T>({
  columns,
  data,
  pageSize = 10,
  rowKey,
  emptyMessage = 'No records found',
  onRowClick,
}: DrilldownTableProps<T>) {
  const [page, setPage] = useState(0);
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  const sorted = useMemo(() => {
    if (!sortKey) return data;
    const col = columns.find(c => c.key === sortKey);
    if (!col) return data;
    const getVal = (row: T) =>
      col.sortValue ? col.sortValue(row) : (row as any)[col.key];
    return [...data].sort((a, b) => {
      const av = getVal(a);
      const bv = getVal(b);
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
  }, [data, columns, sortKey, sortDir]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const safePage = Math.min(page, totalPages - 1);
  const paged = sorted.slice(safePage * pageSize, (safePage + 1) * pageSize);

  function handleSort(key: string) {
    if (sortKey === key) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
    setPage(0);
  }

  function SortIcon({ colKey }: { colKey: string }) {
    if (sortKey !== colKey) return <ChevronsUpDown className="h-3 w-3 opacity-40" />;
    return sortDir === 'asc'
      ? <ChevronUp className="h-3 w-3 text-primary" />
      : <ChevronDown className="h-3 w-3 text-primary" />;
  }

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border bg-muted/50">
              {columns.map(col => {
                const isSortable = col.sortable !== false;
                return (
                  <th
                    key={col.key}
                    onClick={() => isSortable && handleSort(col.key)}
                    className={cn(
                      'px-3 py-2 font-semibold text-muted-foreground whitespace-nowrap select-none',
                      col.align === 'right' ? 'text-right' : col.align === 'center' ? 'text-center' : 'text-left',
                      isSortable && 'cursor-pointer hover:text-foreground transition-colors',
                    )}
                  >
                    <span
                      className={cn(
                        'inline-flex items-center gap-1',
                        col.align === 'right' && 'flex-row-reverse',
                      )}
                    >
                      {col.label}
                      {isSortable && <SortIcon colKey={col.key} />}
                    </span>
                  </th>
                );
              })}
              {onRowClick && <th className="w-8 px-2 py-2" aria-hidden />}
            </tr>
          </thead>
          <tbody>
            {paged.length === 0 ? (
              <tr>
                <td colSpan={columns.length + (onRowClick ? 1 : 0)} className="text-center py-6 text-muted-foreground">
                  {emptyMessage}
                </td>
              </tr>
            ) : (
              paged.map((row, i) => (
                <tr
                  key={rowKey ? rowKey(row, safePage * pageSize + i) : safePage * pageSize + i}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  className={cn(
                    'border-b border-border last:border-0 transition-colors',
                    onRowClick
                      ? 'cursor-pointer hover:bg-muted/40 active:bg-primary/10 touch-manipulation'
                      : 'hover:bg-muted/30',
                  )}
                >
                  {columns.map(col => (
                    <td
                      key={col.key}
                      className={cn(
                        'px-3 py-2 align-middle',
                        col.align === 'right' ? 'text-right' : col.align === 'center' ? 'text-center' : 'text-left',
                      )}
                    >
                      {col.render ? col.render(row) : String((row as any)[col.key] ?? '—')}
                    </td>
                  ))}
                  {onRowClick && (
                    <td className="w-8 px-2 py-2 text-right align-middle">
                      <ChevronRight className="h-4 w-4 text-muted-foreground/50 inline" />
                    </td>
                  )}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2">
          <span className="text-[11px] text-muted-foreground">
            Page {safePage + 1} of {totalPages} · {sorted.length} records
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setPage(p => Math.max(0, p - 1))}
              disabled={safePage === 0}
              className="flex items-center justify-center h-7 w-7 rounded-md border border-border bg-background disabled:opacity-40 hover:bg-muted transition-colors"
              aria-label="Previous page"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
              disabled={safePage >= totalPages - 1}
              className="flex items-center justify-center h-7 w-7 rounded-md border border-border bg-background disabled:opacity-40 hover:bg-muted transition-colors"
              aria-label="Next page"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default DrilldownTable;