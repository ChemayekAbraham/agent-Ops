import { useState, useEffect, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { MapPin, Loader2, Save, Crosshair } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import UgLocationPicker from '@/components/location/UgLocationPicker';
import { resolveUgVillage, type UgLocationSelection } from '@/hooks/useUgLocations';

interface AddressData {
  region?: string | null;
  district?: string | null;
  sub_county?: string | null;
  parish?: string | null;
  village?: string | null;
  landmark?: string | null;
  residence_lat?: number | null;
  residence_lng?: number | null;
  ug_village_id?: number | null;
}

interface Props {
  userId: string;
  /** Called by managing agents acting on a managed user. Adds an audit log entry. */
  actingAsAgent?: boolean;
  /** Initial values; if omitted, the form fetches from profiles. */
  initial?: AddressData;
  onSaved?: (data: AddressData) => void;
}

export default function ResidenceAddressForm({ userId, actingAsAgent, initial, onSaved }: Props) {
  const [loading, setLoading] = useState(!initial);
  const [saving, setSaving] = useState(false);
  const [data, setData] = useState<AddressData>(initial || {});
  const [pinningGps, setPinningGps] = useState(false);
  const [selection, setSelection] = useState<UgLocationSelection | null>(null);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [clearedSaved, setClearedSaved] = useState(false);

  useEffect(() => {
    if (initial) return;
    (async () => {
      const { data: row } = await supabase
        .from('profiles')
        .select('region, district, sub_county, parish, village, landmark, residence_lat, residence_lng, ug_village_id')
        .eq('id', userId)
        .maybeSingle();
      if (row) setData(row as AddressData);
      setLoading(false);
    })();
  }, [userId, initial]);

  // Rebuild the picker selection from a previously saved official village id
  // so the saved location shows as a confirmed pick (cross-device).
  useEffect(() => {
    const id = data.ug_village_id;
    if (!id || selection) return;
    let cancelled = false;
    resolveUgVillage(id)
      .then((sel) => { if (!cancelled && sel) setSelection(sel); })
      .catch(() => { /* fall back to the stored names below */ });
    return () => { cancelled = true; };
  }, [data.ug_village_id, selection]);

  // Legacy rows saved before the picker existed only have typed names.
  const savedLabel = useMemo(() => {
    return [data.village, data.parish, data.sub_county, data.district, data.region]
      .map((v) => (v || '').trim())
      .filter(Boolean)
      .join(', ');
  }, [data.village, data.parish, data.sub_county, data.district, data.region]);

  const hasLegacySaved = !!savedLabel && !data.ug_village_id && !clearedSaved;
  const locationValid = !!selection || hasLegacySaved;

  const update = (key: keyof AddressData, value: string | number | null) => {
    setData(prev => ({ ...prev, [key]: value }));
  };

  const captureGps = () => {
    if (!('geolocation' in navigator)) {
      toast.error('GPS not available on this device');
      return;
    }
    setPinningGps(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        update('residence_lat', Number(pos.coords.latitude.toFixed(6)));
        update('residence_lng', Number(pos.coords.longitude.toFixed(6)));
        setPinningGps(false);
        toast.success('GPS captured');
      },
      (err) => {
        setPinningGps(false);
        toast.error(err.message || 'Failed to capture GPS');
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  };

  const save = async () => {
    setSaveError(null);
    if (!locationValid) {
      setLocationError('Select your official village to save your address.');
      return;
    }
    setLocationError(null);
    setSaving(true);
    const payload: Record<string, unknown> = {
      region: selection ? selection.region : data.region?.trim() || null,
      district: selection ? selection.district : data.district?.trim() || null,
      sub_county: selection ? selection.subcounty : data.sub_county?.trim() || null,
      parish: selection ? selection.parish : data.parish?.trim() || null,
      village: selection ? selection.village : data.village?.trim() || null,
      ug_village_id: selection ? selection.villageId : data.ug_village_id ?? null,
      landmark: data.landmark?.trim() || null,
      residence_lat: data.residence_lat ?? null,
      residence_lng: data.residence_lng ?? null,
      residence_updated_at: new Date().toISOString(),
    };
    const { error } = await supabase.from('profiles').update(payload as any).eq('id', userId);
    if (error) {
      setSaveError(error.message);
      toast.error('Failed to save address: ' + error.message);
      setSaving(false);
      return;
    }
    if (actingAsAgent) {
      const { data: { user: actor } } = await supabase.auth.getUser();
      if (actor) {
        await supabase.from('agent_managed_user_actions').insert({
          agent_id: actor.id,
          user_id: userId,
          action_type: 'address_updated',
          details: payload as any,
        });
      }
    }
    setData(prev => ({ ...prev, ...(payload as AddressData) }));
    setClearedSaved(false);
    toast.success('Address saved');
    onSaved?.(payload as AddressData);
    setSaving(false);
  };

  if (loading) {
    return (
      <Card className="border-border/40 rounded-2xl">
        <CardContent className="py-8 flex justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-border/40 rounded-2xl">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <MapPin className="h-4 w-4 text-primary" /> Residence Address
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <UgLocationPicker
          label="Official location (village)"
          required
          value={selection}
          error={locationError}
          onChange={(sel) => {
            setSelection(sel);
            setLocationError(null);
            if (!sel) setClearedSaved(true);
          }}
        />

        {!selection && hasLegacySaved && (
          <p className="text-[11px] text-muted-foreground">
            Saved address: <span className="font-medium text-foreground">{savedLabel}</span> — pick it again above to
            link it to the official village list.
          </p>
        )}

        <Field label="Landmark" value={data.landmark} onChange={(v) => update('landmark', v)} placeholder="e.g. near SDA Church" />

        <div className="space-y-2 p-3 rounded-xl bg-muted/30 border border-border/50">
          <div className="flex items-center justify-between">
            <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">GPS Pin (optional)</Label>
            <Button type="button" size="sm" variant="outline" onClick={captureGps} disabled={pinningGps} className="rounded-lg gap-1.5 text-xs h-8">
              {pinningGps ? <Loader2 className="h-3 w-3 animate-spin" /> : <Crosshair className="h-3 w-3" />}
              {data.residence_lat ? 'Re-capture' : 'Capture GPS'}
            </Button>
          </div>
          {data.residence_lat && data.residence_lng ? (
            <p className="text-xs text-muted-foreground font-mono">
              {data.residence_lat.toFixed(5)}, {data.residence_lng.toFixed(5)}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">No pin saved</p>
          )}
        </div>

        {saveError && <p className="text-[11px] text-destructive">Could not save: {saveError}</p>}

        <Button onClick={save} disabled={saving || !locationValid} className="w-full gap-2 h-11 rounded-xl text-sm font-bold">
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Save Address
        </Button>
      </CardContent>
    </Card>
  );
}

function Field({ label, value, onChange, placeholder }: { label: string; value: string | null | undefined; onChange: (v: string) => void; placeholder?: string; }) {
  return (
    <div className="space-y-1">
      <Label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">{label}</Label>
      <Input value={value || ''} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="h-10 rounded-xl text-sm" />
    </div>
  );
}
