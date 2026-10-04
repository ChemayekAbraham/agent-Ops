import { useMemo } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { PhoneInput } from '@/components/ui/phone-input';
import { Trash2, Plus, Home } from 'lucide-react';
import { format, subMonths } from 'date-fns';

export interface RentHistoryEntry {
  monthKey: string;            // YYYY-MM
  landlord_name: string;
  landlord_phone: string;
  property_location: string;
  rent_amount: number;
}

interface Props {
  entries: RentHistoryEntry[];
  onChange: (entries: RentHistoryEntry[]) => void;
}

const formatCurrency = (raw: string) => {
  const d = raw.replace(/\D/g, '');
  return d ? Number(d).toLocaleString('en-UG') : '';
};

export default function RentHistoryCaptureGrid({ entries, onChange }: Props) {
  // Pre-compute the last 12 months as suggestion slots
  const monthSuggestions = useMemo(() => {
    const now = new Date();
    return Array.from({ length: 12 }, (_, i) => {
      const d = subMonths(now, i);
      return { key: format(d, 'yyyy-MM'), label: format(d, 'MMM yyyy') };
    });
  }, []);

  const usedMonths = new Set(entries.map((e) => e.monthKey));
  const availableMonths = monthSuggestions.filter((m) => !usedMonths.has(m.key));

  const addMonth = (monthKey: string) => {
    // Reuse last entry's landlord details so agent doesn't retype
    const last = entries[entries.length - 1];
    onChange([
      ...entries,
      {
        monthKey,
        landlord_name: last?.landlord_name || '',
        landlord_phone: last?.landlord_phone || '',
        property_location: last?.property_location || '',
        rent_amount: last?.rent_amount || 0,
      },
    ]);
  };

  const updateEntry = (idx: number, patch: Partial<RentHistoryEntry>) => {
    const next = [...entries];
    next[idx] = { ...next[idx], ...patch };
    onChange(next);
  };

  const removeEntry = (idx: number) => {
    onChange(entries.filter((_, i) => i !== idx));
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          Ask the tenant: <em>"For each of the last 12 months, who was your landlord and how much did you pay?"</em>
        </p>
      </div>

      {entries.length === 0 && (
        <div className="rounded-lg border-2 border-dashed border-border p-4 text-center space-y-2">
          <Home className="h-6 w-6 mx-auto text-muted-foreground" />
          <p className="text-xs text-muted-foreground">No months recorded yet</p>
          <p className="text-[11px] text-muted-foreground">Tap a month below to start</p>
        </div>
      )}

      {entries.map((entry, idx) => {
        const monthLabel = monthSuggestions.find((m) => m.key === entry.monthKey)?.label || entry.monthKey;
        return (
          <div key={entry.monthKey + idx} className="rounded-lg border border-border p-3 space-y-2 bg-muted/30">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold uppercase tracking-wider text-primary">{monthLabel}</span>
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => removeEntry(idx)}>
                <Trash2 className="h-3.5 w-3.5 text-destructive" />
              </Button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Input
                placeholder="Landlord name"
                value={entry.landlord_name}
                onChange={(e) => updateEntry(idx, { landlord_name: e.target.value })}
                className="h-9 text-xs"
              />
              <PhoneInput
                placeholder="Landlord phone"
                value={entry.landlord_phone}
                onChange={(v) => updateEntry(idx, { landlord_phone: v.replace(/[^\d+]/g, '').slice(0, 13) })}
                onContactPicked={({ name }) => {
                  if (name && !entry.landlord_name.trim()) updateEntry(idx, { landlord_name: name });
                }}
                className="h-9 text-xs"
              />
            </div>
            <Input
              placeholder="Property location (e.g. Kabalagala)"
              value={entry.property_location}
              onChange={(e) => updateEntry(idx, { property_location: e.target.value })}
              className="h-9 text-xs"
            />
            <Input
              placeholder="Rent paid (UGX)"
              inputMode="numeric"
              value={entry.rent_amount ? entry.rent_amount.toLocaleString('en-UG') : ''}
              onChange={(e) =>
                updateEntry(idx, { rent_amount: parseInt(formatCurrency(e.target.value).replace(/,/g, '')) || 0 })
              }
              className="h-9 text-sm font-semibold"
            />
          </div>
        );
      })}

      {availableMonths.length > 0 && (
        <div className="space-y-2">
          <p className="text-[11px] uppercase font-bold tracking-wider text-muted-foreground">Add a month</p>
          <div className="flex flex-wrap gap-1.5">
            {availableMonths.map((m) => (
              <button
                key={m.key}
                type="button"
                onClick={() => addMonth(m.key)}
                className="text-[11px] px-2.5 py-1.5 rounded-full border border-border hover:border-primary hover:bg-primary/5 transition-colors flex items-center gap-1"
              >
                <Plus className="h-3 w-3" /> {m.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
