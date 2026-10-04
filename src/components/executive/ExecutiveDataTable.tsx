import { useState, useMemo, useEffect } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { ArrowUpDown, ArrowUp, ArrowDown, Download, FileText, Search, ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
// jsPDF loaded dynamically when needed

export interface Column<T> {
  key: keyof T & string;
  label: string;
  sortable?: boolean;
  render?: (value: T[keyof T], row: T) => React.ReactNode;
  className?: string;
}

interface FilterOption {
  key: string;
  label: string;
  options: { value: string; label: string }[];
}

interface ExecutiveDataTableProps<T> {
  data: T[];
  columns: Column<T>[];
  filters?: FilterOption[];
  title?: string;
  loading?: boolean;
  limit?: number;
  /** Stable id getter for selection. When provided, enables row checkboxes. */
  getRowId?: (row: T) => string;
  /** Currently selected row ids. */
  selectedIds?: string[];
  /** Called when selection changes. */
  onSelectionChange?: (ids: string[]) => void;
  /** Optional toolbar element rendered when at least one row is selected. */
  bulkActions?: (selectedIds: string[]) => React.ReactNode;
  /** Optional click handler — when set, rows become clickable. */
  onRowClick?: (row: T) => void;
  /** When provided, the search box is controlled by the parent and client-side
   *  text filtering is disabled (the parent is expected to search the backend). */
  searchValue?: string;
  onSearchChange?: (value: string) => void;
  /** Placeholder for the search input. */
  searchPlaceholder?: string;
  /** Shown next to the result count when a backend search is active. */
  searching?: boolean;
}

export function ExecutiveDataTable<T extends Record<string, any>>({
  data,
  columns,
  filters = [],
  title,
  loading,
  limit = 15,
  getRowId,
  selectedIds,
  onSelectionChange,
  bulkActions,
  onRowClick,
  searchValue,
  onSearchChange,
  searchPlaceholder,
  searching,
}: ExecutiveDataTableProps<T>) {
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [activeFilters, setActiveFilters] = useState<Record<string, string>>({});
  const [page, setPage] = useState(0);

  // When the parent controls search (backend search), skip the local text
  // filter so we don't double-filter already-matched rows.
  const serverSearch = typeof onSearchChange === 'function';
  const searchInputValue = serverSearch ? (searchValue ?? '') : search;
  // While a backend search is active, the query already returned the universal
  // result set — dropdown filters (e.g. template) must NOT narrow it further,
  // otherwise the search appears "based on templates".
  const serverSearchActive = serverSearch && searchInputValue.trim().length > 0;

  const selectionEnabled = !!getRowId && !!onSelectionChange;
  const selectedSet = useMemo(() => new Set(selectedIds || []), [selectedIds]);

  const allFiltered = useMemo(() => {
    let result = [...data];

    // Search across all string columns
    if (!serverSearch && search) {
      const q = search.toLowerCase();
      result = result.filter((row) =>
        columns.some((col) => {
          const v = row[col.key];
          return v != null && String(v).toLowerCase().includes(q);
        })
      );
    }

    // Apply dropdown filters
    if (!serverSearchActive) {
      for (const [key, val] of Object.entries(activeFilters)) {
        if (val && val !== 'all') {
          result = result.filter((row) => String(row[key]).toLowerCase() === val.toLowerCase());
        }
      }
    }

    // Sort
    if (sortKey) {
      result.sort((a, b) => {
        const va = a[sortKey];
        const vb = b[sortKey];
        if (va == null && vb == null) return 0;
        if (va == null) return 1;
        if (vb == null) return -1;
        if (typeof va === 'number' && typeof vb === 'number') return sortDir === 'asc' ? va - vb : vb - va;
        return sortDir === 'asc'
          ? String(va).localeCompare(String(vb))
          : String(vb).localeCompare(String(va));
      });
    }

    return result;
  }, [data, search, serverSearch, serverSearchActive, sortKey, sortDir, activeFilters, columns]);

  // Reset to first page whenever the filtered set changes shape.
  useEffect(() => {
    setPage(0);
  }, [search, searchValue, activeFilters, sortKey, sortDir, data.length]);

  const totalPages = Math.max(1, Math.ceil(allFiltered.length / limit));
  const safePage = Math.min(page, totalPages - 1);
  const pageStart = safePage * limit;
  const pageEnd = Math.min(pageStart + limit, allFiltered.length);
  const filtered = useMemo(
    () => allFiltered.slice(pageStart, pageEnd),
    [allFiltered, pageStart, pageEnd],
  );

  const visibleIds = useMemo(
    () => (selectionEnabled ? filtered.map((r) => getRowId!(r)) : []),
    [filtered, selectionEnabled, getRowId],
  );
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedSet.has(id));
  const someVisibleSelected = !allVisibleSelected && visibleIds.some((id) => selectedSet.has(id));

  const toggleAll = () => {
    if (!selectionEnabled) return;
    if (allVisibleSelected) {
      const remaining = (selectedIds || []).filter((id) => !visibleIds.includes(id));
      onSelectionChange!(remaining);
    } else {
      const merged = Array.from(new Set([...(selectedIds || []), ...visibleIds]));
      onSelectionChange!(merged);
    }
  };

  const toggleOne = (id: string) => {
    if (!selectionEnabled) return;
    const next = selectedSet.has(id)
      ? (selectedIds || []).filter((x) => x !== id)
      : [...(selectedIds || []), id];
    onSelectionChange!(next);
  };

  const handleSort = (key: string) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  };

  const exportCSV = () => {
    const header = columns.map((c) => c.label).join(',');
    const rows = allFiltered.map((row) => columns.map((c) => `"${String(row[c.key] ?? '')}"`).join(','));
    const csv = [header, ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${title || 'export'}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportPDF = async () => {
    const { default: jsPDF } = await import('jspdf');
    const doc = new jsPDF({ orientation: 'landscape' });
    doc.setFontSize(14);
    doc.text(title || 'Report', 14, 16);
    doc.setFontSize(8);
    const startY = 24;
    const colW = (doc.internal.pageSize.getWidth() - 28) / columns.length;

    // Header
    columns.forEach((col, i) => {
      doc.setFont('helvetica', 'bold');
      doc.text(col.label, 14 + i * colW, startY);
    });

    // Rows
    allFiltered.forEach((row, ri) => {
      const y = startY + 6 + ri * 5;
      if (y > doc.internal.pageSize.getHeight() - 10) return;
      doc.setFont('helvetica', 'normal');
      columns.forEach((col, ci) => {
        doc.text(String(row[col.key] ?? '').substring(0, 30), 14 + ci * colW, y);
      });
    });

    doc.save(`${title || 'report'}.pdf`);
  };

  return (
    <div className="space-y-3">
      {/* Bulk action bar */}
      {selectionEnabled && (selectedIds?.length || 0) > 0 && bulkActions && (
        <div className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-primary/5 border border-primary/20">
          <span className="text-sm font-medium text-foreground">
            {selectedIds!.length} selected
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="h-8"
              onClick={() => onSelectionChange!([])}
            >
              Clear
            </Button>
            {bulkActions(selectedIds!)}
          </div>
        </div>
      )}
      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row gap-2 items-stretch sm:items-center">
        <div className="relative flex-1 min-w-0">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder={searchPlaceholder || 'Search...'}
            value={searchInputValue}
            onChange={(e) => (serverSearch ? onSearchChange!(e.target.value) : setSearch(e.target.value))}
            className="pl-9 h-9"
          />
        </div>
        {filters.map((f) => (
          <Select
            key={f.key}
            value={serverSearchActive ? 'all' : (activeFilters[f.key] || 'all')}
            onValueChange={(v) => setActiveFilters((prev) => ({ ...prev, [f.key]: v }))}
            disabled={serverSearchActive}
          >
            <SelectTrigger className="w-full sm:w-[140px] h-9">
              <SelectValue placeholder={serverSearchActive ? `All ${f.label}` : f.label} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All {f.label}</SelectItem>
              {f.options.map((o) => (
                <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        ))}
        <div className="flex gap-1.5">
          <Button variant="outline" size="sm" onClick={exportCSV} className="h-9 gap-1.5">
            <Download className="h-3.5 w-3.5" /> CSV
          </Button>
          <Button variant="outline" size="sm" onClick={exportPDF} className="h-9 gap-1.5">
            <FileText className="h-3.5 w-3.5" /> PDF
          </Button>
        </div>
      </div>

      {/* Table */}
      <div className="border border-border rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-muted/50 border-b border-border">
                {selectionEnabled && (
                  <th className="px-3 py-2.5 w-10 sticky left-0 bg-muted/50 z-10">
                    <Checkbox
                      checked={allVisibleSelected ? true : someVisibleSelected ? 'indeterminate' : false}
                      onCheckedChange={toggleAll}
                      aria-label="Select all visible rows"
                    />
                  </th>
                )}
                {columns.map((col, i) => (
                  <th
                    key={col.key}
                    className={cn(
                      'px-3 py-2.5 text-left font-semibold text-muted-foreground whitespace-nowrap',
                      i === 0 && !selectionEnabled && 'sticky left-0 bg-muted/50 z-10',
                      col.sortable !== false && 'cursor-pointer select-none hover:text-foreground',
                      col.className
                    )}
                    onClick={() => col.sortable !== false && handleSort(col.key)}
                  >
                    <span className="flex items-center gap-1">
                      {col.label}
                      {col.sortable !== false && (
                        sortKey === col.key ? (
                          sortDir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />
                        ) : (
                          <ArrowUpDown className="h-3 w-3 opacity-30" />
                        )
                      )}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <tr key={i} className="border-b border-border">
                    {selectionEnabled && <td className="px-3 py-3 w-10" />}
                    {columns.map((col) => (
                      <td key={col.key} className="px-3 py-3">
                        <div className="h-4 w-20 bg-muted animate-pulse rounded" />
                      </td>
                    ))}
                  </tr>
                ))
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={columns.length + (selectionEnabled ? 1 : 0)} className="px-3 py-8 text-center text-muted-foreground">
                    No records found
                  </td>
                </tr>
              ) : (
                filtered.map((row, ri) => {
                  const rowId = selectionEnabled ? getRowId!(row) : '';
                  const isSelected = selectionEnabled && selectedSet.has(rowId);
                  return (
                  <tr
                    key={ri}
                    className={cn(
                      'border-b border-border last:border-0 hover:bg-muted/30 transition-colors',
                      isSelected && 'bg-primary/5',
                      onRowClick && 'cursor-pointer',
                    )}
                    onClick={onRowClick ? () => onRowClick(row) : undefined}
                  >
                    {selectionEnabled && (
                      <td className="px-3 py-2.5 w-10 sticky left-0 bg-background z-10">
                        <Checkbox
                          checked={isSelected}
                          onCheckedChange={() => toggleOne(rowId)}
                          aria-label="Select row"
                          onClick={(e) => e.stopPropagation()}
                        />
                      </td>
                    )}
                    {columns.map((col, ci) => (
                      <td
                        key={col.key}
                        className={cn(
                          'px-3 py-2.5 whitespace-nowrap',
                          ci === 0 && !selectionEnabled && 'sticky left-0 bg-background z-10 font-medium',
                          col.className
                        )}
                      >
                        {col.render ? col.render(row[col.key], row) : String(row[col.key] ?? '—')}
                      </td>
                    ))}
                  </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        {!loading && allFiltered.length > 0 && (
          <div className="px-3 py-2 bg-muted/30 text-xs text-muted-foreground border-t border-border flex items-center justify-between gap-2 flex-wrap">
            <span>
              Showing {pageStart + 1}-{pageEnd} of {allFiltered.length.toLocaleString()}
              {allFiltered.length !== data.length && (
                <span className="text-muted-foreground/70"> (filtered from {data.length.toLocaleString()})</span>
              )}
              {searching && <span className="text-primary"> • searching…</span>}
            </span>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2"
                disabled={safePage === 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
              >
                <ChevronLeft className="h-3.5 w-3.5" /> Prev
              </Button>
              <span className="text-xs px-2">
                Page {safePage + 1} / {totalPages}
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2"
                disabled={safePage >= totalPages - 1}
                onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              >
                Next <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
