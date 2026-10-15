/**
 * Operating-location prompt for USER dashboards (agents).
 *
 * Shown after login when the signed-in user has neither a saved district +
 * village nor a saved GPS fix. It is dismissible: the close button, Esc and an
 * outside click all snooze it for 24 hours, then it returns on the next load.
 * Nothing is prefilled - the user searches and picks their own location, or
 * presses "Use my GPS location". A successful GPS fix is saved to their profile
 * and the prompt is never shown again.
 *
 * Data discipline:
 *  - District list and village search come from the SAME shared ug_* data
 *    layer used everywhere else (no duplicate query logic, cached forever).
 *  - Saving a picked location is ONE atomic RPC round trip
 *    (`set_my_operating_location`). A GPS fix updates the user's own
 *    residence_lat/lng on `profiles`, as ResidenceAddressForm already does.
 */
import { useMemo, useState } from 'react';
import { Check, CheckCircle2, Crosshair, Loader2, MapPin, Plus, Search } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useProfile } from '@/hooks/useProfile';
import UgDistrictSelect, { type UgDistrictValue } from '@/components/location/UgDistrictSelect';
import { useUgVillageSearch, type UgLocationSelection } from '@/hooks/useUgLocations';

type Picked =
  | { source: 'dataset'; village: string; selection: UgLocationSelection }
  | { source: 'custom'; village: string };

const SNOOZE_MS = 24 * 60 * 60 * 1000;
const snoozeKey = (userId: string) => `welile:operating-location-snooze:${userId}`;

// Storage can be blocked (private windows, site data off); fall back to
// "not snoozed" / "dismissed for this session only" rather than throwing.
const isSnoozed = (userId: string) => {
  try {
    const until = Number(localStorage.getItem(snoozeKey(userId)));
    return Number.isFinite(until) && until > Date.now();
  } catch {
    return false;
  }
};
const snooze = (userId: string) => {
  try {
    localStorage.setItem(snoozeKey(userId), String(Date.now() + SNOOZE_MS));
  } catch {
    /* session-only dismissal via component state */
  }
};

const gpsErrorMessage = (err: GeolocationPositionError) =>
  err.code === err.PERMISSION_DENIED
    ? 'Location access is blocked for this site. Search your area below, or allow location in your browser settings and try again.'
    : err.code === err.TIMEOUT
      ? 'Could not get a GPS fix in time. Move to an open area and try again, or search your area below.'
      : 'GPS is unavailable right now. Search your area below.';

export function OperatingLocationGate() {
  const { profile, loading, refreshProfile } = useProfile();
  const [district, setDistrict] = useState<UgDistrictValue | null>(null);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<Picked | null>(null);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [gpsLoading, setGpsLoading] = useState(false);
  const [gpsError, setGpsError] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ district: string; village: string; region: string | null } | null>(null);

  const { data: hits, isFetching } = useUgVillageSearch(district ? query : '', 12, {
    districtId: district?.id ?? null,
  });

  const typed = query.trim();
  const showCustom = useMemo(
    () =>
      typed.length >= 2 &&
      !isFetching &&
      !(hits ?? []).some((h) => h.village.trim().toLowerCase() === typed.toLowerCase()),
    [typed, hits, isFetching],
  );

  const hasLocation = !!(profile?.district?.trim() && profile?.village?.trim());
  const hasGps = typeof profile?.residence_lat === 'number';
  if (loading || !profile || done || dismissed) return null;
  if ((hasLocation || hasGps) && !saved) return null;
  if (!saved && isSnoozed(profile.id)) return null;

  const dismiss = () => {
    snooze(profile.id);
    setDismissed(true);
  };

  const canSave = !!district && !!picked && !saving;

  const save = async () => {
    if (!district || !picked) return;
    setSaving(true);
    const { error } = await supabase.rpc('set_my_operating_location' as any, {
      p_district_id: district.id,
      p_district: district.name,
      p_village: picked.village,
      p_village_id: picked.source === 'dataset' ? picked.selection.villageId : null,
      p_source: picked.source,
    });
    setSaving(false);
    if (error) {
      toast.error(error.message || 'Could not save location');
      return;
    }
    setSaved({ district: district.name, village: picked.village, region: district.region });
    refreshProfile();
  };

  const useGps = () => {
    if (!('geolocation' in navigator)) {
      setGpsError('GPS is not available on this device. Search your area below.');
      return;
    }
    setGpsError(null);
    setGpsLoading(true);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { error } = await supabase
          .from('profiles')
          .update({
            residence_lat: Number(pos.coords.latitude.toFixed(6)),
            residence_lng: Number(pos.coords.longitude.toFixed(6)),
            residence_updated_at: new Date().toISOString(),
          } as any)
          .eq('id', profile.id);
        setGpsLoading(false);
        if (error) {
          setGpsError('Could not save your GPS location. Try again or search your area below.');
          return;
        }
        toast.success('Location saved');
        setDone(true);
        refreshProfile();
      },
      (err) => {
        setGpsLoading(false);
        setGpsError(gpsErrorMessage(err));
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60_000 },
    );
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) { if (saved) setDone(true); else dismiss(); } }}>
      <DialogContent className="sm:max-w-md p-5 gap-0 rounded-2xl">
        {saved ? (
          <div className="py-4 text-center">
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
              <CheckCircle2 className="h-9 w-9 text-primary" />
            </div>
            <h2 className="mt-4 text-lg font-semibold">Setup complete</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Your operating location has been saved.
            </p>

            <div className="mt-5 rounded-xl border bg-muted/40 p-4 text-left space-y-2">
              <div className="flex items-start gap-2">
                <Check className="mt-0.5 h-4 w-4 text-primary shrink-0" />
                <div>
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">District</p>
                  <p className="text-sm font-medium">{saved.district}</p>
                </div>
              </div>
              <div className="flex items-start gap-2">
                <Check className="mt-0.5 h-4 w-4 text-primary shrink-0" />
                <div>
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Village / Area</p>
                  <p className="text-sm font-medium">{saved.village}</p>
                </div>
              </div>
              {saved.region && (
                <div className="flex items-start gap-2">
                  <Check className="mt-0.5 h-4 w-4 text-primary shrink-0" />
                  <div>
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Region</p>
                    <p className="text-sm font-medium">{saved.region}</p>
                  </div>
                </div>
              )}
            </div>

            <Button className="mt-5 w-full h-12 text-base" onClick={() => setDone(true)}>
              Continue to dashboard
            </Button>
          </div>
        ) : (
        <>
        <DialogTitle className="text-lg font-semibold">Where do you operate?</DialogTitle>
        <DialogDescription className="mt-1 text-sm text-muted-foreground">
          Search and select your main operating location. You can also do this later.
        </DialogDescription>

        <div className="mt-5 space-y-4">
          <UgDistrictSelect
            value={district}
            onChange={(d) => {
              setDistrict(d);
              setQuery('');
              setPicked(null);
            }}
          />

          <div className="space-y-1.5">
            <Label className="text-sm flex items-center gap-1">
              <MapPin className="h-3.5 w-3.5 text-primary" /> Village / Area
              <span className="text-destructive">*</span>
            </Label>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                value={picked ? picked.village : query}
                disabled={!district}
                onChange={(e) => {
                  setPicked(null);
                  setQuery(e.target.value);
                }}
                placeholder={district ? 'Search village or area…' : 'Select district first'}
                className="h-12 pl-9 text-base"
                inputMode="search"
                autoComplete="off"
              />
              {isFetching && (
                <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin opacity-60" />
              )}
            </div>

            {!picked && typed.length >= 2 && (
              <div className="mt-1 max-h-56 overflow-y-auto rounded-xl border divide-y">
                {(hits ?? []).map((h) => (
                  <button
                    key={h.villageId}
                    type="button"
                    onClick={() => setPicked({ source: 'dataset', village: h.village, selection: h })}
                    className="w-full text-left px-3 py-3 hover:bg-muted/60 active:bg-muted"
                  >
                    <span className="text-sm font-medium">{h.village}</span>
                    <span className="block text-[11px] text-muted-foreground truncate">{h.fullPath}</span>
                  </button>
                ))}
                {showCustom && (
                  <button
                    type="button"
                    onClick={() => setPicked({ source: 'custom', village: typed })}
                    className="w-full text-left px-3 py-3 hover:bg-muted/60 active:bg-muted flex items-center gap-2"
                  >
                    <Plus className="h-4 w-4 text-primary" />
                    <span className="text-sm">Use “{typed}”</span>
                  </button>
                )}
              </div>
            )}

            {picked?.source === 'custom' && (
              <p className="text-[11px] text-muted-foreground">Saved as your own area name.</p>
            )}
          </div>

          <Button className="w-full h-12 text-base" disabled={!canSave} onClick={save}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save location'}
          </Button>

          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span className="h-px flex-1 bg-border" />or<span className="h-px flex-1 bg-border" />
          </div>

          <Button
            type="button"
            variant="outline"
            className="w-full h-12 text-base"
            disabled={gpsLoading || saving}
            onClick={useGps}
          >
            {gpsLoading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Crosshair className="h-4 w-4 mr-2" />}
            Use my GPS location
          </Button>
          {gpsError && <p role="alert" className="text-xs text-destructive">{gpsError}</p>}
        </div>
        </>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default OperatingLocationGate;