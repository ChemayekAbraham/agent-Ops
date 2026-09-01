import { useState } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Filter, X } from 'lucide-react';
import { CallingFilterBar } from './CallingFilterBar';
import type { CcFilterOption, CcFilterSelection } from '@/hooks/useCcCallingHub';

/**
 * Below lg only. Sort, search and every filter collapse behind one button so
 * the queue is the first thing on screen. Active chips stay outside the sheet.
 */
export function MobileControlsBar({
  options,
  loading,
  error,
  selection,
  filteredTotal,
  onChange,
  onClearAll,
  search,
  onSearch,
  sortOptions,
  sortKey,
  onSortKey,
}: {
  options: CcFilterOption[];
  loading: boolean;
  error: string | null;
  selection: CcFilterSelection;
  filteredTotal: number;
  onChange: (key: string, value: string) => void;
  onClearAll: () => void;
  search: string;
  onSearch: (v: string) => void;
  sortOptions: { key: string; label: string }[];
  sortKey: string | null;
  onSortKey: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const active = Object.entries(selection).filter(([, v]) => v);
  const chipLabel = (key: string, value: string) => {
    const option = options.find((o) => o.key === key);
    const choice = option?.choices.find((c) => c.value === value);
    return `${option?.label ?? key}: ${choice?.label ?? value}`;
  };

  return (
    <div className="space-y-2 lg:hidden">
      <Button variant="outline" className="h-9 w-full justify-between text-xs" onClick={() => setOpen(true)}>
        <span className="flex items-center gap-2">
          <Filter className="h-4 w-4" />
          Filters, sort & search
        </span>
        {active.length > 0 && <Badge variant="secondary">{active.length} active</Badge>}
      </Button>

      {(active.length > 0 || search) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {search && (
            <Badge variant="outline" className="gap-1 text-[10px]">
              Search: {search}
              <button type="button" aria-label="Clear search" onClick={() => onSearch('')}>
                <X className="h-3 w-3" />
              </button>
            </Badge>
          )}
          {active.map(([key, value]) => (
            <Badge key={key} variant="secondary" className="gap-1 text-[10px]">
              {chipLabel(key, String(value))}
              <button type="button" aria-label={`Clear ${key}`} onClick={() => onChange(key, '')}>
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
          {active.length > 0 && (
            <Button size="sm" variant="ghost" className="h-6 px-2 text-[10px]" onClick={onClearAll}>
              Clear all
            </Button>
          )}
        </div>
      )}

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="bottom"
          className="max-h-[88vh] overflow-y-auto rounded-t-2xl pb-[calc(1rem+env(safe-area-inset-bottom))]"
        >
          <SheetHeader className="text-left">
            <SheetTitle className="text-base">Narrow the list</SheetTitle>
          </SheetHeader>

          <div className="mt-3 space-y-3">
            <div className="space-y-1">
              <Label className="text-[11px] text-muted-foreground">Search</Label>
              <Input
                value={search}
                onChange={(e) => onSearch(e.target.value)}
                placeholder="Search name or district"
                className="h-9 text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-[11px] text-muted-foreground">Sort by</Label>
              <Select value={sortKey ?? ''} onValueChange={onSortKey}>
                <SelectTrigger className="h-9 w-full text-xs">
                  <SelectValue placeholder="Default order" />
                </SelectTrigger>
                <SelectContent>
                  {sortOptions.map((o) => (
                    <SelectItem key={o.key} value={o.key} className="text-xs">
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <CallingFilterBar
              options={options}
              loading={loading}
              error={error}
              selection={selection}
              filteredTotal={filteredTotal}
              onChange={onChange}
              onClearAll={onClearAll}
            />

            <Button className="h-11 w-full" onClick={() => setOpen(false)}>
              Show {filteredTotal.toLocaleString()} results
            </Button>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
