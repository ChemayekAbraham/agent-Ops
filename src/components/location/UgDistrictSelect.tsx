/**
 * Shared searchable district select, sourced from the official ug_districts
 * reference table (same data layer as UgLocationPicker — no separate list).
 *
 * The region is derived from the chosen district and never typed by hand.
 */
import { useMemo, useState } from 'react';
import { Check, ChevronsUpDown, Loader2, MapPin } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from '@/components/ui/command';
import { useUgDistricts, type UgDistrictOption } from '@/hooks/useUgLocations';

export interface UgDistrictValue {
  id: number;
  name: string;
  region: string | null;
}

interface Props {
  value: UgDistrictValue | null;
  onChange: (v: UgDistrictValue | null) => void;
  label?: string;
  required?: boolean;
  /** Legacy free text still stored on the row, shown when it cannot be matched. */
  legacyText?: string | null;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
}

export function UgDistrictSelect({
  value, onChange, label = 'District', required, legacyText, placeholder = 'Select district',
  className, disabled,
}: Props) {
  const [open, setOpen] = useState(false);
  const { data: districts, isLoading, error } = useUgDistricts();

  const options = useMemo(() => (districts ?? []) as UgDistrictOption[], [districts]);
  const unmatchedLegacy = !value && (legacyText ?? '').trim();

  return (
    <div className={`space-y-1.5 ${className ?? ''}`}>
      <Label className="text-sm flex items-center gap-1">
        <MapPin className="h-3.5 w-3.5 text-primary" /> {label}
        {required && <span className="text-destructive">*</span>}
      </Label>

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            role="combobox"
            disabled={disabled}
            className="w-full h-10 justify-between font-normal"
          >
            <span className={value ? '' : 'text-muted-foreground'}>
              {value ? value.name : placeholder}
            </span>
            {isLoading
              ? <Loader2 className="h-4 w-4 animate-spin opacity-60" />
              : <ChevronsUpDown className="h-4 w-4 opacity-50" />}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          /* Above DialogContent (z-150) so the list is never hidden behind a dialog. */
          className="p-0 w-[--radix-popover-trigger-width] max-w-none z-[200] bg-popover shadow-xl"
          align="start"
        >
          <Command>
            <CommandInput placeholder="Search districts…" />
            <CommandList>
              <CommandEmpty>No district found.</CommandEmpty>
              <CommandGroup>
                {options.map((d) => (
                  <CommandItem
                    key={d.id}
                    value={d.name}
                    onSelect={() => {
                      onChange({ id: d.id, name: d.name, region: d.region ?? null });
                      setOpen(false);
                    }}
                  >
                    <Check
                      className={`mr-2 h-4 w-4 ${value?.id === d.id ? 'opacity-100' : 'opacity-0'}`}
                    />
                    <span className="flex-1">{d.name}</span>
                    {d.region && (
                      <span className="text-[10px] text-muted-foreground">{d.region}</span>
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      {error && (
        <p className="text-[11px] text-destructive">
          Could not load districts: {(error as any)?.message ?? 'unknown error'}
        </p>
      )}
      {value ? (
        <p className="text-[11px] text-muted-foreground">
          Region: <span className="font-medium text-foreground">{value.region ?? '—'}</span>{' '}
          (set automatically)
        </p>
      ) : unmatchedLegacy ? (
        <p className="text-[11px] text-muted-foreground">
          Saved: <span className="font-medium">{legacyText}</span> — pick the official district to update it.
        </p>
      ) : null}
    </div>
  );
}

export default UgDistrictSelect;