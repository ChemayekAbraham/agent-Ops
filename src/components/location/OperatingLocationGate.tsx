/**
 * Mandatory operating-location setup for USER dashboards (agents).
 *
 * Shown once, right after login, when the signed-in user has no saved
 * district + village. Dismissal is impossible until a location is saved.
 *
 * Data discipline:
 *  - District list and village search come from the SAME shared ug_* data
 *    layer used everywhere else (no duplicate query logic, cached forever).
 *  - Saving is ONE atomic RPC round trip (`set_my_operating_location`) that
 *    writes district / region / sub-county / parish / village / ug_village_id
 *    onto the existing `profiles` row — no new tables, no follow-up writes.
 */
import { useMemo, useState } from 'react';
import { Check, CheckCircle2, Loader2, MapPin, Plus, Search } from 'lucide-react';
import { Dialog, DialogContent } from '@/components/ui/dialog';
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

export function OperatingLocationGate() {
  const { profile, loading, refreshProfile } = useProfile();
  const [district, setDistrict] = useState<UgDistrictValue | null>(null);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<Picked | null>(null);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);
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
  if (loading || !profile || done) return null;
  if (hasLocation && !saved) return null;

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

  return (
    <Dialog open>
      <DialogContent
        onPointerDownOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
        className="sm:max-w-md p-5 gap-0 rounded-2xl [&>button]:hidden"
      >
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
        <h2 className="text-lg font-semibold">Where do you operate?</h2>
        <p className="mt-1 text-sm text-muted-foreground">Select your main operating location.</p>

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
        </div>
        </>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default OperatingLocationGate;