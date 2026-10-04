import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Pencil, Loader2, X, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import { UgLocationPicker } from '@/components/location/UgLocationPicker';
import {
  resolveUgVillage,
  ugLocationLabel,
  type UgLocationSelection,
} from '@/hooks/useUgLocations';
import { validateUgandaPhone } from '@/lib/ugandaPhone';

type Props = {
  landlordId: string;
  landlord: any;
  canEdit: boolean;
};

/**
 * Free-text district / sub-county / village inputs are gone: the official
 * location comes from the shared UgLocationPicker (same ug_* dataset used by
 * house listings and rent requests), so ops corrections can never introduce a
 * spelling that does not exist in the government hierarchy.
 */
const FIELDS: Array<{ key: string; label: string; type?: 'text' | 'number' | 'textarea' }> = [
  { key: 'name', label: 'Landlord name' },
  { key: 'phone', label: 'Phone' },
  { key: 'mobile_money_number', label: 'MoMo number' },
  { key: 'mobile_money_name', label: 'MoMo name' },
  { key: 'monthly_rent', label: 'Monthly rent (UGX)', type: 'number' },
  { key: 'number_of_rooms', label: 'Rooms', type: 'number' },
  { key: 'property_address', label: 'Property address' },
  { key: 'house_number', label: 'House number' },
  { key: 'bank_name', label: 'Bank name' },
  { key: 'bank_branch', label: 'Bank branch' },
  { key: 'account_number', label: 'Bank account #' },
  { key: 'bank_account_name', label: 'Bank account name' },

  { key: 'caretaker_name', label: 'Caretaker name' },
  { key: 'caretaker_phone', label: 'Caretaker phone' },
  { key: 'electricity_meter_number', label: 'Electricity meter #' },
  { key: 'water_meter_number', label: 'Water meter #' },
  { key: 'description', label: 'Description / notes', type: 'textarea' },
];

/** Numbers we dial, so they must be valid Ugandan numbers before saving. */
const PHONE_FIELDS = ['phone', 'mobile_money_number', 'caretaker_phone'];
/** Fields the landlord record cannot exist without. */
const REQUIRED_FIELDS = ['name', 'phone'];

export function LandlordEditCard({ landlordId, landlord, canEdit }: Props) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<Record<string, string>>(() =>
    Object.fromEntries(FIELDS.map((f) => [f.key, landlord?.[f.key] != null ? String(landlord[f.key]) : ''])),
  );
  const [reason, setReason] = useState('');
  const [loc, setLoc] = useState<UgLocationSelection | null>(null);
  const [locError, setLocError] = useState<string | null>(null);
  // Location already on file, shown when it cannot be resolved to a dataset row
  // so ops always sees what is stored and we never blank it out silently.
  const storedLocLabel = [landlord?.village, landlord?.sub_county, landlord?.county, landlord?.district, landlord?.region]
    .filter(Boolean)
    .join(', ');

  // Prefill the picker from the stored official village id when we have one.
  useEffect(() => {
    if (!open) return;
    const vid = Number(landlord?.ug_village_id);
    if (!Number.isFinite(vid) || vid <= 0) return;
    let alive = true;
    resolveUgVillage(vid)
      .then((sel) => { if (alive && sel) setLoc(sel); })
      .catch(() => { /* keep stored names visible; never wipe */ });
    return () => { alive = false; };
  }, [open, landlord?.ug_village_id]);

  const save = useMutation({
    mutationFn: async () => {
      if (reason.trim().length < 10) throw new Error('Reason must be ≥ 10 characters');
      const patch: Record<string, string> = {};
      for (const f of FIELDS) {
        const original = landlord?.[f.key] != null ? String(landlord[f.key]) : '';
        const next = (form[f.key] ?? '').trim();
        if (next === original.trim()) continue;

        // Validate only what the officer actually changed, so untouched
        // legacy values are never rejected or overwritten.
        if (PHONE_FIELDS.includes(f.key) && next !== '') {
          const check = validateUgandaPhone(next);
          if (!check.valid) throw new Error(`${f.label}: enter a valid Ugandan phone number`);
          patch[f.key] = check.e164 as string;
          continue;
        }
        if (f.type === 'number' && next !== '') {
          const n = Number(next);
          if (!Number.isFinite(n) || n < 0) throw new Error(`${f.label}: enter a valid amount`);
        }
        if (REQUIRED_FIELDS.includes(f.key) && next === '') {
          throw new Error(`${f.label} cannot be emptied`);
        }
        patch[f.key] = next;
      }
      // Only send location fields that actually changed. A null/empty pick is
      // never sent, so an existing address can never be overwritten with nulls.
      if (loc) {
        const locPatch: Record<string, string> = {
          region: loc.region ?? '',
          district: loc.district,
          county: loc.county,
          sub_county: loc.subcounty,
          village: loc.village,
          ug_village_id: String(loc.villageId),
        };
        for (const [k, v] of Object.entries(locPatch)) {
          if (!v) continue;
          const original = landlord?.[k] != null ? String(landlord[k]).trim() : '';
          if (v.trim() !== original) patch[k] = v.trim();
        }
      }
      if (Object.keys(patch).length === 0) throw new Error('No changes to save');
      const { error } = await supabase.rpc('ops_update_landlord' as any, {
        p_landlord_id: landlordId,
        p_patch: patch,
        p_reason: reason.trim(),
      } as any);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Landlord profile updated');
      qc.invalidateQueries({ queryKey: ['drilldown-landlord', landlordId] });
      qc.invalidateQueries({ queryKey: ['landlord-change-history', landlordId] });
      setOpen(false);
      setReason('');
      setLocError(null);
    },
    onError: (e: any) => {
      const msg = e?.message ?? 'Update failed';
      if (/location|village|district/i.test(msg)) setLocError(msg);
      toast.error(msg);
    },
  });

  if (!canEdit) return null;

  if (!open) {
    return (
      <Button size="sm" variant="outline" className="h-8 w-full justify-center" onClick={() => setOpen(true)}>
        <Pencil className="h-3 w-3 mr-1" /> Edit landlord profile
      </Button>
    );
  }

  return (
    <Card className="p-3 space-y-2 border-primary/40">
      <div className="flex items-center justify-between">
        <div className="text-xs font-medium flex items-center gap-1">
          <Pencil className="h-3 w-3" /> Edit landlord profile
        </div>
        <Button size="sm" variant="ghost" className="h-6 px-1" onClick={() => setOpen(false)}>
          <X className="h-3 w-3" />
        </Button>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {FIELDS.map((f) => (
          <div key={f.key} className={f.type === 'textarea' ? 'sm:col-span-2' : ''}>
            <Label className="text-[10px] uppercase text-muted-foreground">{f.label}</Label>
            {f.type === 'textarea' ? (
              <Textarea
                value={form[f.key] ?? ''}
                onChange={(e) => setForm((s) => ({ ...s, [f.key]: e.target.value }))}
                rows={2}
                className="text-xs"
              />
            ) : (
              <Input
                type={f.type === 'number' ? 'number' : 'text'}
                value={form[f.key] ?? ''}
                onChange={(e) => setForm((s) => ({ ...s, [f.key]: e.target.value }))}
                className="h-8 text-sm"
              />
            )}
          </div>
        ))}
      </div>
      <div className="rounded-md border bg-muted/30 p-2">
        <UgLocationPicker
          value={loc}
          onChange={(sel) => { setLoc(sel); setLocError(null); }}
          label="Official location (region → village)"
          error={locError}
        />
        {!loc && storedLocLabel && (
          <p className="mt-1 flex items-start gap-1 text-[10px] text-muted-foreground">
            <AlertTriangle className="h-3 w-3 mt-[1px] shrink-0" />
            On file: {storedLocLabel}. Leave untouched to keep it, or pick an official location to correct it.
          </p>
        )}
        {loc && (
          <p className="mt-1 text-[10px] text-muted-foreground">New location: {ugLocationLabel(loc)}</p>
        )}
      </div>
      <Textarea
        placeholder="Reason for change (min 10 chars) — required audit log"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        rows={2}
        className="text-xs"
      />
      <Button
        size="sm"
        className="w-full"
        disabled={save.isPending || reason.trim().length < 10}
        onClick={() => save.mutate()}
      >
        {save.isPending ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
        Save landlord changes
      </Button>
    </Card>
  );
}