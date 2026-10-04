import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { Loader2, MapPin, Users, ChevronDown, ChevronUp } from 'lucide-react';

/**
 * Pay by Location / Category — RECIPIENT SELECTION ONLY.
 *
 * This component holds **no payout logic**: no amount input, no calculation,
 * no validation, no ledger call. It only filters people/tenants by an
 * existing location or category field and hands the picked rows back to the
 * caller, which then runs the *existing* General Payout flow unchanged
 * (same components, same auto-calculated amounts, same checks, same records).
 */

type FieldKey =
  | 'district'
  | 'town'
  | 'city'
  | 'sub_county'
  | 'parish'
  | 'village'
  | 'region'
  | 'tenant_house_category';

const FIELD_LABELS: Record<FieldKey, string> = {
  district: 'District',
  town: 'Town Council',
  city: 'City / Municipality',
  sub_county: 'Sub-county',
  parish: 'Parish',
  village: 'Village',
  region: 'Region',
  tenant_house_category: 'House category',
};

const FIELD_KEYS = Object.keys(FIELD_LABELS) as FieldKey[];

export interface LocationRecipient {
  id: string;
  full_name: string;
  phone: string | null;
  /**
   * Present only in `rent_queue` mode: the COO-approved rent request this
   * tenant is eligible under. Passed straight into the existing rent
   * disbursement queue, which calculates the payout amount itself.
   */
  rent_request_id?: string;
}

interface Row extends LocationRecipient {
  district: string | null;
  town: string | null;
  city: string | null;
  sub_county: string | null;
  parish: string | null;
  village: string | null;
  region: string | null;
  tenant_house_category: string | null;
}

interface Props {
  /** Called with the ticked people — the caller feeds them into the existing payout flow. */
  onUseRecipients: (recipients: LocationRecipient[]) => void;
  /** Number of recipients currently queued in the existing payout form. */
  queuedCount?: number;
  disabled?: boolean;
  /**
   * 'rent_queue' → only tenants that are eligible in the existing rent
   * disbursement queue (COO-approved). 'profiles' → any person.
   */
  mode?: 'profiles' | 'rent_queue';
}

const LOCATION_COLUMNS =
  'id, full_name, phone, district, town, city, sub_county, parish, village, region, tenant_house_category';

export function PayByLocationRecipientPicker({
  onUseRecipients,
  queuedCount = 0,
  disabled,
  mode = 'profiles',
}: Props) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [field, setField] = useState<FieldKey>('district');
  const [value, setValue] = useState('');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const { data: rows = [], isLoading, error } = useQuery({
    queryKey: ['pay-by-location-recipients', mode],
    enabled: open,
    staleTime: 30_000,
    queryFn: async (): Promise<Row[]> => {
      if (mode === 'rent_queue') {
        // Eligible tenants = exactly the rows the existing General Payout
        // rent queue works on. We only read them to build the location list.
        const { data: reqs, error: rErr } = await supabase
          .from('rent_requests')
          .select('id, tenant_id, created_at')
          .eq('status', 'coo_approved')
          .order('created_at', { ascending: true });
        if (rErr) throw rErr;
        const tenantIds = [...new Set((reqs ?? []).map(r => r.tenant_id).filter(Boolean))] as string[];
        if (!tenantIds.length) return [];
        const { data: profs, error: pErr } = await supabase
          .from('profiles')
          .select(LOCATION_COLUMNS)
          .in('id', tenantIds);
        if (pErr) throw pErr;
        const pMap = new Map((profs ?? []).map((p: any) => [p.id, p]));
        return (reqs ?? [])
          .map(r => {
            const p: any = pMap.get(r.tenant_id);
            if (!p) return null;
            return { ...p, rent_request_id: r.id } as Row;
          })
          .filter(Boolean) as Row[];
      }

      const { data, error: e } = await supabase
        .from('profiles')
        .select(LOCATION_COLUMNS)
        .order('full_name', { ascending: true })
        .limit(3000);
      if (e) throw e;
      return (data ?? []) as Row[];
    },
  });

  useEffect(() => {
    if (error) {
      toast({
        title: 'Could not load eligible recipients',
        description: (error as any).message,
        variant: 'destructive',
      });
    }
  }, [error, toast]);

  const options = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of rows) {
      const v = (r[field] ?? '').toString().trim();
      if (!v) continue;
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [rows, field]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter(r => {
      if ((r[field] ?? '').toString().trim() !== value) return false;
      if (!q) return true;
      return (
        (r.full_name ?? '').toLowerCase().includes(q) ||
        (r.phone ?? '').toLowerCase().includes(q)
      );
    });
  }, [rows, field, value, search]);

  const rowKey = (r: Row) => r.rent_request_id ?? r.id;

  const toggle = (key: string) =>
    setSelected(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  const toggleAll = () =>
    setSelected(prev =>
      prev.size === filtered.length && filtered.length > 0
        ? new Set()
        : new Set(filtered.map(rowKey)),
    );

  const use = () => {
    const picked = filtered
      .filter(r => selected.has(rowKey(r)))
      .map(r => ({
        id: r.id,
        full_name: r.full_name,
        phone: r.phone,
        ...(r.rent_request_id ? { rent_request_id: r.rent_request_id } : {}),
      }));
    if (!picked.length) return;
    onUseRecipients(picked);
    toast({
      title: `${picked.length} recipient${picked.length === 1 ? '' : 's'} selected`,
      description:
        mode === 'rent_queue'
          ? `From ${FIELD_LABELS[field]}: ${value}. The normal payout below now shows them with their calculated amounts.`
          : `From ${FIELD_LABELS[field]}: ${value}. Complete the payout below as usual.`,
    });
  };

  return (
    <Card className="border-primary/30">
      <CardHeader className="cursor-pointer py-3" onClick={() => setOpen(o => !o)}>
        <CardTitle className="flex items-center justify-between text-sm">
          <span className="flex items-center gap-2">
            <MapPin className="h-4 w-4 text-primary" />
            Pay by Location / Category (optional)
            {queuedCount > 0 && (
              <Badge variant="secondary" className="text-[10px]">{queuedCount} selected</Badge>
            )}
          </span>
          {open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </CardTitle>
      </CardHeader>

      {open && (
        <CardContent className="space-y-3">
          <p className="text-[11px] text-muted-foreground">
            This only chooses who gets paid.{' '}
            {mode === 'rent_queue'
              ? 'The payout itself opens below in the normal payout screen, with the amount calculated automatically exactly as usual.'
              : 'Amounts, checks, approval and records stay exactly the same as the normal payout form below.'}
          </p>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Category type</Label>
              <Select
                value={field}
                onValueChange={v => {
                  setField(v as FieldKey);
                  setValue('');
                  setSelected(new Set());
                }}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {FIELD_KEYS.map(k => (
                    <SelectItem key={k} value={k}>{FIELD_LABELS[k]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>{FIELD_LABELS[field]}</Label>
              <Select value={value} onValueChange={v => { setValue(v); setSelected(new Set()); }}>
                <SelectTrigger>
                  <SelectValue placeholder={isLoading ? 'Loading…' : 'Select'} />
                </SelectTrigger>
                <SelectContent className="max-h-72">
                  {options.map(([v, count]) => (
                    <SelectItem key={v} value={v}>{v} ({count})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {isLoading && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading eligible recipients…
            </p>
          )}

          {!isLoading && options.length === 0 && (
            <p className="text-xs text-muted-foreground">
              No {FIELD_LABELS[field].toLowerCase()} recorded for
              {mode === 'rent_queue' ? ' the eligible tenants' : ' these people'} yet.
            </p>
          )}

          {value && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  placeholder="Search name or phone…"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  className="h-9 max-w-xs"
                />
                <Button type="button" variant="outline" size="sm" onClick={toggleAll}>
                  {selected.size === filtered.length && filtered.length > 0
                    ? 'Clear all'
                    : `Select all (${filtered.length})`}
                </Button>
                <Badge variant="secondary" className="gap-1">
                  <Users className="h-3 w-3" /> {selected.size} selected
                </Badge>
              </div>

              <div className="max-h-64 divide-y overflow-y-auto rounded-md border">
                {filtered.length === 0 && (
                  <p className="p-3 text-sm text-muted-foreground">Nobody eligible in this selection.</p>
                )}
                {filtered.map(r => (
                  <label
                    key={rowKey(r)}
                    className="flex cursor-pointer items-center gap-3 p-2.5 hover:bg-muted/50"
                  >
                    <Checkbox
                      checked={selected.has(rowKey(r))}
                      onCheckedChange={() => toggle(rowKey(r))}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{r.full_name || 'Unnamed'}</span>
                      <span className="block truncate text-xs text-muted-foreground">{r.phone ?? '—'}</span>
                    </span>
                  </label>
                ))}
              </div>

              <Button
                type="button"
                className="w-full"
                variant="secondary"
                disabled={disabled || selected.size === 0}
                onClick={use}
              >
                Use {selected.size} selected recipient{selected.size === 1 ? '' : 's'}
              </Button>
            </>
          )}
        </CardContent>
      )}
    </Card>
  );
}

export default PayByLocationRecipientPicker;