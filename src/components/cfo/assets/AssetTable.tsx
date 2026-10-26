import { useEffect, useState } from 'react';
import { Search, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { formatUGX } from '@/lib/rentCalculations';
import { useAssetList, useAssetReferenceData } from '@/hooks/useAssetRegister';
import {
  ASSET_CATEGORIES, ASSET_CONDITIONS, ASSET_STATUSES, categoryLabel, conditionLabel, statusLabel,
  type AssetListFilters,
} from '@/lib/assetRegister/types';

const PAGE_SIZE = 25;
const ALL = '__all__';

const EMPTY_FILTERS: AssetListFilters = { search: '', category: null, status: null, condition: null, department: null };

const STATUS_TONE: Record<string, string> = {
  in_use: 'bg-success/10 text-success',
  in_storage: 'bg-info/10 text-info',
  under_repair: 'bg-warning/10 text-warning',
  lost: 'bg-destructive/10 text-destructive',
  disposed: 'bg-muted text-muted-foreground',
};

/** Searchable, filterable, server-paged register table. Row click opens the asset detail. */
export function AssetTable({ onOpen }: { onOpen: (id: string) => void }) {
  const [filters, setFilters] = useState<AssetListFilters>(EMPTY_FILTERS);
  const [searchText, setSearchText] = useState('');
  const [offset, setOffset] = useState(0);
  const ref = useAssetReferenceData();

  useEffect(() => {
    const t = setTimeout(() => {
      setFilters((f) => (f.search === searchText ? f : { ...f, search: searchText }));
      setOffset(0);
    }, 300);
    return () => clearTimeout(t);
  }, [searchText]);

  const q = useAssetList(filters, offset, PAGE_SIZE);
  const total = q.data?.total_count ?? 0;
  const items = q.data?.items ?? [];
  const filtered = filters.search || filters.category || filters.status || filters.condition || filters.department;

  const setFilter = (key: keyof Omit<AssetListFilters, 'search'>, v: string) => {
    setFilters((f) => ({ ...f, [key]: v === ALL ? null : v }));
    setOffset(0);
  };

  return (
    <section className="rounded-xl border border-border bg-card shadow-sm" aria-label="Asset register">
      <div className="flex flex-col gap-3 border-b border-border/60 p-4 lg:flex-row lg:items-center">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            id="asset-register-search"
            aria-label="Search assets"
            placeholder="Search by asset ID, name, serial, custodian, supplier…"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            maxLength={100}
            className="h-9 pl-9 text-xs"
          />
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:flex">
          <FilterSelect id="asset-filter-category" label="Category" value={filters.category} options={ASSET_CATEGORIES} onChange={(v) => setFilter('category', v)} />
          <FilterSelect id="asset-filter-status" label="Status" value={filters.status} options={ASSET_STATUSES} onChange={(v) => setFilter('status', v)} />
          <FilterSelect id="asset-filter-condition" label="Condition" value={filters.condition} options={ASSET_CONDITIONS} onChange={(v) => setFilter('condition', v)} />
          <FilterSelect
            id="asset-filter-department" label="Department" value={filters.department}
            options={(ref.data?.departments ?? []).map((d) => ({ key: d.key, label: d.name }))}
            onChange={(v) => setFilter('department', v)}
          />
        </div>
        {filtered && (
          <Button variant="ghost" size="sm" className="h-9 text-xs" onClick={() => { setSearchText(''); setFilters(EMPTY_FILTERS); setOffset(0); }}>
            <X className="mr-1 h-3.5 w-3.5" /> Clear
          </Button>
        )}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-muted/40 text-[11px] text-muted-foreground">
            <tr>
              <th className="px-3 py-2.5 text-left font-medium">Asset ID</th>
              <th className="px-3 py-2.5 text-left font-medium">Name</th>
              <th className="hidden px-3 py-2.5 text-left font-medium md:table-cell">Category</th>
              <th className="hidden px-3 py-2.5 text-left font-medium lg:table-cell">Serial</th>
              <th className="hidden px-3 py-2.5 text-left font-medium lg:table-cell">Custodian</th>
              <th className="hidden px-3 py-2.5 text-left font-medium xl:table-cell">Location</th>
              <th className="px-3 py-2.5 text-left font-medium">Status</th>
              <th className="hidden px-3 py-2.5 text-right font-medium sm:table-cell">Cost</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {q.isLoading && (
              <tr><td colSpan={8} className="py-10 text-center text-muted-foreground">Loading assets…</td></tr>
            )}
            {q.isError && (
              <tr><td colSpan={8} role="alert" className="py-10 text-center text-destructive">Could not load the asset register.</td></tr>
            )}
            {!q.isLoading && !q.isError && items.length === 0 && (
              <tr><td colSpan={8} className="py-10 text-center text-muted-foreground">
                {filtered ? 'No assets match these filters.' : 'No assets registered yet. Add one or import from Excel.'}
              </td></tr>
            )}
            {items.map((a) => (
              <tr
                key={a.id}
                tabIndex={0}
                onClick={() => onOpen(a.id)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(a.id); } }}
                className="cursor-pointer transition-colors hover:bg-muted/30 focus-visible:bg-muted/40 focus-visible:outline-none"
              >
                <td className="whitespace-nowrap px-3 py-2.5 font-mono text-[11px] text-primary">{a.asset_code}</td>
                <td className="max-w-[16rem] px-3 py-2.5">
                  <span className="block truncate font-medium text-foreground">{a.name}</span>
                  <span className="block truncate text-[10px] text-muted-foreground">
                    {[a.brand, a.model].filter(Boolean).join(' · ') || conditionLabel(a.condition)}
                  </span>
                </td>
                <td className="hidden whitespace-nowrap px-3 py-2.5 text-muted-foreground md:table-cell">{categoryLabel(a.category)}</td>
                <td className="hidden whitespace-nowrap px-3 py-2.5 font-mono text-[11px] text-muted-foreground lg:table-cell">{a.serial_number ?? '—'}</td>
                <td className="hidden max-w-[12rem] truncate px-3 py-2.5 text-muted-foreground lg:table-cell">{a.custodian_display ?? '—'}</td>
                <td className="hidden max-w-[12rem] truncate px-3 py-2.5 text-muted-foreground xl:table-cell">{a.location ?? '—'}</td>
                <td className="whitespace-nowrap px-3 py-2.5">
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${STATUS_TONE[a.status] ?? ''}`}>{statusLabel(a.status)}</span>
                </td>
                <td className="hidden whitespace-nowrap px-3 py-2.5 text-right tabular-nums sm:table-cell">
                  {a.purchase_cost === null ? '—' : a.currency === 'UGX' ? formatUGX(a.purchase_cost) : `${a.currency} ${Number(a.purchase_cost).toLocaleString()}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-border/60 px-4 py-2.5 text-xs text-muted-foreground">
        <span>{total ? `Showing ${offset + 1}–${offset + items.length} of ${total.toLocaleString()}` : '0 assets'}</span>
        <div className="flex items-center gap-1.5">
          <Button variant="outline" size="sm" className="h-8" aria-label="Previous page" disabled={offset === 0 || q.isFetching}
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button variant="outline" size="sm" className="h-8" aria-label="Next page" disabled={offset + PAGE_SIZE >= total || q.isFetching}
            onClick={() => setOffset(offset + PAGE_SIZE)}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </section>
  );
}

function FilterSelect({ id, label, value, options, onChange }: {
  id: string; label: string; value: string | null;
  options: ReadonlyArray<{ key: string; label: string }>;
  onChange: (v: string) => void;
}) {
  return (
    <Select value={value ?? ALL} onValueChange={onChange}>
      <SelectTrigger id={id} aria-label={`Filter by ${label.toLowerCase()}`} className="h-9 min-w-[8.5rem] text-xs">
        <SelectValue placeholder={label} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>All {label.toLowerCase()}</SelectItem>
        {options.map((o) => <SelectItem key={o.key} value={o.key}>{o.label}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}
