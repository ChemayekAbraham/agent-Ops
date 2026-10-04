import { useEffect, useState } from "react";
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
import {
  loadWorldCountriesUgandaFirst,
  type WorldCountry,
} from "@/lib/worldCountries";

interface CountryComboboxProps {
  value: string;
  onChange: (country: string) => void;
  placeholder?: string;
}

export function CountryCombobox({
  value,
  onChange,
  placeholder = "Select country",
}: CountryComboboxProps) {
  const [open, setOpen] = useState(false);
  const [countries, setCountries] = useState<WorldCountry[]>([]);
  const [loading, setLoading] = useState(false);

  // Lazily pull the (large) country dataset only when the picker opens.
  useEffect(() => {
    if (!open || countries.length > 0) return;
    let cancelled = false;
    setLoading(true);
    loadWorldCountriesUgandaFirst()
      .then((list) => {
        if (!cancelled) setCountries(list);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, countries.length]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-full justify-between font-normal"
        >
          <span className={cn("truncate", !value && "text-muted-foreground")}>
            {value || placeholder}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[--radix-popover-trigger-width] p-0"
        align="start"
      >
        <Command>
          <CommandInput placeholder="Search country…" />
          <CommandList>
            <CommandEmpty>
              {loading ? "Loading countries…" : "No country found."}
            </CommandEmpty>
            <CommandGroup>
              {countries.map((c) => (
                <CommandItem
                  key={c.name}
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
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}