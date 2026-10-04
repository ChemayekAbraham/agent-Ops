import { useEffect, useMemo, useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { loadCitiesForCountry, type WorldCity } from "@/lib/worldCountries";

interface CityComboboxProps {
  /** ISO-3166 alpha-2 code of the selected country. */
  countryIso: string | null;
  value: string;
  onChange: (city: string) => void;
  placeholder?: string;
}

const MAX_RESULTS = 100;

export function CityCombobox({
  countryIso,
  value,
  onChange,
  placeholder = "Select city / town",
}: CityComboboxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [cities, setCities] = useState<WorldCity[]>([]);
  const [loading, setLoading] = useState(false);

  // Lazily load the (large) city dataset only once the picker is opened
  // for a selected country.
  useEffect(() => {
    if (!open || !countryIso) return;
    let cancelled = false;
    setLoading(true);
    loadCitiesForCountry(countryIso)
      .then((list) => {
        if (!cancelled) setCities(list);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, countryIso]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? cities.filter((c) => c.name.toLowerCase().includes(q))
      : cities;
    return list.slice(0, MAX_RESULTS);
  }, [cities, query]);

  const hasCities = cities.length > 0;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={!countryIso}
          className="w-full justify-between font-normal"
        >
          <span className={cn("truncate", !value && "text-muted-foreground")}>
            {value || (countryIso ? placeholder : "Select a country first")}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[--radix-popover-trigger-width] p-0"
        align="start"
      >
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search city / town…"
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            <CommandEmpty>
              {loading
                ? "Loading cities…"
                : hasCities
                ? "No matching city. You can type it manually below."
                : "No cities listed for this country. Type it manually below."}
            </CommandEmpty>
            {query.trim() && (
              <CommandGroup heading="Use what you typed">
                <CommandItem
                  value={`__custom__${query}`}
                  onSelect={() => {
                    onChange(query.trim());
                    setOpen(false);
                  }}
                >
                  <Check
                    className={cn(
                      "mr-2 h-4 w-4",
                      value === query.trim() ? "opacity-100" : "opacity-0",
                    )}
                  />
                  Use “{query.trim()}”
                </CommandItem>
              </CommandGroup>
            )}
            {filtered.length > 0 && (
              <CommandGroup heading={hasCities ? "Cities & towns" : undefined}>
                {filtered.map((c) => (
                  <CommandItem
                    key={`${c.name}-${c.stateCode}`}
                    value={c.name}
                    onSelect={() => {
                      onChange(c.name);
                      setOpen(false);
                    }}
                  >
                    <Check
                      className={cn(
                        "mr-2 h-4 w-4",
                        value === c.name ? "opacity-100" : "opacity-0",
                      )}
                    />
                    {c.name}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}