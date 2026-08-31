import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ChevronsUpDown, Filter, X } from 'lucide-react';
import type { CcFilterOption, CcFilterSelection } from '@/hooks/useCcCallingHub';

const ALL = '__all__';
const SEARCHABLE_THRESHOLD = 20;

/** A long value list (linked agent) gets a searchable popover instead of a select. */
function SearchableFilter({
  option,
  value,
  onChange,
}: {
  option: CcFilterOption;
  value: string;
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = needle ? option.choices.filter((c) => c.label.toLowerCase().includes(needle)) : option.choices;
    return list.slice(0, 200);
  }, [option.choices, q]);
  const selected = option.choices.find((c) => c.value === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" className="h-8 w-full justify-between px-2 text-xs font-normal sm:w-[190px]">
          <span className="truncate">{selected ? selected.label : 'All'}</span>
          <ChevronsUpDown className="ml-1 h-3 w-3 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[240px] p-2">
        <Input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={`Search ${option.label.toLowerCase()}`}
          className="mb-2 h-8 text-xs"
        />
        <div className="max-h-64 space-y-0.5 overflow-y-auto">
          <button
            type="button"
            className="w-full rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted"
            onClick={() => {
              onChange('');
              setOpen(false);
            }}
          >
            All
          </button>
          {shown.map((c) => (
            <button
              key={c.value}
              type="button"
              className={`w-full rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted ${
                c.value === value ? 'bg-muted font-semibold' : ''
              }`}
              onClick={() => {
                onChange(c.value);
                setOpen(false);
              }}
            >
              {c.count === null ? c.label : `${c.label} (${c.count.toLocaleString()})`}
            </button>
          ))}
          {!shown.length && <p className="px-2 py-1.5 text-xs text-muted-foreground">No matches</p>}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Config-driven filter bar. Keys, labels, buckets and values all come from the
 * database (cc_filter_options / cc_filter_buckets / cc_filter_values) — nothing
 * about any individual filter is written here.
 */
export function CallingFilterBar({
  options,
  loading,
  error,
  selection,
  filteredTotal,
  onChange,
  onClearAll,
}: {
  options: CcFilterOption[];
  loading: boolean;
  error: string | null;
  selection: CcFilterSelection;
  filteredTotal: number;
  onChange: (key: string, value: string) => void;
  onClearAll: () => void;
}) {
  const activeCount = Object.values(selection).filter(Boolean).length;

  if (error) {
    return (
      <p className="rounded-lg bg-destructive/10 px-2 py-1.5 text-xs font-semibold text-destructive">{error}</p>
    );
  }
  if (loading || !options.length) return null;

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-1 gap-2 sm:flex sm:flex-wrap sm:items-end">
        {options.map((o) => {
          const value = selection[o.key] ?? '';
          const disabled = o.choices.length === 0;
          return (
            <div key={o.key} className="min-w-0 space-y-1">
              <Label className="text-[11px] text-muted-foreground">{o.label}</Label>
              {disabled ? (
                <Button
                  variant="outline"
                  disabled
                  className="h-8 w-full justify-start px-2 text-xs font-normal sm:w-[190px]"
                >
                  No values
                </Button>
              ) : o.kind === 'value' && o.choices.length > SEARCHABLE_THRESHOLD ? (
                <SearchableFilter option={o} value={value} onChange={(v) => onChange(o.key, v)} />
              ) : (
                <Select
                  value={value || ALL}
                  onValueChange={(v) => onChange(o.key, v === ALL ? '' : v)}
                >
                  <SelectTrigger className="h-8 w-full text-xs sm:w-[190px]">
                    <SelectValue placeholder="All" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL} className="text-xs">
                      All
                    </SelectItem>
                    {o.choices.map((c) => (
                      <SelectItem key={c.value} value={c.value} className="text-xs">
                        {c.count === null ? c.label : `${c.label} (${c.count.toLocaleString()})`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          );
        })}
      </div>


      {activeCount > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg bg-muted/60 px-2 py-1.5">
          <Filter className="h-3 w-3 text-primary" />
          <span className="text-[11px] font-semibold">
            {activeCount} filter{activeCount === 1 ? '' : 's'} active
          </span>
          <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
            {filteredTotal.toLocaleString()} rows
          </Badge>
          {options
            .filter((o) => selection[o.key])
            .map((o) => {
              const v = selection[o.key];
              const label = o.choices.find((c) => c.value === v)?.label ?? v;
              return (
                <Badge key={o.key} variant="outline" className="max-w-full gap-1 whitespace-normal break-words px-1.5 py-0 text-left text-[10px]">
                  {o.label}: {label}
                  <button type="button" onClick={() => onChange(o.key, '')} aria-label={`Clear ${o.label}`}>
                    <X className="h-2.5 w-2.5" />
                  </button>
                </Badge>
              );
            })}
          <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px] sm:ml-auto" onClick={onClearAll}>
            Clear all
          </Button>

        </div>
      )}
    </div>
  );
}

export default CallingFilterBar;
