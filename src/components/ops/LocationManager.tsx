import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import {
  MapPin, Plus, Loader2, Search, X, Pencil, Power, PowerOff, Crosshair, Globe,
} from 'lucide-react';
import { toast } from 'sonner';
import { UgDistrictSelect, type UgDistrictValue } from '@/components/location/UgDistrictSelect';
import {
  useUgDistricts, useUgVillageSearch, findUgDistrictByName, type UgLocationSelection,
} from '@/hooks/useUgLocations';

const LOCATION_TYPES = ['town', 'division', 'area', 'cell', 'parish', 'village'] as const;
type LocationType = (typeof LOCATION_TYPES)[number];

/** Types finer than a district may optionally attach the exact sub-county chain. */
const FINE_TYPES: readonly LocationType[] = ['parish', 'village', 'cell', 'division'];

interface ManagedLocation {
  id: string;
  name: string;
  location_type: string;
  district: string | null;
  region: string | null;
  ug_district_id: number | null;
  ug_subcounty_id: number | null;
  ug_parish_id: number | null;
  ug_village_id: number | null;
  latitude: number | null;
  longitude: number | null;
  active: boolean;
  notes: string | null;
  created_at: string;
}

interface FormState {
  name: string;
  location_type: LocationType;
  district: string;
  region: string;
  ugDistrict: UgDistrictValue | null;
  fine: UgLocationSelection | null;
  latitude: string;
  longitude: string;
  notes: string;
}

const EMPTY_FORM: FormState = {
  name: '', location_type: 'town', district: '', region: '',
  ugDistrict: null, fine: null,
  latitude: '', longitude: '', notes: '',
};

export function LocationManager() {
  const [rows, setRows] = useState<ManagedLocation[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [showInactive, setShowInactive] = useState(true);
  const [canManage, setCanManage] = useState(false);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ManagedLocation | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const { data: allDistricts } = useUgDistricts();
  const [fineQuery, setFineQuery] = useState('');
  const fineSearch = useUgVillageSearch(fineQuery, 15, {
    districtId: form.ugDistrict?.id ?? null,
  });
  const showFine = FINE_TYPES.includes(form.location_type) && !!form.ugDistrict;

  const load = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('managed_locations')
      .select('id, name, location_type, district, region, ug_district_id, ug_subcounty_id, ug_parish_id, ug_village_id, latitude, longitude, active, notes, created_at')
      .order('active', { ascending: false })
      .order('name', { ascending: true });
    if (error) {
      toast.error(error.message || 'Could not load locations');
    } else {
      setRows((data ?? []) as ManagedLocation[]);
    }
    setLoading(false);
  };

  useEffect(() => {
    load();
    (async () => {
      const { data: auth } = await supabase.auth.getUser();
      const uid = auth.user?.id;
      if (!uid) return;
      const { data: roles } = await supabase
        .from('user_roles')
        .select('role')
        .eq('user_id', uid)
        .eq('enabled', true);
      const allowed = new Set(['manager', 'super_admin', 'coo', 'operations']);
      setCanManage((roles ?? []).some((r: any) => allowed.has(r.role)));
    })();
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (!showInactive && !r.active) return false;
      if (!q) return true;
      return [r.name, r.district, r.region, r.location_type]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q));
    });
  }, [rows, search, showInactive]);

  const activeCount = rows.filter((r) => r.active).length;

  const openCreate = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setFineQuery('');
    setDialogOpen(true);
  };

  const openEdit = (row: ManagedLocation) => {
    setEditing(row);
    const stored = row.ug_district_id != null
      ? (allDistricts ?? []).find((d) => d.id === row.ug_district_id) ?? null
      : findUgDistrictByName(allDistricts, row.district);
    setForm({
      name: row.name,
      location_type: (LOCATION_TYPES.includes(row.location_type as LocationType)
        ? row.location_type
        : 'town') as LocationType,
      district: row.district ?? '',
      region: row.region ?? '',
      ugDistrict: stored ? { id: stored.id, name: stored.name, region: stored.region ?? null } : null,
      fine: null,
      latitude: row.latitude != null ? String(row.latitude) : '',
      longitude: row.longitude != null ? String(row.longitude) : '',
      notes: row.notes ?? '',
    });
    setFineQuery('');
    setDialogOpen(true);
  };

  const captureGPS = () => {
    if (!navigator.geolocation) {
      toast.error('GPS is not supported on this device');
      return;
    }
    setCapturing(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setForm((f) => ({
          ...f,
          latitude: pos.coords.latitude.toFixed(6),
          longitude: pos.coords.longitude.toFixed(6),
        }));
        setCapturing(false);
        toast.success('GPS coordinates captured');
      },
      () => {
        setCapturing(false);
        toast.error('Could not get GPS. Allow location access and try again.');
      },
      { enableHighAccuracy: true, timeout: 8000 },
    );
  };

  const save = async () => {
    if (!form.name.trim()) {
      toast.error('Enter a location name');
      return;
    }
    if (!form.ugDistrict) {
      toast.error('Select the official district');
      return;
    }
    const lat = form.latitude.trim() ? Number(form.latitude) : null;
    const lng = form.longitude.trim() ? Number(form.longitude) : null;
    if ((lat != null && Number.isNaN(lat)) || (lng != null && Number.isNaN(lng))) {
      toast.error('GPS coordinates must be valid numbers');
      return;
    }
    if (lat != null && (lat < -90 || lat > 90)) {
      toast.error('Latitude must be between -90 and 90');
      return;
    }
    if (lng != null && (lng < -180 || lng > 180)) {
      toast.error('Longitude must be between -180 and 180');
      return;
    }

    // Unique-GPS guard: block reusing the same coordinate pair within the SAME
    // administrative area. Keyed on the official district id, falling back to
    // the stored district/region text for rows that predate the id. Mirrors the
    // database rule and keeps the same warning wording.
    if (lat != null && lng != null) {
      const norm = (v: string | null | undefined) => (v ?? '').trim().toLowerCase();
      const districtName = form.ugDistrict.name;
      const regionName = form.ugDistrict.region ?? '';
      const districtId = form.ugDistrict.id;
      const clash = rows.find(
        (r) =>
          r.id !== editing?.id &&
          r.active &&
          r.latitude != null &&
          r.longitude != null &&
          (r.ug_district_id != null
            ? r.ug_district_id === districtId
            : norm(r.district) === norm(districtName) && norm(r.region) === norm(regionName)) &&
          Math.abs(r.latitude - lat) < 0.00001 &&
          Math.abs(r.longitude - lng) < 0.00001,
      );
      if (clash) {
        const areaLabel =
          [districtName, regionName].filter(Boolean).join(' / ') ||
          'this administrative area';
        toast.error(
          `Those GPS coordinates are already used by "${clash.name}" in ${areaLabel}. Each location in the same area must have unique coordinates.`,
        );
        return;
      }
    }

    setSaving(true);
    const fine = FINE_TYPES.includes(form.location_type) ? form.fine : null;
    const payload = {
      name: form.name.trim(),
      location_type: form.location_type,
      // Text columns stay populated exactly as before; the ids are additive.
      district: form.ugDistrict.name,
      region: form.ugDistrict.region ?? null,
      ug_district_id: form.ugDistrict.id,
      ug_subcounty_id: fine ? fine.subcountyId : null,
      ug_parish_id: fine ? fine.parishId : null,
      ug_village_id: fine ? fine.villageId : null,
      latitude: lat,
      longitude: lng,
      notes: form.notes.trim() || null,
    };

    if (editing) {
      const { error } = await supabase
        .from('managed_locations')
        .update(payload)
        .eq('id', editing.id);
      setSaving(false);
      if (error) {
        toast.error(error.message || 'Could not update location');
        return;
      }
      toast.success('Location updated');
    } else {
      const { data: auth } = await supabase.auth.getUser();
      const { error } = await supabase
        .from('managed_locations')
        .insert({ ...payload, created_by: auth.user?.id ?? null });
      setSaving(false);
      if (error) {
        toast.error(error.message || 'Could not create location');
        return;
      }
      toast.success('Location created');
    }
    setDialogOpen(false);
    load();
  };

  const toggleActive = async (row: ManagedLocation) => {
    const { error } = await supabase
      .from('managed_locations')
      .update({ active: !row.active })
      .eq('id', row.id);
    if (error) {
      toast.error(error.message || 'Could not update status');
      return;
    }
    toast.success(row.active ? 'Location deactivated' : 'Location reactivated');
    setRows((prev) =>
      prev.map((r) => (r.id === row.id ? { ...r, active: !r.active } : r)),
    );
  };

  return (
    <div className="space-y-3">
      <Card className="p-3 flex flex-wrap items-center gap-2 bg-muted/20">
        <Globe className="h-4 w-4 text-primary shrink-0" />
        <span className="text-sm font-semibold">Location Management</span>
        <Badge variant="secondary" className="text-[10px]">{rows.length} total</Badge>
        <Badge className="text-[10px] bg-success/15 text-success border-transparent">
          {activeCount} active
        </Badge>
        <div className="ml-auto">
          {canManage ? (
            <Button size="sm" onClick={openCreate} className="h-8 gap-1.5">
              <Plus className="h-4 w-4" /> Add location
            </Button>
          ) : (
            <span className="text-[11px] text-muted-foreground">View only — ops role required to edit</span>
          )}
        </div>
      </Card>

      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search towns, divisions, districts…"
            className="pl-8 pr-8 h-9"
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              aria-label="Clear search"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        <Button
          size="sm"
          variant={showInactive ? 'default' : 'outline'}
          onClick={() => setShowInactive((v) => !v)}
          className="h-9 text-[11px] shrink-0"
        >
          {showInactive ? 'Showing inactive' : 'Hiding inactive'}
        </Button>
      </div>

      {loading ? (
        <div className="flex justify-center py-10">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : filtered.length === 0 ? (
        <Card className="p-8 text-center text-sm text-muted-foreground">
          No locations yet. {canManage && 'Tap “Add location” to create the first one.'}
        </Card>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {filtered.map((row) => (
            <Card
              key={row.id}
              className={`p-3 ${row.active ? '' : 'opacity-60 bg-muted/30'}`}
            >
              <div className="flex items-start gap-2">
                <MapPin className={`h-4 w-4 mt-0.5 shrink-0 ${row.active ? 'text-primary' : 'text-muted-foreground'}`} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-sm font-semibold truncate">{row.name}</span>
                    <Badge variant="outline" className="text-[9px] capitalize">{row.location_type}</Badge>
                    {!row.active && (
                      <Badge variant="secondary" className="text-[9px]">Inactive</Badge>
                    )}
                  </div>
                  <p className="text-[11px] text-muted-foreground truncate">
                    {[row.district, row.region].filter(Boolean).join(' · ') || 'No district/region'}
                  </p>
                  <p className="text-[10px] text-muted-foreground font-mono mt-0.5">
                    {row.latitude != null && row.longitude != null
                      ? `${row.latitude.toFixed(5)}, ${row.longitude.toFixed(5)}`
                      : 'No GPS set'}
                  </p>
                </div>
                {canManage && (
                  <div className="flex flex-col gap-1 shrink-0">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      onClick={() => openEdit(row)}
                      title="Edit"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className={`h-7 w-7 ${row.active ? 'text-destructive' : 'text-success'}`}
                      onClick={() => toggleActive(row)}
                      title={row.active ? 'Deactivate' : 'Reactivate'}
                    >
                      {row.active ? <PowerOff className="h-3.5 w-3.5" /> : <Power className="h-3.5 w-3.5" />}
                    </Button>
                  </div>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit location' : 'Add location'}</DialogTitle>
            <DialogDescription>
              Create a town, division or area with its own unique GPS coordinates.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div>
              <Label className="text-sm">Name *</Label>
              <Input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="e.g. Bweyogerere"
                className="h-10"
              />
            </div>
            <div>
              <Label className="text-sm">Type</Label>
              <Select
                value={form.location_type}
                onValueChange={(v) => setForm((f) => ({
                  ...f,
                  location_type: v as LocationType,
                  fine: FINE_TYPES.includes(v as LocationType) ? f.fine : null,
                }))}
              >
                <SelectTrigger className="h-10"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {LOCATION_TYPES.map((t) => (
                    <SelectItem key={t} value={t} className="capitalize">{t}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <UgDistrictSelect
              value={form.ugDistrict}
              onChange={(v) => setForm((f) => ({
                ...f,
                ugDistrict: v,
                district: v?.name ?? f.district,
                region: v?.region ?? '',
                fine: null,
              }))}
              required
              legacyText={form.district}
            />

            {showFine && (
              <div>
                <Label className="text-sm">
                  Sub-county / parish / village <span className="text-muted-foreground">(optional)</span>
                </Label>
                {form.fine ? (
                  <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-2.5 py-2 mt-1">
                    <MapPin className="h-3.5 w-3.5 text-primary shrink-0" />
                    <span className="text-[11px] flex-1 truncate">
                      {form.fine.village}, {form.fine.parish}, {form.fine.subcounty}
                    </span>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-6 w-6"
                      onClick={() => setForm((f) => ({ ...f, fine: null }))}
                      title="Clear"
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ) : (
                  <>
                    <Input
                      value={fineQuery}
                      onChange={(e) => setFineQuery(e.target.value)}
                      placeholder={`Search a village in ${form.ugDistrict?.name}`}
                      className="h-10 mt-1"
                    />
                    {fineSearch.isFetching && (
                      <p className="text-[11px] text-muted-foreground mt-1 flex items-center gap-1">
                        <Loader2 className="h-3 w-3 animate-spin" /> Searching…
                      </p>
                    )}
                    {(fineSearch.data ?? []).length > 0 && (
                      <div className="mt-1 max-h-40 overflow-y-auto rounded-md border border-border divide-y divide-border">
                        {(fineSearch.data ?? []).map((s) => (
                          <button
                            key={s.villageId}
                            type="button"
                            onClick={() => { setForm((f) => ({ ...f, fine: s })); setFineQuery(''); }}
                            className="w-full text-left px-2.5 py-1.5 text-[11px] hover:bg-muted"
                          >
                            <span className="font-medium">{s.village}</span>
                            <span className="text-muted-foreground"> · {s.parish}, {s.subcounty}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
            <div>
              <div className="flex items-center justify-between">
                <Label className="text-sm">GPS coordinates</Label>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={captureGPS}
                  disabled={capturing}
                  className="h-7 text-[11px] gap-1"
                >
                  {capturing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Crosshair className="h-3.5 w-3.5" />}
                  Use my GPS
                </Button>
              </div>
              <div className="grid grid-cols-2 gap-3 mt-1">
                <Input
                  value={form.latitude}
                  onChange={(e) => setForm((f) => ({ ...f, latitude: e.target.value }))}
                  placeholder="Latitude"
                  inputMode="decimal"
                  className="h-10"
                />
                <Input
                  value={form.longitude}
                  onChange={(e) => setForm((f) => ({ ...f, longitude: e.target.value }))}
                  placeholder="Longitude"
                  inputMode="decimal"
                  className="h-10"
                />
              </div>
              <p className="text-[11px] text-muted-foreground mt-1">
                Each location must have unique coordinates.
              </p>
            </div>
            <div>
              <Label className="text-sm">Notes</Label>
              <Input
                value={form.notes}
                onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                placeholder="Optional"
                className="h-10"
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : (editing ? 'Save changes' : 'Create location')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default LocationManager;