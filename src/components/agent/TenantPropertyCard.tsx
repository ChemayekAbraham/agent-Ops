/**
 * Current Property card on the tenant profile.
 *
 * The agent may correct the two fields that are frequently captured wrong in
 * the field: HOUSE TYPE (same dropdown as the post-rent-request form) and the
 * ADDRESS (same dataset-backed village search as the post-rent-request form).
 * Landlord and LC1 chairperson details are read-only here — those identities
 * are owned by Landlord Operations, not the agent.
 *
 * Writes go through the `agent_update_tenant_property` RPC only (no direct
 * table mutation, no optimistic math) and the card re-fetches the truth from
 * the parent after the backend confirms.
 */
import { useState } from 'react';
import { Home, MapPin, User, Phone, Pencil, Loader2, ShieldCheck, Landmark } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { UgLocationPicker } from '@/components/location/UgLocationPicker';
import type { UgLocationSelection } from '@/hooks/useUgLocations';
import { useToast } from '@/hooks/use-toast';

/** Same property categories as the post rent request form (residential + commercial). */
export const HOUSE_CATEGORY_OPTIONS = [
  { value: 'single-room', label: 'Single Room' },
  { value: 'double-room', label: 'Double Room' },
  { value: '1-bed', label: '1 Bed House' },
  { value: '2-bed', label: '2 Bedroom House' },
  { value: '2-bed-full', label: '2 Bed + Sitting Room, Kitchen & 2 Toilets' },
  { value: '3-bed', label: '3 Bedroom Apartment' },
  { value: '3-bed-luxury', label: '3 Bed Luxury + Boys Quarter' },
  { value: '4-bed', label: '4+ Bedroom Villa' },
  { value: 'shop', label: 'Shop / Lock-up Shop' },
  { value: 'market-stall', label: 'Market Stall' },
  { value: 'kiosk', label: 'Kiosk / Container' },
  { value: 'salon-workshop', label: 'Salon / Workshop' },
  { value: 'office', label: 'Office Space' },
  { value: 'warehouse', label: 'Warehouse / Store' },
  { value: 'commercial', label: 'Other Commercial Premises' },
];

export function houseCategoryLabel(raw?: string | null): string {
  if (!raw) return 'N/A';
  const normalized = raw.replace(/_/g, '-').toLowerCase();
  return HOUSE_CATEGORY_OPTIONS.find((c) => c.value === normalized)?.label || raw;
}

export interface TenantPropertyLandlord {
  name?: string | null;
  phone?: string | null;
  house_category?: string | null;
  property_address?: string | null;
  village?: string | null;
  sub_county?: string | null;
  district?: string | null;
}

export interface TenantPropertyLc1 {
  name?: string | null;
  phone?: string | null;
  village?: string | null;
  verified?: boolean | null;
}

interface Props {
  /** Rent plan the property belongs to — the RPC authorises against it. */
  requestId: string | null;
  landlord: TenantPropertyLandlord | null;
  lc1: TenantPropertyLc1 | null;
  /** Re-fetch the profile after a confirmed save. */
  onSaved: () => void | Promise<void>;
}

function Field({
  icon: Icon, label, children,
}: { icon: any; label: string; children: React.ReactNode }) {
  return (
    <div className="bg-muted/40 rounded-xl p-3 flex items-start gap-2.5">
      <Icon className="h-5 w-5 text-muted-foreground mt-0.5 shrink-0" />
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground font-medium">{label}</p>
        {children}
      </div>
    </div>
  );
}

export function TenantPropertyCard({ requestId, landlord, lc1, onSaved }: Props) {
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [category, setCategory] = useState('');
  const [place, setPlace] = useState<UgLocationSelection | null>(null);

  const addressLine = [landlord?.village, landlord?.sub_county, landlord?.district]
    .filter((p) => (p || '').trim().length > 0)
    .join(', ') || landlord?.property_address || 'To be confirmed';

  const openEditor = () => {
    setCategory((landlord?.house_category || '').replace(/_/g, '-').toLowerCase());
    setPlace(null);
    setEditing(true);
  };

  const save = async () => {
    if (!requestId) {
      toast({ title: 'Cannot edit', description: 'This tenant has no rent plan with a property record yet.', variant: 'destructive' });
      return;
    }
    if (!category && !place) {
      toast({ title: 'Nothing to save', description: 'Change the house type or pick the village first.' });
      return;
    }
    setSaving(true);
    try {
      const { error } = await supabase.rpc('agent_update_tenant_property' as any, {
        p_request_id: requestId,
        p_house_category: category || null,
        p_village: place?.village ?? null,
        p_sub_county: place ? (place.subcounty || place.county) : null,
        p_district: place?.district ?? null,
        p_ug_village_id: place?.villageId ?? null,
      });
      if (error) throw error;
      toast({ title: 'Property details updated' });
      setEditing(false);
      await onSaved();
    } catch (e: any) {
      toast({ title: 'Update failed', description: e?.message || 'Could not save the property details', variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="rounded-2xl border border-border/60 bg-card p-4 sm:p-5 space-y-4">
      <header className="flex items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 text-base font-bold text-foreground">
          <Home className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
          Current Property
        </h3>
        {!editing && (
          <Button size="sm" variant="outline" onClick={openEditor} disabled={!requestId}>
            <Pencil className="h-3.5 w-3.5 mr-1.5" /> Edit
          </Button>
        )}
      </header>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <Field icon={User} label="Landlord">
          <p className="text-base font-bold truncate">{landlord?.name || 'N/A'}</p>
          <p className="text-[11px] text-muted-foreground">Not editable</p>
        </Field>
        {landlord?.phone && (
          <Field icon={Phone} label="Landlord Phone">
            <a href={`tel:${landlord.phone}`} className="text-base font-bold text-primary break-all">{landlord.phone}</a>
            <p className="text-[11px] text-muted-foreground">Not editable</p>
          </Field>
        )}

        <Field icon={Home} label="House Type">
          <p className="text-base font-bold">{houseCategoryLabel(landlord?.house_category)}</p>
        </Field>
        <Field icon={MapPin} label="Address">
          <p className="text-base font-bold">{addressLine}</p>
        </Field>

        <div className="sm:col-span-2 grid grid-cols-1 sm:grid-cols-2 gap-2">
          <Field icon={Landmark} label="LC1 Chairperson">
            <p className="text-base font-bold truncate">{lc1?.name || 'Not captured'}</p>
            <div className="flex items-center gap-2 mt-0.5">
              {lc1?.verified ? (
                <Badge variant="outline" className="text-[10px] gap-1">
                  <ShieldCheck className="h-3 w-3" /> Verified
                </Badge>
              ) : lc1?.name ? (
                <Badge variant="secondary" className="text-[10px]">Pending verification</Badge>
              ) : null}
              <span className="text-[11px] text-muted-foreground">Not editable</span>
            </div>
          </Field>
          <Field icon={Phone} label="LC1 Phone / Village">
            <p className="text-base font-bold break-all">
              {lc1?.phone ? <a href={`tel:${lc1.phone}`} className="text-primary">{lc1.phone}</a> : '—'}
            </p>
            <p className="text-xs text-muted-foreground truncate">{lc1?.village || '—'}</p>
          </Field>
        </div>
      </div>

      {editing && (
        <div className="rounded-xl border border-primary/30 bg-primary/5 p-3 space-y-3">
          <p className="text-xs text-muted-foreground">
            Correct the house type and the property address. Landlord and LC1 details stay as recorded.
          </p>

          <div className="space-y-1.5">
            <Label className="text-sm font-semibold">House type</Label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger>
                <SelectValue placeholder="Choose the house type" />
              </SelectTrigger>
              <SelectContent>
                {HOUSE_CATEGORY_OPTIONS.map((cat) => (
                  <SelectItem key={cat.value} value={cat.value}>{cat.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <UgLocationPicker
            value={place}
            onChange={setPlace}
            label="Where is the house? Search village"
          />
          {!place && (
            <p className="text-[11px] text-muted-foreground">
              Currently saved: <span className="font-medium">{addressLine}</span> — pick the official village to change it.
            </p>
          )}

          <div className="flex gap-2 pt-1">
            <Button onClick={save} disabled={saving} className="flex-1">
              {saving ? <><Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> Saving…</> : 'Save changes'}
            </Button>
            <Button variant="ghost" onClick={() => setEditing(false)} disabled={saving}>Cancel</Button>
          </div>
        </div>
      )}
    </section>
  );
}

export default TenantPropertyCard;
