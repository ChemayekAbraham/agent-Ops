import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Separator } from '@/components/ui/separator';
import { toast } from 'sonner';
import {
  User, Home, UserCheck, MapPin, Loader2, Link2, Plus, Phone,
  Wallet, ShieldAlert, Building2, ReceiptText, Smartphone, SmartphoneNfc,
  Search, Pencil, X, TrendingUp, Users, Sparkles, Download, FileText,
  ChevronRight, ChevronLeft, ArrowLeft, MessageSquare, StickyNote, CheckCircle2, XCircle,
  CalendarIcon, Info, AlertTriangle, RefreshCw, Filter, ArrowLeftRight,
} from 'lucide-react';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { useAuth } from '@/hooks/useAuth';
import { UserSearchPicker } from '@/components/cfo/UserSearchPicker';
import UgLocationPicker from '@/components/location/UgLocationPicker';
import { resolveUgVillage, resolveUgVillageByNames, type UgLocationSelection } from '@/hooks/useUgLocations';
import PersonNameFields from '@/components/shared/PersonNameFields';
import { joinPersonName, splitPersonName, validatePersonNameParts, type PersonNameParts } from '@/lib/authValidation';
import { Switch } from '@/components/ui/switch';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { format, parseISO, startOfDay, endOfDay, startOfMonth, endOfMonth } from 'date-fns';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { useRentPaymentStatusMutation } from '@/hooks/useRentPaymentStatusMutation';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { ListingPhotoUploadDialog } from './ListingPhotoUploadDialog';
import { ImagePlus } from 'lucide-react';
import { ContactActions } from './ContactActions';
import { LandlordEditCard } from './LandlordEditCard';
import { LandlordChangeHistory } from './LandlordChangeHistory';
import { TenantLandlordPayoutsEditor } from './TenantLandlordPayoutsEditor';
import { PaymentPeriodControl } from './PaymentPeriodControl';
import LandlordAgreementHistory from '@/components/landlord/agreement/LandlordAgreementHistory';

type UserBrief = { id: string; full_name: string | null; phone: string | null };

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  tenantId?: string | null;
  agentId?: string | null;
  /** landlords.id (NOT auth user) — landlords live in their own table */
  landlordId?: string | null;
  defaultTab?: 'tenant' | 'agent' | 'landlord';
}

const fmtUGX = (n: number | string | null | undefined) =>
  `UGX ${Number(n ?? 0).toLocaleString()}`;

function useIsOpsRole(): boolean {
  const { user } = useAuth() as any;
  const { data } = useQuery({
    queryKey: ['is-ops-role', user?.id],
    enabled: !!user?.id,
    queryFn: async () => {
      const { data } = await supabase
        .from('user_roles')
        .select('role')
        .eq('user_id', user!.id)
        .eq('enabled', true);
      const roles = (data ?? []).map((r: any) => r.role);
      return roles.some((r) => ['manager', 'super_admin', 'coo', 'operations'].includes(r));
    },
    staleTime: 60_000,
  });
  return !!data;
}

export function UserDrilldownDrawer({
  open, onOpenChange, tenantId, agentId, landlordId, defaultTab = 'landlord',
}: Props) {
  const [tab, setTab] = useState<'tenant' | 'agent' | 'landlord'>(defaultTab);
  // Global "open any user" — overrides tenantId when a user is picked
  const [pickedUser, setPickedUser] = useState<UserBrief | null>(null);
  const effectiveTenantId = pickedUser?.id ?? tenantId ?? null;
  // Allow in-drawer navigation to a landlord (e.g. tap a name in the
  // agent's "Linked landlords" list). Overrides the landlordId prop.
  const [pickedLandlordId, setPickedLandlordId] = useState<string | null>(null);
  const effectiveLandlordId = pickedLandlordId ?? landlordId ?? null;
  const isOps = useIsOpsRole();
  const scrollRef = useRef<HTMLDivElement>(null);
  // Track where the user came from so the tenant pane can show "← Back to agent"
  const [cameFromAgent, setCameFromAgent] = useState(false);

  // Reset transient drawer state whenever the drawer is opened OR the
  // target IDs change. Without this, opening the drawer for agent B
  // after previously drilling into a tenant under agent A would keep
  // the old pickedUser/pickedLandlord/tab and show the wrong person
  // (e.g. "every agent dashboard shows Namuli Oliver").
  useEffect(() => {
    if (!open) return;
    setPickedUser(null);
    setPickedLandlordId(null);
    setCameFromAgent(false);
    setTab(defaultTab);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tenantId, agentId, landlordId]);

  const handleSelectTenant = (id: string, name: string) => {
    setPickedUser({ id, full_name: name, phone: null });
    setTab('tenant');
    setCameFromAgent(true);
    // Scroll the drawer back to the top so the freshly-loaded tenant
    // profile is visible immediately instead of leaving the user on the
    // (now-hidden) Tenants-under-management section.
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
    });
  };

  const handleSelectLandlord = (id: string) => {
    setPickedLandlordId(id);
    setTab('landlord');
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
    });
  };

  // Open any user (e.g. the counterpart of a wallet transfer) in the
  // Tenant pane, which now shows their profile + full wallet buckets.
  const handleSelectUser = (id: string, name: string) => {
    setPickedUser({ id, full_name: name, phone: null });
    setTab('tenant');
    setCameFromAgent(false);
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
    });
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        ref={scrollRef as any}
        side="right"
        className="w-screen h-screen max-w-none sm:max-w-none overflow-y-auto p-0"
      >
        <SheetHeader className="px-4 sm:px-6 pt-5 pb-3 border-b">
          <SheetTitle className="text-lg">User drill-down</SheetTitle>
          <SheetDescription className="text-xs">
            Edit location, balances and linkages for every party in this rent flow.
            All changes are audited.
          </SheetDescription>
        </SheetHeader>

        {isOps && (
          <div className="px-4 sm:px-6 pt-3 pb-1 border-b bg-muted/20">
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground mb-1">
              <Search className="h-3 w-3" /> Find any user — tenant, agent, landlord, funder, anyone
            </div>
            <UserSearchPicker
              label=""
              placeholder="Search by name or phone (any country, any agent, any town)"
              selectedUser={pickedUser as any}
              onSelect={(u) => { setPickedUser(u as any); if (u) setTab('tenant'); }}
            />
          </div>
        )}

        <Tabs value={tab} onValueChange={(v) => setTab(v as any)} className="px-4 sm:px-6 pt-3">
          <TabsList className="grid grid-cols-3 w-full">
            <TabsTrigger value="tenant" disabled={!effectiveTenantId}>
              <User className="h-3.5 w-3.5 mr-1" /> Tenant
            </TabsTrigger>
            <TabsTrigger value="agent" disabled={!agentId}>
              <UserCheck className="h-3.5 w-3.5 mr-1" /> Agent
            </TabsTrigger>
            <TabsTrigger value="landlord" disabled={!effectiveLandlordId}>
              <Home className="h-3.5 w-3.5 mr-1" /> Landlord
            </TabsTrigger>
          </TabsList>

          <TabsContent value="tenant" className="py-4">
            {effectiveTenantId && (
              <TenantPane
                tenantId={effectiveTenantId}
                isOps={isOps}
                onBackToAgent={cameFromAgent && agentId ? () => { setTab('agent'); scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' }); } : undefined}
                onSelectLandlord={handleSelectLandlord}
                onSelectUser={handleSelectUser}
              />
            )}
          </TabsContent>
          <TabsContent value="agent" className="py-4">
            {agentId && <AgentPane agentId={agentId} isOps={isOps} onSelectTenant={handleSelectTenant} onSelectLandlord={handleSelectLandlord} onSelectUser={handleSelectUser} />}
          </TabsContent>
          <TabsContent value="landlord" className="py-4">
            {effectiveLandlordId && <LandlordPane landlordId={effectiveLandlordId} isOps={isOps} />}
          </TabsContent>
        </Tabs>
      </SheetContent>
    </Sheet>
  );
}

/* ------------------------------------------------------------------ */
/* Profile (tenant/agent) shared header + location editor              */
/* ------------------------------------------------------------------ */
function useProfile(id: string) {
  return useQuery({
    queryKey: ['drilldown-profile', id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('profiles')
        .select(
          'id, full_name, phone, avatar_url, ops_note, continent, country, region, district, city, town, sub_county, parish, village, landmark, residence_lat, residence_lng, address_complete, has_smartphone, ug_village_id',
        )
        .eq('id', id)
        .maybeSingle();
      if (error) throw error;
      return data as any;
    },
    enabled: !!id,
  });
}

function useUserRoles(id: string) {
  return useQuery({
    queryKey: ['drilldown-roles', id],
    queryFn: async () => {
      const { data } = await supabase
        .from('user_roles').select('role, enabled').eq('user_id', id).eq('enabled', true);
      return (data ?? []).map((r: any) => r.role as string);
    },
    enabled: !!id,
  });
}

function ProfileHeader({
  profile, roles, userId, canEdit,
}: { profile: any; roles: string[]; userId?: string; canEdit?: boolean }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  // Captured in parts; the RPC keeps receiving one concatenated string.
  const [nameParts, setNameParts] = useState<PersonNameParts>(splitPersonName(profile?.full_name ?? ''));
  const name = joinPersonName(nameParts);
  const [phone, setPhone] = useState<string>(profile?.phone ?? '');
  const [avatarUrl, setAvatarUrl] = useState<string>(profile?.avatar_url ?? '');
  const [opsNote, setOpsNote] = useState<string>(profile?.ops_note ?? '');
  const [reason, setReason] = useState('');

  const save = useMutation({
    mutationFn: async () => {
      if (!userId) throw new Error('Missing user');
      if (reason.trim().length < 10) throw new Error('Reason must be ≥ 10 characters');
      const nameCheck = validatePersonNameParts(nameParts);
      if (!nameCheck.valid) throw new Error(nameCheck.error || 'Enter first and last name');
      const { error } = await supabase.rpc('ops_update_user_identity', {
        p_user_id: userId,
        p_full_name: name,
        p_phone: phone,
        p_reason: reason.trim(),
        p_avatar_url: avatarUrl,
        p_ops_note: opsNote,
      } as any);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Profile updated');
      qc.invalidateQueries({ queryKey: ['drilldown-profile', userId] });
      setEditing(false); setReason('');
    },
    onError: (e: any) => toast.error(e.message ?? 'Update failed'),
  });

  return (
    <div className="space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex items-start gap-3">
          <Avatar className="h-12 w-12 ring-2 ring-primary/20 shrink-0">
            <AvatarImage src={profile?.avatar_url ?? undefined} alt={profile?.full_name ?? 'User'} />
            <AvatarFallback className="text-sm font-semibold">
              {(profile?.full_name ?? 'U').slice(0, 2).toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-base font-semibold truncate">
              {profile?.full_name ?? 'Unnamed user'}
            </span>
            {canEdit && !editing && (
              <Button size="sm" variant="outline" className="h-7 px-2" onClick={() => setEditing(true)}>
                <Pencil className="h-3 w-3 mr-1" /> Edit
              </Button>
            )}
          </div>
          <div className="flex items-center gap-2 flex-wrap mt-0.5">
            <span className="text-xs text-muted-foreground font-mono">
              {profile?.phone ?? '— no phone —'}
            </span>
            <ContactActions
              phone={profile?.phone}
              size="xs"
              message={`Hello ${profile?.full_name ?? ''}, this is Welile Ops.`}
            />
          </div>
          {profile?.ops_note && !editing && (
            <p className="text-[11px] mt-1 text-amber-700 bg-amber-50 dark:bg-amber-950 dark:text-amber-300 border border-amber-200 dark:border-amber-900 rounded px-1.5 py-0.5">
              <StickyNote className="h-3 w-3 inline mr-1" />{profile.ops_note}
            </p>
          )}
          </div>
        </div>
        <div className="flex flex-wrap gap-1 justify-end">
          {roles.length === 0 && <Badge variant="outline" className="text-[10px]">no role</Badge>}
          {roles.map((r) => (
            <Badge key={r} variant="outline" className="text-[10px] capitalize">{r}</Badge>
          ))}
        </div>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Dashboards accessible: <span className="font-medium text-foreground">
          {roles.length ? roles.map((r) => r.replace('_', ' ')).join(', ') : 'none'}
        </span>
      </p>
      {canEdit && editing && (
        <Card className="p-3 space-y-2 border-primary/40">
          <div className="flex items-center justify-between">
            <div className="text-xs font-medium flex items-center gap-1">
              <Pencil className="h-3 w-3" /> Edit identity
            </div>
            <Button size="sm" variant="ghost" className="h-6 px-1" onClick={() => setEditing(false)}>
              <X className="h-3 w-3" />
            </Button>
          </div>
          <div>
            <Label className="text-[10px] uppercase text-muted-foreground">Full name</Label>
            <PersonNameFields idPrefix="drilldown-identity" value={nameParts} onChange={setNameParts} />
          </div>
          <div>
            <Label className="text-[10px] uppercase text-muted-foreground">Phone</Label>
            <Input value={phone} onChange={(e) => setPhone(e.target.value)} className="h-8 text-sm" />
          </div>
          <div>
            <Label className="text-[10px] uppercase text-muted-foreground">Avatar URL</Label>
            <Input value={avatarUrl} onChange={(e) => setAvatarUrl(e.target.value)} className="h-8 text-sm" placeholder="https://…" />
          </div>
          <div>
            <Label className="text-[10px] uppercase text-muted-foreground">Ops note (internal)</Label>
            <Textarea value={opsNote} onChange={(e) => setOpsNote(e.target.value)} className="text-xs" rows={2} placeholder="Visible only to ops staff" />
          </div>
          <Textarea
            placeholder="Reason for change (min 10 chars)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="text-xs"
            rows={2}
          />
          <Button
            size="sm" className="w-full"
            disabled={save.isPending || reason.trim().length < 10}
            onClick={() => save.mutate()}
          >
            {save.isPending ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
            Save changes
          </Button>
        </Card>
      )}
    </div>
  );
}

function LocationEditor({
  userId, profile, canEdit,
}: { userId: string; profile: any; canEdit: boolean }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    country: profile?.country ?? 'Uganda',
    landmark: profile?.landmark ?? '',
  });
  // Official Uganda location comes from the shared picker only — the old
  // free-text region/district/sub-county/parish/village inputs are gone.
  const [selection, setSelection] = useState<UgLocationSelection | null>(null);
  const [resolving, setResolving] = useState(true);
  const savedLabel = [profile?.village, profile?.parish, profile?.sub_county, profile?.district, profile?.region]
    .map((v: any) => (v || '').trim()).filter(Boolean).join(', ');

  useEffect(() => {
    let cancelled = false;
    setResolving(true);
    (async () => {
      try {
        const sel = profile?.ug_village_id
          ? await resolveUgVillage(profile.ug_village_id)
          : await resolveUgVillageByNames(profile?.village, profile?.district);
        if (!cancelled && sel) setSelection(sel);
      } catch {
        /* keep the stored names as read-only context */
      } finally {
        if (!cancelled) setResolving(false);
      }
    })();
    return () => { cancelled = true; };
  }, [profile?.ug_village_id, profile?.village, profile?.district]);

  const [hasSmartphone, setHasSmartphone] = useState<boolean>(
    profile?.has_smartphone ?? true,
  );
  const [gps, setGps] = useState<{ lat: number | null; lng: number | null; acc: number | null }>(
    { lat: profile?.residence_lat ?? null, lng: profile?.residence_lng ?? null, acc: null },
  );
  const [reason, setReason] = useState('');
  const [capturing, setCapturing] = useState(false);

  const captureGps = () => {
    if (!navigator.geolocation) {
      toast.error('Geolocation not supported on this device');
      return;
    }
    setCapturing(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGps({ lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy });
        setCapturing(false);
        toast.success('GPS captured');
      },
      (err) => { setCapturing(false); toast.error(err.message || 'GPS failed'); },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
    );
  };

  const save = useMutation({
    mutationFn: async () => {
      if (reason.trim().length < 10) throw new Error('Reason must be ≥ 10 characters');
      // Only send what actually changed. The RPC COALESCEs missing keys, so
      // omitting the administrative chain leaves the stored values untouched.
      const address: Record<string, any> = {};
      if ((form.country ?? '') !== (profile?.country ?? '')) address.country = form.country;
      if ((form.landmark ?? '') !== (profile?.landmark ?? '')) address.landmark = form.landmark;
      if (selection && selection.villageId !== (profile?.ug_village_id ?? null)) {
        address.region = selection.region ?? '';
        address.district = selection.district;
        address.sub_county = selection.subcounty;
        address.parish = selection.parish;
        address.village = selection.village;
        address.ug_village_id = String(selection.villageId);
      }
      const { data, error } = await supabase.rpc('ops_update_user_location', {
        p_user_id: userId,
        p_address: address as any,
        p_latitude: gps.lat,
        p_longitude: gps.lng,
        p_accuracy: gps.acc,
        p_reason: reason.trim(),
        p_has_smartphone: hasSmartphone,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      toast.success('Profile updated');
      qc.invalidateQueries({ queryKey: ['drilldown-profile', userId] });
      setReason('');
    },
    onError: (e: any) => toast.error(e?.message || String(e)),
  });

  return (
    <Card className="p-3 space-y-3">
      <div className="flex items-center gap-2 text-sm font-medium">
        <MapPin className="h-4 w-4 text-primary" /> Location
        {!profile?.address_complete && (
          <Badge className="text-[10px] bg-amber-100 text-amber-700 border-amber-200">Incomplete</Badge>
        )}
      </div>
      {resolving ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" /> Loading saved location…
        </div>
      ) : canEdit ? (
        <UgLocationPicker
          label="Official location (village)"
          value={selection}
          onChange={(sel) => setSelection(sel)}
        />
      ) : (
        <div>
          <Label className="text-[10px] uppercase text-muted-foreground">Official location</Label>
          <p className="text-sm">{selection ? selection.fullPath : savedLabel || '—'}</p>
        </div>
      )}

      {!resolving && !selection && savedLabel && (
        <p className="text-[11px] text-muted-foreground">
          Saved (unmatched) address: <span className="font-medium text-foreground">{savedLabel}</span> — pick the
          official village above to update it.
        </p>
      )}

      <div>
        <Label className="text-[10px] uppercase text-muted-foreground">Country</Label>
        <Input
          value={form.country}
          onChange={(e) => setForm({ ...form, country: e.target.value })}
          disabled={!canEdit}
          className="h-8 text-sm"
        />
      </div>
      <div>
        <Label className="text-[10px] uppercase text-muted-foreground">Landmark</Label>
        <Input
          value={form.landmark}
          onChange={(e) => setForm({ ...form, landmark: e.target.value })}
          disabled={!canEdit}
          className="h-8 text-sm"
        />
      </div>
      <div className="flex items-center justify-between gap-2 rounded-md bg-muted/30 px-2 py-1.5 text-xs">
        <span className="text-muted-foreground">
          GPS: {gps.lat != null ? `${gps.lat.toFixed(5)}, ${gps.lng?.toFixed(5)}` : '—'}
          {gps.acc != null && <> · ±{Math.round(gps.acc)}m</>}
        </span>
        {canEdit && (
          <Button size="sm" variant="outline" className="h-7" onClick={captureGps} disabled={capturing}>
            {capturing ? <Loader2 className="h-3 w-3 animate-spin" /> : <MapPin className="h-3 w-3" />}
            <span className="ml-1">Capture</span>
          </Button>
        )}
      </div>
      <div className="flex items-center justify-between gap-2 rounded-md border border-border px-2 py-1.5">
        <div className="flex items-center gap-2 text-xs">
          {hasSmartphone ? <Smartphone className="h-3.5 w-3.5 text-emerald-600" /> : <SmartphoneNfc className="h-3.5 w-3.5 text-amber-600" />}
          <span className="font-medium">
            {hasSmartphone ? 'Has a smartphone' : 'No smartphone (USSD / agent-led)'}
          </span>
        </div>
        <Switch checked={hasSmartphone} onCheckedChange={setHasSmartphone} disabled={!canEdit} />
      </div>
      {canEdit && (
        <>
          <Textarea
            placeholder="Reason for change (min 10 chars)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="text-xs"
            rows={2}
          />
          <Button
            size="sm" className="w-full"
            onClick={() => save.mutate()}
            disabled={save.isPending || reason.trim().length < 10}
          >
            {save.isPending ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
            Save location
          </Button>
        </>
      )}
      {!canEdit && (
        <Alert className="py-2">
          <ShieldAlert className="h-3 w-3" />
          <AlertDescription className="text-[11px]">
            Read-only — only ops roles or the managing agent can edit this user's location.
          </AlertDescription>
        </Alert>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Tenant pane                                                         */
/* ------------------------------------------------------------------ */
function TenantQuickActions({
  tenantId, tenantName, tenantPhone, activeRentRequestId,
}: {
  tenantId: string;
  tenantName: string | null;
  tenantPhone: string | null;
  activeRentRequestId: string | null;
}) {
  const qc = useQueryClient();
  const { user } = useAuth() as any;
  const [statusOpen, setStatusOpen] = useState(false);
  const [statusChoice, setStatusChoice] = useState<'paying' | 'not_paying'>('not_paying');
  const [statusReason, setStatusReason] = useState('');
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState('');

  const setStatus = useRentPaymentStatusMutation(undefined);

  const phoneHref = tenantPhone ? `tel:${tenantPhone.replace(/\s+/g, '')}` : null;
  const smsHref = tenantPhone
    ? `sms:${tenantPhone.replace(/\s+/g, '')}?body=${encodeURIComponent(
        `Hi${tenantName ? ' ' + tenantName.split(' ')[0] : ''}, this is your Welile agent. `,
      )}`
    : null;

  const saveNote = useMutation({
    mutationFn: async () => {
      const trimmed = note.trim();
      if (trimmed.length < 5) throw new Error('Note must be at least 5 characters');
      if (!user?.id) throw new Error('Not signed in');
      const { error } = await supabase
        .from('ops_inbox_state')
        .upsert(
          {
            ops_user_id: user.id,
            tenant_id: tenantId,
            notes: trimmed,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'ops_user_id,tenant_id' },
        );
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Note saved');
      setNote('');
      setNoteOpen(false);
      qc.invalidateQueries({ queryKey: ['ops-inbox'] });
    },
    onError: (e: any) => toast.error(e?.message ?? 'Could not save note'),
  });

  const submitStatus = () => {
    if (!activeRentRequestId) {
      toast.error('No active rent request to update');
      return;
    }
    if (statusChoice === 'not_paying' && statusReason.trim().length < 10) {
      toast.error('Reason must be at least 10 characters');
      return;
    }
    setStatus.mutate(
      {
        rentRequestId: activeRentRequestId,
        status: statusChoice,
        reason: statusReason.trim() || 'Marked as paying',
      },
      {
        onSuccess: () => {
          setStatusOpen(false);
          setStatusReason('');
        },
      },
    );
  };

  const Action = ({
    icon: Icon, label, onClick, disabled, color = 'primary',
  }: {
    icon: any; label: string; onClick: () => void; disabled?: boolean;
    color?: 'primary' | 'success' | 'warning';
  }) => {
    const colorMap = {
      primary: 'bg-primary/10 text-primary',
      success: 'bg-emerald-500/10 text-emerald-600',
      warning: 'bg-amber-500/10 text-amber-600',
    } as const;
    return (
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className="flex flex-col items-center justify-center gap-1 rounded-xl border border-border bg-card p-2.5 text-center transition-all hover:bg-accent/40 active:scale-[0.97] disabled:opacity-50 disabled:cursor-not-allowed touch-manipulation"
      >
        <div className={`p-2 rounded-lg ${colorMap[color]}`}>
          <Icon className="h-4 w-4" />
        </div>
        <span className="text-[10px] font-semibold leading-tight">{label}</span>
      </button>
    );
  };

  return (
    <>
      <Card className="p-2">
        <div className="grid grid-cols-4 gap-2">
          <Action
            icon={Phone}
            label="Call"
            disabled={!phoneHref}
            onClick={() => phoneHref && window.open(phoneHref, '_self')}
          />
          <Action
            icon={MessageSquare}
            label="Message"
            color="success"
            disabled={!smsHref}
            onClick={() => smsHref && window.open(smsHref, '_self')}
          />
          <Action
            icon={CheckCircle2}
            label="Mark status"
            color="warning"
            disabled={!activeRentRequestId}
            onClick={() => setStatusOpen(true)}
          />
          <Action
            icon={StickyNote}
            label="Add note"
            onClick={() => setNoteOpen(true)}
          />
        </div>
        {!activeRentRequestId && (
          <p className="mt-1.5 text-[10px] text-muted-foreground text-center">
            No active rent request — Mark status is disabled.
          </p>
        )}
      </Card>

      {/* Mark status dialog */}
      <Dialog open={statusOpen} onOpenChange={setStatusOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Mark payment status</DialogTitle>
            <DialogDescription>
              {tenantName ?? 'This tenant'} — controls whether they count toward your daily target.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setStatusChoice('paying')}
                className={`flex items-center justify-center gap-1.5 rounded-lg border p-2.5 text-xs font-semibold transition-all ${
                  statusChoice === 'paying'
                    ? 'border-emerald-500 bg-emerald-500/10 text-emerald-700'
                    : 'border-border text-muted-foreground'
                }`}
              >
                <CheckCircle2 className="h-4 w-4" /> Paying
              </button>
              <button
                type="button"
                onClick={() => setStatusChoice('not_paying')}
                className={`flex items-center justify-center gap-1.5 rounded-lg border p-2.5 text-xs font-semibold transition-all ${
                  statusChoice === 'not_paying'
                    ? 'border-amber-500 bg-amber-500/10 text-amber-700'
                    : 'border-border text-muted-foreground'
                }`}
              >
                <XCircle className="h-4 w-4" /> Not paying
              </button>
            </div>
            {statusChoice === 'not_paying' && (
              <div className="space-y-1">
                <Label className="text-xs">Reason (min 10 chars)</Label>
                <Textarea
                  value={statusReason}
                  onChange={(e) => setStatusReason(e.target.value)}
                  placeholder="Why is this tenant not paying right now?"
                  rows={3}
                  className="text-sm"
                />
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setStatusOpen(false)}>Cancel</Button>
            <Button size="sm" onClick={submitStatus} disabled={setStatus.isPending}>
              {setStatus.isPending ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add note dialog */}
      <Dialog open={noteOpen} onOpenChange={setNoteOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Add note</DialogTitle>
            <DialogDescription>
              Private note attached to {tenantName ?? 'this tenant'}'s ops inbox row.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="What should the team know?"
            rows={4}
            className="text-sm"
          />
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setNoteOpen(false)}>Cancel</Button>
            <Button size="sm" onClick={() => saveNote.mutate()} disabled={saveNote.isPending}>
              {saveNote.isPending ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
              Save note
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// Full set of rent-lifecycle ledger categories that make up a tenant's
// transaction statement. Most live tenants use `rent_receivable_created`
// and `rent_payment_for_tenant`; the older set is kept for back-compat.
const TENANT_STATEMENT_CATEGORIES = [
  'rent_receivable_created',
  'rent_payment_for_tenant',
  'rent_obligation',
  'rent_obligation_reversal',
  'tenant_repayment',
  'tenant_repayment_collected',
  'rent_repayment',
  'rent_principal_collected',
] as const;

function TenantExportButtons({
  tenantId, profile, activeRr, balance, activeLandlord, dateRange,
}: {
  tenantId: string;
  profile: any;
  activeRr: any;
  balance: number;
  activeLandlord: any;
  dateRange: StatementDateRange;
}) {
  const [busy, setBusy] = useState<null | 'csv' | 'pdf'>(null);

  const fetchStatements = async () => {
    const { gte, lte } = buildDateRange(dateRange);
    let q = supabase
      .from('general_ledger')
      .select('transaction_date, amount, direction, category, description')
      .eq('user_id', tenantId)
      .in('category', TENANT_STATEMENT_CATEGORIES)
      .neq('classification', 'admin_correction');
    if (gte) q = q.gte('transaction_date', gte);
    if (lte) q = q.lte('transaction_date', lte);
    const { data, error } = await q.order('transaction_date', { ascending: false }).limit(500);
    if (error) throw error;
    return data ?? [];
  };

  const safeName = (profile?.full_name || 'tenant').replace(/[^a-z0-9]+/gi, '_').toLowerCase();
  const todayStr = format(new Date(), 'yyyy-MM-dd');

  const downloadBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const exportCsv = async () => {
    try {
      setBusy('csv');
      const statements = await fetchStatements();
      const lines: string[] = [];
      lines.push('Tenant Profile Export');
      lines.push(`Generated,${new Date().toISOString()}`);
      lines.push('');
      lines.push('Section,Field,Value');
      lines.push(`Profile,Name,"${(profile?.full_name ?? '').replace(/"/g, '""')}"`);
      lines.push(`Profile,Phone,"${profile?.phone ?? ''}"`);
      lines.push(`Profile,District,"${profile?.district ?? ''}"`);
      lines.push(`Profile,Country,"${profile?.country ?? ''}"`);
      if (activeRr) {
        lines.push(`Active Rent,Rent Amount UGX,${Number(activeRr.rent_amount || 0)}`);
        lines.push(`Active Rent,Daily Repayment UGX,${Number(activeRr.daily_repayment || 0)}`);
        lines.push(`Active Rent,Total Repayment UGX,${Number(activeRr.total_repayment || 0)}`);
        lines.push(`Active Rent,Amount Repaid UGX,${Number(activeRr.amount_repaid || 0)}`);
        lines.push(`Active Rent,Outstanding UGX,${balance}`);
        lines.push(`Active Rent,Status,"${activeRr.status ?? ''}"`);
      }
      if (activeLandlord) {
        lines.push(`Landlord,Name,"${(activeLandlord.name ?? '').replace(/"/g, '""')}"`);
        lines.push(`Landlord,Phone,"${activeLandlord.phone ?? ''}"`);
        lines.push(`Landlord,Address,"${(activeLandlord.property_address ?? '').replace(/"/g, '""')}"`);
      }
      lines.push('');
      lines.push('Statements');
      lines.push('Date,Category,Direction,Amount UGX,Description');
      for (const e of statements as any[]) {
        const date = e.transaction_date ? format(parseISO(e.transaction_date), 'yyyy-MM-dd HH:mm') : '';
        const desc = String(e.description ?? '').replace(/"/g, '""');
        lines.push(`${date},${e.category},${e.direction},${Number(e.amount || 0)},"${desc}"`);
      }
      const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
      downloadBlob(blob, `tenant_${safeName}_${todayStr}.csv`);
      toast.success('CSV downloaded');
    } catch (e: any) {
      toast.error(e?.message ?? 'CSV export failed');
    } finally {
      setBusy(null);
    }
  };

  const exportPdf = async () => {
    try {
      setBusy('pdf');
      const statements = await fetchStatements();
      const { jsPDF } = await import('jspdf');
      const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4', compress: true });
      const pageW = pdf.internal.pageSize.getWidth();
      const pageH = pdf.internal.pageSize.getHeight();

      // ── Brand palette ───────────────────────────────────────
      const GREEN: [number, number, number] = [34, 197, 94];
      const INK: [number, number, number] = [30, 30, 30];
      const MUTE: [number, number, number] = [110, 110, 110];
      const LINE: [number, number, number] = [225, 225, 225];

      // ── Branded header band ─────────────────────────────────
      pdf.setFillColor(...GREEN);
      pdf.rect(0, 0, pageW, 30, 'F');
      pdf.setTextColor(255, 255, 255);
      pdf.setFont('helvetica', 'bold'); pdf.setFontSize(18);
      pdf.text('WELILE', 14, 15);
      pdf.setFont('helvetica', 'normal'); pdf.setFontSize(10);
      pdf.text('Tenant Profile Statement', 14, 22);
      pdf.setFontSize(8);
      pdf.text(`Generated ${format(new Date(), 'dd MMM yyyy, HH:mm')}`, pageW - 14, 15, { align: 'right' });
      pdf.text('welileapp.com', pageW - 14, 21, { align: 'right' });

      pdf.setTextColor(...INK);
      let y = 40;

      const sectionHeader = (label: string) => {
        pdf.setFillColor(240, 253, 244);
        pdf.rect(12, y - 4.5, pageW - 24, 7, 'F');
        pdf.setFont('helvetica', 'bold'); pdf.setFontSize(10.5);
        pdf.setTextColor(...GREEN);
        pdf.text(label, 14, y);
        pdf.setTextColor(...INK);
        y += 7;
        pdf.setFont('helvetica', 'normal'); pdf.setFontSize(10);
      };

      sectionHeader('Profile');
      const profileLines = [
        ['Name', profile?.full_name ?? '—'],
        ['Phone', profile?.phone ?? '—'],
        ['District', profile?.district ?? '—'],
        ['Country', profile?.country ?? '—'],
      ];
      for (const [k, v] of profileLines) {
        pdf.setTextColor(...MUTE); pdf.text(`${k}`, 14, y);
        pdf.setTextColor(...INK); pdf.text(String(v), 50, y); y += 5.5;
      }
      y += 4;

      if (activeRr) {
        sectionHeader('Active Rent Plan');
        const rentLines: [string, string][] = [
          ['Rent amount', fmtUGX(activeRr.rent_amount)],
          ['Daily repayment', fmtUGX(activeRr.daily_repayment)],
          ['Total repayment', fmtUGX(activeRr.total_repayment)],
          ['Repaid', fmtUGX(activeRr.amount_repaid)],
          ['Outstanding', fmtUGX(balance)],
          ['Status', String(activeRr.status ?? '—')],
        ];
        for (const [k, v] of rentLines) {
          pdf.setTextColor(...MUTE); pdf.text(`${k}`, 14, y);
          pdf.setTextColor(...INK); pdf.text(v, 60, y); y += 5.5;
        }
        y += 4;
      }

      if (activeLandlord) {
        sectionHeader('Landlord');
        const llLines: [string, string][] = [
          ['Name', activeLandlord.name ?? '—'],
          ['Phone', activeLandlord.phone ?? '—'],
          ['Address', activeLandlord.property_address ?? '—'],
        ];
        for (const [k, v] of llLines) {
          pdf.setTextColor(...MUTE); pdf.text(`${k}`, 14, y);
          pdf.setTextColor(...INK); pdf.text(String(v).slice(0, 80), 50, y); y += 5.5;
        }
        y += 4;
      }

      sectionHeader(`Transactions & Statements (${(statements as any[]).length})`);
      // table head
      pdf.setFillColor(...GREEN);
      pdf.rect(12, y - 4.5, pageW - 24, 7, 'F');
      pdf.setTextColor(255, 255, 255);
      pdf.setFont('helvetica', 'bold'); pdf.setFontSize(9);
      pdf.text('Date', 14, y);
      pdf.text('Category', 50, y);
      pdf.text('Dir', 108, y);
      pdf.text('Amount (UGX)', pageW - 14, y, { align: 'right' });
      y += 7;
      pdf.setTextColor(...INK);
      pdf.setFont('helvetica', 'normal'); pdf.setFontSize(9);
      let zebra = false;
      if ((statements as any[]).length === 0) {
        pdf.setTextColor(...MUTE);
        pdf.text('No rent transactions on file for the selected period.', 14, y);
        pdf.setTextColor(...INK);
        y += 6;
      }
      for (const e of statements as any[]) {
        if (y > pageH - 18) { pdf.addPage(); y = 18; }
        if (zebra) { pdf.setFillColor(247, 250, 248); pdf.rect(12, y - 4, pageW - 24, 6, 'F'); }
        zebra = !zebra;
        const date = e.transaction_date ? format(parseISO(e.transaction_date), 'dd MMM yy HH:mm') : '—';
        const cat = String(e.category ?? '').replace(/_/g, ' ');
        const isIn = e.direction === 'cash_in';
        const dir = isIn ? 'IN' : 'OUT';
        const amt = Number(e.amount || 0).toLocaleString();
        pdf.text(date, 14, y);
        pdf.text(cat.slice(0, 30), 50, y);
        isIn ? pdf.setTextColor(...GREEN) : pdf.setTextColor(220, 60, 60);
        pdf.text(dir, 108, y);
        pdf.text(amt, pageW - 14, y, { align: 'right' });
        pdf.setTextColor(...INK);
        y += 6;
      }

      // ── Footer on every page ────────────────────────────────
      const pageCount = pdf.getNumberOfPages();
      for (let p = 1; p <= pageCount; p++) {
        pdf.setPage(p);
        pdf.setDrawColor(...LINE); pdf.setLineWidth(0.2);
        pdf.line(14, pageH - 12, pageW - 14, pageH - 12);
        pdf.setFont('helvetica', 'normal'); pdf.setFontSize(7.5);
        pdf.setTextColor(...MUTE);
        pdf.text('Welile — Rent made possible. This statement is generated for internal operational use.', 14, pageH - 7);
        pdf.text(`Page ${p} of ${pageCount}`, pageW - 14, pageH - 7, { align: 'right' });
        pdf.setTextColor(...INK);
      }

      pdf.save(`tenant_${safeName}_${todayStr}.pdf`);
      toast.success('PDF downloaded');
    } catch (e: any) {
      toast.error(e?.message ?? 'PDF export failed');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card className="p-2.5 flex items-center justify-between gap-2">
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <Download className="h-3.5 w-3.5" /> Export profile
      </div>
      <div className="flex gap-1.5">
        <Button size="sm" variant="outline" className="h-7 text-xs" disabled={busy !== null} onClick={exportCsv}>
          {busy === 'csv' ? <Loader2 className="h-3 w-3 animate-spin" /> : <FileText className="h-3 w-3 mr-1" />} CSV
        </Button>
        <Button size="sm" variant="outline" className="h-7 text-xs" disabled={busy !== null} onClick={exportPdf}>
          {busy === 'pdf' ? <Loader2 className="h-3 w-3 animate-spin" /> : <FileText className="h-3 w-3 mr-1" />} PDF
        </Button>
      </div>
    </Card>
  );
}

type DateRangePreset = 'today' | 'this_month' | 'custom';
interface StatementDateRange {
  preset: DateRangePreset;
  from?: Date;
  to?: Date;
}

function buildDateRange(range: StatementDateRange) {
  const now = new Date();
  if (range.preset === 'today') {
    return { gte: startOfDay(now).toISOString(), lte: endOfDay(now).toISOString() };
  }
  if (range.preset === 'this_month') {
    return { gte: startOfMonth(now).toISOString(), lte: endOfMonth(now).toISOString() };
  }
  if (range.preset === 'custom' && range.from && range.to) {
    return { gte: startOfDay(range.from).toISOString(), lte: endOfDay(range.to).toISOString() };
  }
  return { gte: undefined, lte: undefined };
}

function StatementDateFilter({
  value,
  onChange,
}: {
  value: StatementDateRange;
  onChange: (v: StatementDateRange) => void;
}) {
  const presets: { key: DateRangePreset; label: string }[] = [
    { key: 'today', label: 'Today' },
    { key: 'this_month', label: 'This month' },
    { key: 'custom', label: 'Custom' },
  ];

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1 flex-wrap">
        {presets.map((p) => (
          <button
            key={p.key}
            type="button"
            onClick={() => onChange({ ...value, preset: p.key })}
            className={`px-2 py-0.5 rounded-full text-[10px] font-medium transition-colors border ${
              value.preset === p.key
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-muted text-muted-foreground border-border hover:bg-muted/80'
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>
      {value.preset === 'custom' && (
        <div className="flex items-center gap-2">
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className={cn(
                  'h-7 text-xs justify-start text-left font-normal w-[130px]',
                  !value.from && 'text-muted-foreground',
                )}
              >
                <CalendarIcon className="mr-1 h-3 w-3" />
                {value.from ? format(value.from, 'dd MMM yyyy') : <span>From</span>}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="start">
              <Calendar
                mode="single"
                selected={value.from}
                onSelect={(d) => onChange({ ...value, from: d })}
                initialFocus
                className={cn('p-3 pointer-events-auto')}
              />
            </PopoverContent>
          </Popover>
          <span className="text-[10px] text-muted-foreground">to</span>
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className={cn(
                  'h-7 text-xs justify-start text-left font-normal w-[130px]',
                  !value.to && 'text-muted-foreground',
                )}
              >
                <CalendarIcon className="mr-1 h-3 w-3" />
                {value.to ? format(value.to, 'dd MMM yyyy') : <span>To</span>}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="start">
              <Calendar
                mode="single"
                selected={value.to}
                onSelect={(d) => onChange({ ...value, to: d })}
                initialFocus
                className={cn('p-3 pointer-events-auto')}
              />
            </PopoverContent>
          </Popover>
        </div>
      )}
    </div>
  );
}

function RentBalanceEditor({
  activeRr,
  balance,
  canEdit,
  onSaved,
}: {
  activeRr: any;
  balance: number;
  canEdit: boolean;
  onSaved: () => void;
}) {
  const [mode, setMode] = useState<'view' | 'rent' | 'balance'>('view');
  const [rentAmount, setRentAmount] = useState<string>(String(activeRr.rent_amount ?? ''));
  const [newBalance, setNewBalance] = useState<string>(String(Math.max(0, balance)));
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  const cancel = () => {
    setMode('view');
    setRentAmount(String(activeRr.rent_amount ?? ''));
    setNewBalance(String(Math.max(0, balance)));
    setReason('');
  };

  const save = async () => {
    const isBalance = mode === 'balance';
    const amt = Number(isBalance ? newBalance : rentAmount);
    if (!Number.isFinite(amt) || (isBalance ? amt < 0 : amt <= 0)) {
      toast.error(isBalance ? 'Enter a valid balance (0 or more)' : 'Enter a valid rent amount');
      return;
    }
    if (reason.trim().length < 10) {
      toast.error('Reason must be at least 10 characters');
      return;
    }
    setSaving(true);
    try {
      const { error } = await supabase.rpc('ops_record_payment_edit', {
        p_edit_type: isBalance ? 'outstanding_balance' : 'rent_amount',
        p_target_id: activeRr.id,
        p_new_amount: amt,
        p_reason: reason.trim(),
      } as any);
      if (error) throw error;
      toast.success(isBalance ? 'Outstanding balance updated' : 'Rent updated — agent notified to agree');
      setMode('view');
      setReason('');
      onSaved();
    } catch (e: any) {
      toast.error(e.message ?? 'Update failed');
    } finally {
      setSaving(false);
    }
  };

  if (mode === 'view') {
    return (
      <>
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div>
            <span className="text-muted-foreground">Rent amount</span>
            <p className="font-semibold">{fmtUGX(activeRr.rent_amount)}</p>
          </div>
          <div>
            <span className="text-muted-foreground">Daily repayment</span>
            <p className="font-semibold">{fmtUGX(activeRr.daily_repayment)}</p>
          </div>
          <div>
            <span className="text-muted-foreground">Repaid</span>
            <p className="font-semibold">{fmtUGX(activeRr.amount_repaid)}</p>
          </div>
          <div>
            <span className="text-muted-foreground">Outstanding</span>
            <p className="font-semibold text-amber-700">{fmtUGX(balance)}</p>
          </div>
        </div>
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <Badge variant="outline" className="text-[10px]">{activeRr.status}</Badge>
          {canEdit && (
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs gap-1"
                onClick={() => setMode('rent')}
              >
                <Pencil className="h-3 w-3" /> Edit rent
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs gap-1"
                onClick={() => { setNewBalance(String(Math.max(0, balance))); setMode('balance'); }}
              >
                <Wallet className="h-3 w-3" /> Adjust balance
              </Button>
            </div>
          )}
        </div>
      </>
    );
  }

  if (mode === 'balance') {
    return (
      <div className="space-y-2">
        <div className="space-y-1">
          <Label className="text-xs">New outstanding balance (UGX)</Label>
          <Input
            type="number"
            min={0}
            value={newBalance}
            onChange={(e) => setNewBalance(e.target.value)}
            className="h-8 text-sm"
          />
          <p className="text-[10px] text-muted-foreground">
            Currently {fmtUGX(balance)} owing. Set to 0 to mark fully paid — the amount repaid is recalculated automatically.
          </p>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Reason (min 10 chars)</Label>
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            className="text-sm"
            placeholder="Why is the outstanding balance being changed?"
          />
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={save} disabled={saving} className="h-7 px-3 text-xs">
            {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Save'}
          </Button>
          <Button size="sm" variant="ghost" onClick={cancel} disabled={saving} className="h-7 px-3 text-xs">
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="space-y-1">
        <Label className="text-xs">Rent amount (UGX)</Label>
        <Input
          type="number"
          min={1}
          value={rentAmount}
          onChange={(e) => setRentAmount(e.target.value)}
          className="h-8 text-sm"
        />
        <p className="text-[10px] text-muted-foreground">
          Daily &amp; total repayment recalculate automatically from the rent formula.
        </p>
      </div>
      <div className="space-y-1">
        <Label className="text-xs">Reason (min 10 chars)</Label>
        <Textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={2}
          className="text-sm"
          placeholder="Why is the rent amount being changed?"
        />
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={save} disabled={saving} className="h-7 px-3 text-xs">
          {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Save'}
        </Button>
        <Button size="sm" variant="ghost" onClick={cancel} disabled={saving} className="h-7 px-3 text-xs">
          Cancel
        </Button>
      </div>
    </div>
  );
}

function LandlordFundingEditor({
  rentRequestId,
  currentAmount,
  onSaved,
}: {
  rentRequestId: string;
  currentAmount: number;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [amount, setAmount] = useState<string>(String(currentAmount || ''));
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  const cancel = () => {
    setEditing(false);
    setAmount(String(currentAmount || ''));
    setReason('');
  };

  const save = async () => {
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      toast.error('Enter a valid funding amount');
      return;
    }
    if (reason.trim().length < 10) {
      toast.error('Reason must be at least 10 characters');
      return;
    }
    setSaving(true);
    try {
      const { error } = await supabase.rpc('ops_edit_landlord_funding', {
        p_rent_request_id: rentRequestId,
        p_new_amount: amt,
        p_reason: reason.trim(),
      } as any);
      if (error) throw error;
      toast.success('Landlord funding amount updated');
      setEditing(false);
      setReason('');
      onSaved();
    } catch (e: any) {
      toast.error(e.message ?? 'Update failed');
    } finally {
      setSaving(false);
    }
  };

  if (!editing) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-md border border-dashed px-2.5 py-2">
        <div className="min-w-0">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Landlord funding (requisition)</p>
          <p className="text-sm font-semibold">{fmtUGX(currentAmount)}</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="h-7 px-2 text-xs gap-1 shrink-0"
          onClick={() => { setAmount(String(currentAmount || '')); setEditing(true); }}
        >
          <Pencil className="h-3 w-3" /> Edit funding
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded-md border px-2.5 py-2">
      <div className="space-y-1">
        <Label className="text-xs">Landlord funding amount (UGX)</Label>
        <Input
          type="number"
          min={1}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          className="h-8 text-sm"
        />
        <p className="text-[10px] text-muted-foreground">
          Only editable while the landlord has not yet been paid. Adjusts the open funding allocation and the ledger.
        </p>
      </div>
      <div className="space-y-1">
        <Label className="text-xs">Reason (min 10 chars)</Label>
        <Textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={2}
          className="text-sm"
          placeholder="Why is the landlord funding amount being changed?"
        />
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={save} disabled={saving} className="h-7 px-3 text-xs">
          {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Save'}
        </Button>
        <Button size="sm" variant="ghost" onClick={cancel} disabled={saving} className="h-7 px-3 text-xs">
          Cancel
        </Button>
      </div>
    </div>
  );
}

function TenantPane({
  tenantId, isOps, onBackToAgent, onSelectLandlord, onSelectUser,
}: { tenantId: string; isOps: boolean; onBackToAgent?: () => void; onSelectLandlord?: (id: string) => void; onSelectUser?: (id: string, name: string) => void }) {
  const qc = useQueryClient();
  const [dateRange, setDateRange] = useState<StatementDateRange>({ preset: 'today' });
  const { data: profile, isLoading } = useProfile(tenantId);
  const { data: roles = [] } = useUserRoles(tenantId);
  const { data: rentReqs = [] } = useQuery({
    queryKey: ['drilldown-tenant-rr', tenantId],
    queryFn: async () => {
      const { data } = await supabase
        .from('rent_requests')
        .select('id, rent_amount, daily_repayment, total_repayment, amount_repaid, status, agent_id, assigned_agent_id, landlord_id, created_at, repayment_frequency, repayment_starts_on')
        .eq('tenant_id', tenantId)
        .order('created_at', { ascending: false })
        .limit(5);
      return data ?? [];
    },
  });

  const activeRr: any = rentReqs[0] ?? null;
  const balance = activeRr
    ? Math.max(0, Number(activeRr.total_repayment || 0) - Number(activeRr.amount_repaid || 0))
    : 0;

  // Landlord on the active rent request — `landlord_id` points to `landlords.id`
  // (NOT a profile), so we must hit the `landlords` table to get the real name
  // the agent captured at registration.
  const { data: activeLandlord } = useQuery({
    queryKey: ['drilldown-tenant-active-landlord', activeRr?.landlord_id],
    enabled: !!activeRr?.landlord_id,
    queryFn: async () => {
      const { data } = await supabase
        .from('landlords')
        .select('id, name, phone, property_address')
        .eq('id', activeRr.landlord_id)
        .maybeSingle();
      return data;
    },
  });

  // Whether the landlord has ACTUALLY been paid for the active (funded) rent
  // request. A request can be status=funded while the landlord money still sits
  // as an OPEN float allocation (paid_out_amount = 0) with no landlord_payouts
  // row — i.e. the landlord was never actually paid. Surface that here so the
  // tenant ops record tells the truth instead of just echoing "funded".
  const FUNDED_LIKE = ['funded', 'disbursed', 'repaying', 'active', 'completed'];
  const { data: landlordPayment } = useQuery({
    queryKey: ['drilldown-tenant-landlord-payment', activeRr?.id],
    enabled: !!activeRr?.id && FUNDED_LIKE.includes((activeRr?.status ?? '').toLowerCase()),
    queryFn: async () => {
      const [{ data: payouts }, { data: allocs }] = await Promise.all([
        supabase
          .from('landlord_payouts')
          .select('amount, status, disbursed_at')
          .eq('rent_request_id', activeRr.id),
        supabase
          .from('agent_landlord_float_allocations')
          .select('allocated_amount, paid_out_amount, remaining_amount, status')
          .eq('rent_request_id', activeRr.id),
      ]);
      const paidPayout = (payouts ?? []).reduce(
        (s: number, p: any) =>
          ['disbursed', 'completed', 'paid', 'success'].includes((p.status ?? '').toLowerCase())
            ? s + Number(p.amount || 0)
            : s,
        0,
      );
      const allocPaid = (allocs ?? []).reduce((s: number, a: any) => s + Number(a.paid_out_amount || 0), 0);
      const allocOutstanding = (allocs ?? []).reduce((s: number, a: any) => s + Number(a.remaining_amount || 0), 0);
      const allocated = (allocs ?? []).reduce((s: number, a: any) => s + Number(a.allocated_amount || 0), 0);
      const totalPaid = paidPayout + allocPaid;
      const hasAllocation = (allocs ?? []).length > 0;
      let state: 'paid' | 'awaiting' | 'partial' | 'none';
      if (totalPaid > 0 && allocOutstanding <= 0) state = 'paid';
      else if (totalPaid > 0) state = 'partial';
      else if (hasAllocation) state = 'awaiting';
      else state = 'none';
      return { state, totalPaid, allocOutstanding, allocated, allocPaid, hasAllocation };
    },
  });

  const [reassignAgent, setReassignAgent] = useState<UserBrief | null>(null);
  const [reassignReason, setReassignReason] = useState('');
  const reassign = useMutation({
    mutationFn: async () => {
      if (!reassignAgent) throw new Error('Pick an agent');
      if (reassignReason.trim().length < 10) throw new Error('Reason ≥ 10 chars');
      // Always link the user → agent at the profile level (works for any user,
      // even with no active rent request).
      const { error: linkErr } = await supabase.rpc('ops_link_user_to_agent', {
        p_user_id: tenantId,
        p_agent_id: reassignAgent.id,
        p_reason: reassignReason.trim(),
      } as any);
      if (linkErr) throw linkErr;
      // If there is an active rent request, also reassign it so collections
      // route to the new agent immediately.
      if (activeRr) {
        const { error } = await supabase.rpc('reassign_rent_request_agent', {
          p_rent_request_id: activeRr.id,
          p_new_agent_id: reassignAgent.id,
          p_reason: reassignReason.trim(),
        } as any);
        if (error) throw error;
      }
    },
    onSuccess: () => {
      toast.success('User linked to agent');
      setReassignAgent(null); setReassignReason('');
      qc.invalidateQueries({ queryKey: ['drilldown-tenant-rr', tenantId] });
      qc.invalidateQueries({ queryKey: ['drilldown-profile', tenantId] });
    },
    onError: (e: any) => toast.error(e.message ?? 'Link failed'),
  });

  if (isLoading) return <Loader2 className="h-4 w-4 animate-spin mx-auto" />;

  return (
    <div className="space-y-3">
      {onBackToAgent && (
        <button
          type="button"
          onClick={onBackToAgent}
          className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-3 w-3" /> Back to agent
        </button>
      )}
      <ProfileHeader profile={profile} roles={roles} userId={tenantId} canEdit={isOps} />
      <TenantQuickActions
        tenantId={tenantId}
        tenantName={profile?.full_name ?? null}
        tenantPhone={profile?.phone ?? null}
        activeRentRequestId={activeRr?.id ?? null}
      />
      <TenantExportButtons
        tenantId={tenantId}
        profile={profile}
        activeRr={activeRr}
        balance={balance}
        activeLandlord={activeLandlord}
        dateRange={dateRange}
      />
      <LocationEditor userId={tenantId} profile={profile} canEdit={isOps /* agent edit handled elsewhere */} />

      <Card className="p-3 space-y-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Wallet className="h-4 w-4 text-primary" /> Rent balance
        </div>
        {landlordPayment && landlordPayment.state !== 'paid' && (
          <div
            className={cn(
              'flex items-start gap-2 rounded-md border px-2.5 py-2 text-[11px]',
              landlordPayment.state === 'partial'
                ? 'border-amber-300 bg-amber-50 text-amber-800'
                : 'border-red-300 bg-red-50 text-red-700',
            )}
          >
            <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <span>
              {landlordPayment.state === 'partial' ? (
                <>
                  <span className="font-semibold">Landlord partially paid.</span>{' '}
                  {fmtUGX(landlordPayment.totalPaid)} paid, {fmtUGX(landlordPayment.allocOutstanding)} still owed to the landlord.
                </>
              ) : landlordPayment.state === 'awaiting' ? (
                <>
                  <span className="font-semibold">Landlord NOT yet paid.</span>{' '}
                  Rent shows as funded but the money is still an open float allocation ({fmtUGX(landlordPayment.allocOutstanding)} awaiting landlord payout).
                </>
              ) : (
                <>
                  <span className="font-semibold">No landlord payment on record.</span>{' '}
                  Rent shows as funded but no landlord payout or float allocation exists yet.
                </>
              )}
            </span>
          </div>
        )}
        {landlordPayment && landlordPayment.state === 'paid' && (
          <div className="flex items-center gap-2 rounded-md border border-green-300 bg-green-50 px-2.5 py-1.5 text-[11px] text-green-700">
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
            <span><span className="font-semibold">Landlord paid</span> — {fmtUGX(landlordPayment.totalPaid)} disbursed.</span>
          </div>
        )}
        {!activeRr ? (
          <p className="text-xs text-muted-foreground">No rent requests on file.</p>
        ) : (
          <RentBalanceEditor
            activeRr={activeRr}
            balance={balance}
            canEdit={isOps}
            onSaved={() => qc.invalidateQueries({ queryKey: ['drilldown-tenant-rr', tenantId] })}
          />
        )}
        {activeRr && isOps && landlordPayment && landlordPayment.hasAllocation && Number(landlordPayment.allocPaid || 0) === 0 && (
          <LandlordFundingEditor
            rentRequestId={activeRr.id}
            currentAmount={Number(landlordPayment.allocated || 0)}
            onSaved={() => {
              qc.invalidateQueries({ queryKey: ['drilldown-tenant-landlord-payment', activeRr.id] });
              qc.invalidateQueries({ queryKey: ['drilldown-tenant-rr', tenantId] });
            }}
          />
        )}
      </Card>

      {/* Tenant repayment / obligation ledger history */}
      <TenantStatements tenantId={tenantId} dateRange={dateRange} onDateRangeChange={setDateRange} />

      {/* Wallet buckets — works for any picked user (tenant, funder, anyone) */}
      <WalletBucketsCard userId={tenantId} />

      {/* User-to-user transfers — who sent/received money */}
      <UserTransfersList userId={tenantId} onSelectUser={onSelectUser} />

      {/* Landlord payments recorded by the agent — Tenant Ops can edit the amount */}
      <TenantLandlordPayoutsEditor tenantId={tenantId} canEdit={isOps} />

      {activeRr?.landlord_id && (
        <Card className="p-3 space-y-1.5">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Home className="h-4 w-4 text-primary" /> Landlord on file
          </div>
          <button
            type="button"
            onClick={() => onSelectLandlord?.(activeRr.landlord_id)}
            className="text-left text-sm font-semibold truncate text-primary hover:underline disabled:no-underline disabled:text-foreground"
            disabled={!onSelectLandlord}
          >
            {activeLandlord?.name?.trim() || activeLandlord?.phone || 'Landlord record missing'}
          </button>
          {activeLandlord?.phone && (
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs text-muted-foreground font-mono">{activeLandlord.phone}</span>
              <ContactActions
                phone={activeLandlord.phone}
                size="xs"
                message={`Hello ${activeLandlord?.name ?? ''}, this is Welile Ops regarding your tenant.`}
              />
            </div>
          )}
          {activeLandlord?.property_address && (
            <p className="text-xs text-muted-foreground truncate">
              <MapPin className="h-3 w-3 inline mr-1" />{activeLandlord.property_address}
            </p>
          )}
        </Card>
      )}

      {isOps && (
        <Card className="p-3 space-y-2">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Link2 className="h-4 w-4 text-primary" /> Link to agent
          </div>
          <p className="text-[11px] text-muted-foreground">
            Assigns the managing agent on this user's profile{activeRr ? ' and reassigns the active rent request' : ''}. Works for any user — tenant, funder, landlord contact, or anyone else.
          </p>
          <UserSearchPicker
            label="Pick agent"
            selectedUser={reassignAgent as any}
            onSelect={(u) => setReassignAgent(u as any)}
            roleFilter="agent"
          />
          <Input
            placeholder="Reason (min 10 chars)"
            value={reassignReason}
            onChange={(e) => setReassignReason(e.target.value)}
            className="h-8 text-sm"
          />
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button
              size="sm" className="w-full sm:flex-1"
              disabled={!reassignAgent || reassign.isPending}
              onClick={() => reassign.mutate()}
            >
              {reassign.isPending ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
              {activeRr ? 'Link & reassign rent' : 'Link to agent'}
            </Button>
            {activeRr && (
              <PaymentPeriodControl
                rentRequestId={activeRr.id}
                frequency={activeRr.repayment_frequency ?? null}
                dailyRepayment={activeRr.daily_repayment ?? null}
                canEdit={isOps}
                onSaved={() => {
                  qc.invalidateQueries({ queryKey: ['drilldown-tenant-rr', tenantId] });
                  qc.invalidateQueries({ queryKey: ['tenant-ops-agent-monitoring'] });
                  qc.invalidateQueries({ queryKey: ['agent-capacity-map'] });
                }}
              />
            )}
          </div>
        </Card>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Agent pane                                                          */
/* ------------------------------------------------------------------ */
function AgentPane({ agentId, isOps, onSelectTenant, onSelectLandlord, onSelectUser }: { agentId: string; isOps: boolean; onSelectTenant?: (id: string, name: string) => void; onSelectLandlord?: (id: string) => void; onSelectUser?: (id: string, name: string) => void }) {
  const qc = useQueryClient();
  const { data: profile, isLoading } = useProfile(agentId);
  const { data: roles = [] } = useUserRoles(agentId);
  const [viewMode, setViewMode] = useState<'tenants' | 'landlords' | 'listings'>('tenants');
  // Listings filters
  const [listingsSearch, setListingsSearch] = useState('');
  const [listingsStatusFilter, setListingsStatusFilter] = useState<string>('all');
  const [listingsLocationFilter, setListingsLocationFilter] = useState<string>('all');
  const [listingsDateRange, setListingsDateRange] = useState<StatementDateRange>({ preset: 'this_month' });
  const [photoUploadFor, setPhotoUploadFor] = useState<any | null>(null);

  const { data: listings = [], refetch: refetchListings, isFetching: listingsFetching } = useQuery({
    queryKey: ['drilldown-agent-listings', agentId],
    queryFn: async () => {
      // Same person may have multiple profile UUIDs (per Identity Account Mapping).
      // Resolve all sibling profile ids that share this agent's phone, then query
      // house_listings for any of those agent_ids.
      const { data: me } = await supabase
        .from('profiles').select('phone').eq('id', agentId).maybeSingle();
      const agentIds = new Set<string>([agentId]);
      if (me?.phone) {
        const { data: siblings } = await supabase
          .from('profiles').select('id').eq('phone', me.phone);
        (siblings ?? []).forEach((s: any) => agentIds.add(s.id));
      }
      const { data } = await supabase
        .from('house_listings')
        .select('id, title, monthly_rent, status, village, district, landlord_id, tenant_id, agent_id, created_at, image_urls')
        .in('agent_id', Array.from(agentIds))
        .order('created_at', { ascending: false })
        .limit(200);
      const rows = data ?? [];
      const llIds = Array.from(new Set(rows.map((r: any) => r.landlord_id).filter(Boolean)));
      let llMap = new Map<string, any>();
      if (llIds.length) {
        const { data: lls } = await supabase
          .from('landlords').select('id, name, phone').in('id', llIds);
        llMap = new Map((lls ?? []).map((l: any) => [l.id, l]));
      }
      return rows.map((r: any) => ({ ...r, landlord: llMap.get(r.landlord_id) ?? null }));
    },
  });

  const statusOptions = useMemo(() => {
    const s = new Set(listings.map((l: any) => l.status).filter(Boolean));
    return Array.from(s).sort();
  }, [listings]);

  const locationOptions = useMemo(() => {
    const locs = new Set<string>();
    listings.forEach((l: any) => {
      if (l.village) locs.add(l.village);
      if (l.district) locs.add(l.district);
    });
    return Array.from(locs).sort();
  }, [listings]);

  const filteredListings = useMemo(() => {
    const q = listingsSearch.trim().toLowerCase();
    const { gte, lte } = buildDateRange(listingsDateRange);
    return listings.filter((l: any) => {
      if (q) {
        const text = `${l.title ?? ''} ${l.village ?? ''} ${l.district ?? ''} ${l.landlord?.name ?? ''} ${l.landlord?.phone ?? ''}`.toLowerCase();
        if (!text.includes(q)) return false;
      }
      if (listingsStatusFilter !== 'all' && l.status !== listingsStatusFilter) return false;
      if (listingsLocationFilter !== 'all') {
        if (l.village !== listingsLocationFilter && l.district !== listingsLocationFilter) return false;
      }
      if (gte && l.created_at && l.created_at < gte) return false;
      if (lte && l.created_at && l.created_at > lte) return false;
      return true;
    });
  }, [listings, listingsSearch, listingsStatusFilter, listingsLocationFilter, listingsDateRange]);

  const { data: stats } = useQuery({
    queryKey: ['drilldown-agent-stats', agentId],
    queryFn: async () => {
      const [tenants, rentSum, landlords, wallet, strict, capacity, referrals, partners, advances] = await Promise.all([
        supabase.from('profiles').select('id', { count: 'exact', head: true }).eq('managing_agent_id', agentId),
        supabase.from('rent_requests').select('rent_amount').eq('assigned_agent_id', agentId).limit(1000),
        supabase.from('agent_landlord_assignments').select('landlord_id, landlords(id,name,phone)').eq('agent_id', agentId).eq('status','active'),
        supabase.from('wallets').select('withdrawable_balance, float_balance, advance_balance, balance, currency, locked_balance').eq('user_id', agentId).maybeSingle(),
        supabase.rpc('get_user_available_balance', { p_user_id: agentId } as any),
        supabase.rpc('get_agent_rent_request_capacity', { p_agent_id: agentId } as any),
        supabase.from('profiles').select('id', { count: 'exact', head: true }).eq('referrer_id', agentId),
        supabase.from('proxy_agent_assignments')
          .select('beneficiary_id, beneficiary_role, is_managed_account, approval_status, is_active, created_at')
          .eq('agent_id', agentId)
          .eq('is_active', true),
        supabase.from('agent_advances')
          .select('outstanding_balance, status, created_at')
          .eq('agent_id', agentId)
          .in('status', ['active','outstanding','approved','disbursed']),
      ]);
      const totalRent = (rentSum.data ?? []).reduce((s: number, r: any) => s + Number(r.rent_amount || 0), 0);
      const partnerRows = partners.data ?? [];
      const partnersOnboarded = partnerRows.filter((p: any) => p.beneficiary_role === 'supporter').length;
      const proxyLandlords = partnerRows.filter((p: any) => p.beneficiary_role === 'landlord').length;
      const managedAccounts = partnerRows.filter((p: any) => p.is_managed_account && p.approval_status === 'approved').length;
      const outstandingAdvance = (advances.data ?? []).reduce((s: number, r: any) => s + Number(r.outstanding_balance || 0), 0);
      return {
        tenantCount: tenants.count ?? 0,
        totalRent,
        landlords: landlords.data ?? [],
        wallet: wallet.data ?? null,
        strictWithdrawable: Number(strict.data ?? 0),
        capacity: capacity.data ?? null,
        referralCount: referrals.count ?? 0,
        partnersOnboarded,
        proxyLandlords,
        managedAccounts,
        outstandingAdvance,
      };
    },
  });

  const [linkLandlord, setLinkLandlord] = useState<UserBrief | null>(null);
  const [linkReason, setLinkReason] = useState('');
  const link = useMutation({
    mutationFn: async () => {
      if (!linkLandlord) throw new Error('Pick a landlord');
      if (linkReason.trim().length < 10) throw new Error('Reason ≥ 10 chars');
      const { error } = await supabase.rpc('ops_link_agent_landlord', {
        p_agent_id: agentId,
        p_landlord_id: linkLandlord.id,
        p_reason: linkReason.trim(),
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Landlord linked to agent');
      setLinkLandlord(null); setLinkReason('');
      qc.invalidateQueries({ queryKey: ['drilldown-agent-stats', agentId] });
    },
    onError: (e: any) => toast.error(e.message ?? 'Link failed'),
  });

  if (isLoading) return <Loader2 className="h-4 w-4 animate-spin mx-auto" />;

  const w = stats?.wallet as any;
  const cap = stats?.capacity as any;

  return (
    <div className="space-y-3">
      <ProfileHeader profile={profile} roles={roles} userId={agentId} canEdit={isOps} />
      <LocationEditor userId={agentId} profile={profile} canEdit={isOps} />

      {/* Wallet — 3-bucket model */}
      <Card className="p-3 space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Wallet className="h-4 w-4 text-primary" /> Wallet
          </div>
          {w?.currency && (
            <Badge variant="outline" className="text-[10px]">{w.currency}</Badge>
          )}
        </div>
        <div className="grid grid-cols-3 gap-2 text-[11px]">
          <div className="rounded-md bg-emerald-50 dark:bg-emerald-950/30 p-2">
            <p className="text-muted-foreground text-[10px] uppercase">Withdrawable</p>
            <p className="font-semibold text-emerald-700 dark:text-emerald-300">
              {fmtUGX(stats?.strictWithdrawable ?? 0)}
            </p>
            {w && Number(w.withdrawable_balance ?? 0) !== (stats?.strictWithdrawable ?? 0) && (
              <p className="text-[9px] text-muted-foreground">cache {fmtUGX(w.withdrawable_balance ?? 0)}</p>
            )}
          </div>
          <div className="rounded-md bg-sky-50 dark:bg-sky-950/30 p-2">
            <p className="text-muted-foreground text-[10px] uppercase">Float</p>
            <p className="font-semibold text-sky-700 dark:text-sky-300">
              {fmtUGX(w?.float_balance ?? 0)}
            </p>
          </div>
          <div className="rounded-md bg-amber-50 dark:bg-amber-950/30 p-2">
            <p className="text-muted-foreground text-[10px] uppercase">Advance</p>
            <p className="font-semibold text-amber-700 dark:text-amber-300">
              {fmtUGX(w?.advance_balance ?? 0)}
            </p>
          </div>
        </div>
        {Number(w?.locked_balance ?? 0) > 0 && (
          <p className="text-[10px] text-muted-foreground">
            Locked / pending holds: {fmtUGX(w.locked_balance)}
          </p>
        )}
        {Number(stats?.outstandingAdvance ?? 0) > 0 && (
          <p className="text-[10px] text-amber-700">
            Outstanding advances on file: {fmtUGX(stats?.outstandingAdvance ?? 0)}
          </p>
        )}
      </Card>

      {/* Recent wallet statements (last 25 entries, user-facing filter) */}
      <AgentWalletStatements agentId={agentId} />

      {/* Per-advance detail — principal, outstanding, status, daily, days left */}
      <AgentAdvancesDetail agentId={agentId} />

      {/* User-to-user transfers — who sent/received money */}
      <UserTransfersList userId={agentId} onSelectUser={onSelectUser} />

      {/* Capacity / credit access */}
      {cap && (
        <Card className="p-3 space-y-2">
          <div className="flex items-center gap-2 text-sm font-medium">
            <TrendingUp className="h-4 w-4 text-primary" /> Rent-allocation capacity
          </div>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div>
              <span className="text-muted-foreground">Daily cap</span>
              <p className="font-semibold">{fmtUGX(cap.daily_cap ?? cap.max_daily ?? 0)}</p>
            </div>
            <div>
              <span className="text-muted-foreground">Used today</span>
              <p className="font-semibold">{fmtUGX(cap.used_today ?? cap.allocated_today ?? 0)}</p>
            </div>
            <div>
              <span className="text-muted-foreground">Remaining</span>
              <p className="font-semibold text-primary">{fmtUGX(cap.remaining ?? 0)}</p>
            </div>
            <div>
              <span className="text-muted-foreground">Active rent plans</span>
              <p className="font-semibold">{cap.active_requests ?? cap.open_requests ?? 0}</p>
            </div>
          </div>
        </Card>
      )}

      <Card className="p-3 space-y-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <ReceiptText className="h-4 w-4 text-primary" /> Portfolio
        </div>
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div><span className="text-muted-foreground">Tenants managed</span><p className="font-semibold">{stats?.tenantCount ?? 0}</p></div>
          <div><span className="text-muted-foreground">Rent under mgmt</span><p className="font-semibold">{fmtUGX(stats?.totalRent ?? 0)}</p></div>
          <div><span className="text-muted-foreground">Linked landlords</span><p className="font-semibold">{stats?.landlords?.length ?? 0}</p></div>
          <div><span className="text-muted-foreground">Proxy landlords</span><p className="font-semibold">{stats?.proxyLandlords ?? 0}</p></div>
        </div>
      </Card>

      {/* Toggle between tenants and linked landlords */}
      <div className="flex items-center gap-2 rounded-md bg-muted/30 p-1.5 border border-border/40">
        <button
          type="button"
          onClick={() => setViewMode('tenants')}
          className={`flex-1 flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-colors ${
            viewMode === 'tenants'
              ? 'bg-background text-foreground shadow-sm border border-border/60'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          <Users className="h-3.5 w-3.5" /> Tenants
          <Badge variant="outline" className="text-[9px] ml-0.5">{stats?.tenantCount ?? 0}</Badge>
        </button>
        <button
          type="button"
          onClick={() => setViewMode('landlords')}
          className={`flex-1 flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-colors ${
            viewMode === 'landlords'
              ? 'bg-background text-foreground shadow-sm border border-border/60'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          <Building2 className="h-3.5 w-3.5" /> Linked landlords
          <Badge variant="outline" className="text-[9px] ml-0.5">{stats?.landlords?.length ?? 0}</Badge>
        </button>
        <button
          type="button"
          onClick={() => setViewMode('listings')}
          className={`flex-1 flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-colors ${
            viewMode === 'listings'
              ? 'bg-background text-foreground shadow-sm border border-border/60'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          <Building2 className="h-3.5 w-3.5" /> Houses listed
          <Badge variant="outline" className="text-[9px] ml-0.5">{listings.length}</Badge>
        </button>
      </div>

      {viewMode === 'tenants' && (
        <AgentTenantsList agentId={agentId} onSelectTenant={onSelectTenant} />
      )}

      {viewMode === 'landlords' && (
        <Card className="p-3 space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Building2 className="h-4 w-4 text-primary" /> Linked landlords
            </div>
            <Badge variant="outline" className="text-[10px]">{stats?.landlords?.length ?? 0}</Badge>
          </div>
          {(stats?.landlords ?? []).length === 0 ? (
            <p className="text-xs text-muted-foreground">No landlords linked yet.</p>
          ) : (
            <ul className="space-y-1 text-xs">
              {(stats?.landlords ?? []).map((a: any) => (
                <li key={a.landlord_id} className="flex justify-between border-b border-border/40 py-1 gap-2">
                  <button
                    type="button"
                    onClick={() => onSelectLandlord?.(a.landlord_id)}
                    className="truncate text-left text-primary hover:underline disabled:no-underline disabled:text-foreground"
                    disabled={!onSelectLandlord}
                  >
                    {a.landlords?.name ?? a.landlord_id}
                  </button>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-muted-foreground font-mono">{a.landlords?.phone ?? '—'}</span>
                    <ContactActions phone={a.landlords?.phone} size="xs" message={`Hello ${a.landlords?.name ?? ''}, this is Welile Ops.`} />
                  </div>
                </li>
              ))}
            </ul>
          )}

          {isOps && (
            <div className="pt-2 border-t border-border/40 space-y-2">
              <UserSearchPicker
                label="+ Link landlord"
                selectedUser={linkLandlord as any}
                onSelect={(u) => setLinkLandlord(u as any)}
                roleFilter="landlord"
              />
              <Input
                placeholder="Reason (min 10 chars)"
                value={linkReason}
                onChange={(e) => setLinkReason(e.target.value)}
                className="h-8 text-sm"
              />
              <Button
                size="sm" className="w-full"
                disabled={!linkLandlord || link.isPending}
                onClick={() => link.mutate()}
              >
                {link.isPending ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Plus className="h-3 w-3 mr-1" />}
                Link landlord
              </Button>
            </div>
          )}
        </Card>
      )}

      {viewMode === 'listings' && (
        <Card className="p-3 space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Building2 className="h-4 w-4 text-primary" /> Houses listed
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="text-[10px]">
                {filteredListings.length}{listings.length !== filteredListings.length ? ` / ${listings.length}` : ''}
              </Badge>
              <button
                type="button"
                onClick={() => refetchListings()}
                disabled={listingsFetching}
                className="p-1 rounded-md hover:bg-muted transition-colors disabled:opacity-50"
                title="Refresh listings"
              >
                {listingsFetching ? <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" /> : <RefreshCw className="h-3.5 w-3.5 text-muted-foreground" />}
              </button>
            </div>
          </div>

          {/* Search & Filters */}
          <div className="space-y-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                placeholder="Search title, village, district, landlord..."
                value={listingsSearch}
                onChange={(e) => setListingsSearch(e.target.value)}
                className="h-8 pl-8 text-xs"
              />
              {listingsSearch && (
                <button
                  type="button"
                  onClick={() => setListingsSearch('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-muted"
                >
                  <X className="h-3 w-3 text-muted-foreground" />
                </button>
              )}
            </div>

            <div className="flex items-center gap-1.5 flex-wrap">
              <Select value={listingsStatusFilter} onValueChange={setListingsStatusFilter}>
                <SelectTrigger className="h-7 text-[11px] w-auto min-w-[90px] px-2">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all" className="text-xs">All statuses</SelectItem>
                  {statusOptions.map((s) => (
                    <SelectItem key={s} value={s} className="text-xs">{s}</SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select value={listingsLocationFilter} onValueChange={setListingsLocationFilter}>
                <SelectTrigger className="h-7 text-[11px] w-auto min-w-[100px] px-2">
                  <SelectValue placeholder="Location" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all" className="text-xs">All locations</SelectItem>
                  {locationOptions.map((loc) => (
                    <SelectItem key={loc} value={loc} className="text-xs">{loc}</SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <div className="flex-1 min-w-[180px]">
                <StatementDateFilter value={listingsDateRange} onChange={setListingsDateRange} />
              </div>

              {(listingsSearch || listingsStatusFilter !== 'all' || listingsLocationFilter !== 'all' || listingsDateRange.preset !== 'this_month') && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-[11px] px-2"
                  onClick={() => {
                    setListingsSearch('');
                    setListingsStatusFilter('all');
                    setListingsLocationFilter('all');
                    setListingsDateRange({ preset: 'this_month' });
                  }}
                >
                  <X className="h-3 w-3 mr-1" /> Clear
                </Button>
              )}
            </div>
          </div>

          {filteredListings.length === 0 ? (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                {listings.length === 0
                  ? 'No house listings found for this agent.'
                  : `No listings match your filters (${listings.length} total).`}
              </p>
              <div className="rounded-md bg-muted/40 p-2.5 space-y-1 text-[11px] text-muted-foreground">
                <p className="font-medium text-foreground text-xs">What we looked for:</p>
                <ul className="list-disc list-inside space-y-0.5">
                  <li>Records in <span className="font-mono text-[10px] bg-muted px-1 rounded">house_listings</span> where <span className="font-mono text-[10px] bg-muted px-1 rounded">agent_id</span> matches this agent.</li>
                  <li>If this agent has multiple profile IDs (same phone), those are included too.</li>
                </ul>
                <p className="pt-1">If houses were recently added, tap the refresh button above.</p>
              </div>
            </div>
          ) : (
            <ul className="space-y-2 text-xs">
              {filteredListings.map((l: any) => (
              <li key={l.id} className="border border-border/40 rounded-md p-2 space-y-1">
                  {Array.isArray(l.image_urls) && l.image_urls.length > 0 && (
                    <div className="flex gap-1 overflow-x-auto pb-1 -mx-1 px-1">
                      {l.image_urls.slice(0, 6).map((src: string, i: number) => (
                        <a
                          key={i}
                          href={src}
                          target="_blank"
                          rel="noreferrer"
                          className="shrink-0"
                        >
                          <img
                            src={src}
                            alt={`${l.title} photo ${i + 1}`}
                            loading="lazy"
                            className="h-16 w-20 object-cover rounded border border-border/40"
                          />
                        </a>
                      ))}
                    </div>
                  )}
                  <div className="flex justify-between gap-2">
                    <span className="truncate font-medium">{l.title}</span>
                    <span className="font-semibold whitespace-nowrap">{fmtUGX(l.monthly_rent)}</span>
                  </div>
                  <div className="flex justify-between items-center gap-2">
                    <span className="text-muted-foreground truncate">{l.village ?? l.district ?? '—'}</span>
                    <Badge variant="outline" className="text-[9px]">{l.status}</Badge>
                  </div>
                  <div className="flex justify-between items-center gap-2 pt-1 border-t border-border/30">
                    <span className="text-muted-foreground">Landlord:</span>
                    {l.landlord_id ? (
                      <button
                        type="button"
                        onClick={() => onSelectLandlord?.(l.landlord_id)}
                        className="text-primary hover:underline truncate text-right disabled:no-underline disabled:text-foreground"
                        disabled={!onSelectLandlord}
                      >
                        {l.landlord?.name ?? l.landlord_id}
                      </button>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </div>
                  {l.landlord?.phone && (
                    <div className="flex items-center gap-2 flex-wrap pl-1">
                      <span className="text-muted-foreground text-[10px] font-mono">{l.landlord.phone}</span>
                      <ContactActions phone={l.landlord.phone} size="xs" message={`Hello ${l.landlord?.name ?? ''}, this is Welile Ops about ${l.title ?? 'your listing'}.`} />
                    </div>
                  )}
                  <div className="pt-1">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-7 text-[11px] w-full"
                      onClick={() => setPhotoUploadFor(l)}
                    >
                      <ImagePlus className="h-3 w-3 mr-1" />
                      Add photos ({Array.isArray(l.image_urls) ? l.image_urls.length : 0})
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {/* Network — partners onboarded & referrals */}
      <Card className="p-3 space-y-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Users className="h-4 w-4 text-primary" /> Network
        </div>
        <div className="grid grid-cols-3 gap-2 text-xs">
          <div>
            <span className="text-muted-foreground">Partners onboarded</span>
            <p className="font-semibold">{stats?.partnersOnboarded ?? 0}</p>
          </div>
          <div>
            <span className="text-muted-foreground">Managed accounts</span>
            <p className="font-semibold">{stats?.managedAccounts ?? 0}</p>
          </div>
          <div>
            <span className="text-muted-foreground flex items-center gap-1">
              <Sparkles className="h-3 w-3" /> Referrals
            </span>
            <p className="font-semibold">{stats?.referralCount ?? 0}</p>
          </div>
        </div>
      </Card>
      {photoUploadFor && (
        <ListingPhotoUploadDialog
          open={!!photoUploadFor}
          onOpenChange={(v) => { if (!v) setPhotoUploadFor(null); }}
          listingId={photoUploadFor.id}
          listingTitle={photoUploadFor.title}
          existingUrls={Array.isArray(photoUploadFor.image_urls) ? photoUploadFor.image_urls : []}
          district={photoUploadFor.district ?? undefined}
          village={photoUploadFor.village ?? undefined}
          invalidateKeys={[
            ['drilldown-agent-listings', agentId],
            ['drilldown-landlord-listings', photoUploadFor.landlord_id],
          ]}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Landlord pane                                                       */
/* ------------------------------------------------------------------ */
function LandlordPane({ landlordId, isOps }: { landlordId: string; isOps: boolean }) {
  const qc = useQueryClient();
  const [photoUploadFor, setPhotoUploadFor] = useState<any | null>(null);
  const [galleryPage, setGalleryPage] = useState(0);

  useEffect(() => { setGalleryPage(0); }, [landlordId]);
  const { data: landlord, isLoading } = useQuery({
    queryKey: ['drilldown-landlord', landlordId],
    queryFn: async () => {
      const { data } = await supabase.from('landlords')
        .select('id, name, phone, mobile_money_number, mobile_money_name, property_address, monthly_rent, verified, has_smartphone, caretaker_name, caretaker_phone, district, sub_county, village, bank_name, account_number, description, number_of_rooms, electricity_meter_number, water_meter_number, house_number')
        .eq('id', landlordId).maybeSingle();
      return data;
    },
  });

  const { data: listings = [] } = useQuery({
    queryKey: ['drilldown-landlord-listings', landlordId],
    queryFn: async () => {
      const { data } = await supabase
        .from('house_listings')
        .select('id, title, monthly_rent, status, village, district, address, image_urls, created_at')
        .eq('landlord_id', landlordId).limit(50);
      return data ?? [];
    },
  });

  const { data: funderLinks = [] } = useQuery({
    queryKey: ['drilldown-landlord-funders', landlordId],
    queryFn: async () => {
      const { data } = await supabase
        .from('landlord_funder_links')
        .select('id, funder_id, reason, created_at, active')
        .eq('landlord_id', landlordId).eq('active', true);
      const ids = (data ?? []).map((r: any) => r.funder_id);
      if (!ids.length) return [];
      const { data: profs } = await supabase
        .from('profiles').select('id, full_name, phone').in('id', ids);
      const map = new Map((profs ?? []).map((p: any) => [p.id, p]));
      return (data ?? []).map((r: any) => ({ ...r, funder: map.get(r.funder_id) ?? null }));
    },
  });

  // Placed tenants under this landlord — used to derive the annual
  // payable (rent owed to the landlord) and receivable (collected from
  // the rental). "Placed" = a tenant is actually in the house.
  const { data: placed = [] } = useQuery({
    queryKey: ['drilldown-landlord-placed', landlordId],
    queryFn: async () => {
      const { data } = await supabase
        .from('rent_requests')
        .select('id, tenant_id, rent_amount, daily_repayment, status, created_at')
        .eq('landlord_id', landlordId)
        .in('status', ['funded', 'repaying', 'active', 'completed'])
        .order('created_at', { ascending: false })
        .limit(500);
      const rows = data ?? [];
      const ids = Array.from(new Set(rows.map((r: any) => r.tenant_id).filter(Boolean)));
      let nameMap = new Map<string, any>();
      if (ids.length) {
        const { data: profs } = await supabase
          .from('profiles').select('id, full_name, phone').in('id', ids);
        nameMap = new Map((profs ?? []).map((p: any) => [p.id, p]));
      }
      // Recorded A/C entries (payable + receivable) from the dedicated
      // landlord sub-ledger.
      const { data: recorded } = await supabase
        .from('landlord_account_ledger')
        .select('rent_request_id, entry_type, amount, updated_at')
        .eq('landlord_id', landlordId);
      const payableMap = new Map(
        (recorded ?? []).filter((r: any) => r.entry_type === 'payable')
          .map((r: any) => [r.rent_request_id, r]),
      );
      const receivableMap = new Map(
        (recorded ?? []).filter((r: any) => r.entry_type === 'receivable')
          .map((r: any) => [r.rent_request_id, r]),
      );
      return rows.map((r: any) => {
        const monthlyRent = Number(r.rent_amount || 0);
        const dailyRent = Number(r.daily_repayment || 0);
        const recPay = payableMap.get(r.id) as any;
        const recRec = receivableMap.get(r.id) as any;
        return {
          ...r,
          tenant: nameMap.get(r.tenant_id) ?? null,
          monthlyRent,
          dailyRent,
          // Annual payable to the landlord = monthly rent × 12 months.
          annualPayable: monthlyRent * 12,
          // Annual receivable from the rental = daily rent × 30 days × 12 months.
          annualReceivable: dailyRent * 30 * 12,
          // Recorded amounts from the sub-ledger (null if not yet generated).
          recordedPayable: recPay ? Number(recPay.amount) : null,
          recordedReceivable: recRec ? Number(recRec.amount) : null,
        };
      });
    },
  });

  const accountTotals = useMemo(() => {
    return (placed as any[]).reduce(
      (acc, r) => {
        acc.payable += r.annualPayable;
        acc.receivable += r.annualReceivable;
        if (r.recordedPayable != null) { acc.recordedPayable += r.recordedPayable; acc.recordedCount += 1; }
        if (r.recordedReceivable != null) { acc.recordedReceivable += r.recordedReceivable; acc.recordedRecvCount += 1; }
        return acc;
      },
      { payable: 0, receivable: 0, recordedPayable: 0, recordedCount: 0, recordedReceivable: 0, recordedRecvCount: 0 },
    );
  }, [placed]);

  const [linkFunder, setLinkFunder] = useState<UserBrief | null>(null);
  const [linkReason, setLinkReason] = useState('');
  const link = useMutation({
    mutationFn: async () => {
      if (!linkFunder) throw new Error('Pick a funder');
      if (linkReason.trim().length < 10) throw new Error('Reason ≥ 10 chars');
      const { error } = await supabase.rpc('ops_link_landlord_funder', {
        p_landlord_id: landlordId,
        p_funder_id: linkFunder.id,
        p_reason: linkReason.trim(),
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Funder linked');
      setLinkFunder(null); setLinkReason('');
      qc.invalidateQueries({ queryKey: ['drilldown-landlord-funders', landlordId] });
    },
    onError: (e: any) => toast.error(e.message ?? 'Link failed'),
  });

  const [lightbox, setLightbox] = useState<{
    images: string[];
    index: number;
    title: string;
    open: boolean;
  }>({ images: [], index: 0, title: '', open: false });

  const openLightbox = (images: string[], startIndex: number, title: string) => {
    setLightbox({ images, index: startIndex, title, open: true });
  };
  const closeLightbox = () => setLightbox((s) => ({ ...s, open: false }));
  const prevImage = () => setLightbox((s) => ({ ...s, index: (s.index - 1 + s.images.length) % s.images.length }));
  const nextImage = () => setLightbox((s) => ({ ...s, index: (s.index + 1) % s.images.length }));

  if (isLoading) return <Loader2 className="h-4 w-4 animate-spin mx-auto" />;

  return (
    <div className="space-y-3">
      <Card className="p-3 space-y-1.5">
        <div className="flex items-center justify-between">
          <p className="text-base font-semibold truncate">{landlord?.name ?? 'Unknown landlord'}</p>
          {landlord?.verified && (
            <Badge className="text-[10px] bg-emerald-100 text-emerald-700 border-emerald-200">Verified</Badge>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-muted-foreground font-mono">{landlord?.phone ?? '— no phone —'}</span>
          <ContactActions phone={landlord?.phone} size="xs" message={`Hello ${landlord?.name ?? ''}, this is Welile Ops.`} />
        </div>
        <p className="text-xs text-muted-foreground">MoMo: <span className="font-mono">{landlord?.mobile_money_number ?? '—'}</span></p>
        <p className="text-xs text-muted-foreground">Address: {landlord?.property_address}</p>
        {landlord?.monthly_rent != null && (
          <p className="text-xs">Default rent: <b>{fmtUGX(landlord.monthly_rent)}</b></p>
        )}
        {landlord?.caretaker_phone && (
          <div className="flex items-center gap-2 flex-wrap pt-1 border-t border-border/40 mt-1">
            <span className="text-xs text-muted-foreground">
              Caretaker: <span className="font-medium text-foreground">{landlord?.caretaker_name ?? '—'}</span> · <span className="font-mono">{landlord.caretaker_phone}</span>
            </span>
            <ContactActions phone={landlord.caretaker_phone} size="xs" message={`Hello ${landlord?.caretaker_name ?? 'caretaker'}, this is Welile Ops.`} />
          </div>
        )}
        <LandlordSmartphoneToggle landlordId={landlordId} initial={landlord?.has_smartphone ?? true} canEdit={isOps} />
        <LandlordEditCard landlordId={landlordId} landlord={landlord} canEdit={isOps} />
      </Card>

      <LandlordChangeHistory landlordId={landlordId} visible={isOps} />

      <LandlordAgreementHistory
        landlordId={landlordId}
        landlordName={landlord?.name ?? ''}
        landlordPhone={landlord?.phone ?? ''}
        propertyAddress={landlord?.property_address}
        monthlyRent={landlord?.monthly_rent}
        canAdd={isOps}
      />

      {/* Landlord Account (Annual) — admin-side payable & receivable */}
      <Card className="p-3 space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-medium">
            <ReceiptText className="h-4 w-4 text-primary" /> Landlord account (annual)
          </div>
          <Badge variant="outline" className="text-[10px]">{(placed as any[]).length} placed</Badge>
        </div>
        <p className="text-[11px] text-muted-foreground leading-relaxed">
          Payable = monthly rent × 12 (rent Welile owes this landlord per year).
          Receivable = daily rent × 30 × 12 (collected from the rental per year).
        </p>
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-md border border-amber-200 dark:border-amber-900 bg-amber-50/60 dark:bg-amber-950/40 p-2">
            <div className="flex items-center justify-between">
              <p className="text-[10px] uppercase tracking-wide text-amber-700 dark:text-amber-300">Payable A/C</p>
              {accountTotals.recordedCount > 0 && (
                <Badge variant="outline" className="text-[8px] border-amber-300 text-amber-700 dark:text-amber-300">{accountTotals.recordedCount} recorded</Badge>
              )}
            </div>
            <p className="text-sm font-semibold text-amber-800 dark:text-amber-200">
              {fmtUGX(accountTotals.recordedCount > 0 ? accountTotals.recordedPayable : accountTotals.payable)}
            </p>
          </div>
          <div className="rounded-md border border-emerald-200 dark:border-emerald-900 bg-emerald-50/60 dark:bg-emerald-950/40 p-2">
            <div className="flex items-center justify-between">
              <p className="text-[10px] uppercase tracking-wide text-emerald-700 dark:text-emerald-300">Receivable A/C</p>
              {accountTotals.recordedRecvCount > 0 && (
                <Badge variant="outline" className="text-[8px] border-emerald-300 text-emerald-700 dark:text-emerald-300">{accountTotals.recordedRecvCount} recorded</Badge>
              )}
            </div>
            <p className="text-sm font-semibold text-emerald-800 dark:text-emerald-200">
              {fmtUGX(accountTotals.recordedRecvCount > 0 ? accountTotals.recordedReceivable : accountTotals.receivable)}
            </p>
          </div>
        </div>
        {(placed as any[]).length === 0 ? (
          <p className="text-xs text-muted-foreground">No placed tenants recorded for this landlord.</p>
        ) : (
          <ul className="space-y-1.5 text-xs">
            {(placed as any[]).map((r) => (
              <li key={r.id} className="border border-border/40 rounded-md p-2 space-y-1">
                <div className="flex justify-between gap-2">
                  <span className="truncate font-medium">{r.tenant?.full_name ?? 'Tenant'}</span>
                  <Badge variant="outline" className="text-[9px] capitalize shrink-0">{r.status}</Badge>
                </div>
                <div className="flex justify-between text-[11px] text-muted-foreground">
                  <span>Monthly {fmtUGX(r.monthlyRent)} · Daily {fmtUGX(r.dailyRent)}</span>
                </div>
                <div className="flex justify-between text-[11px]">
                  <span className="text-amber-700 dark:text-amber-300">
                    Payable {fmtUGX(r.recordedPayable ?? r.annualPayable)}
                    {r.recordedPayable != null && <span className="ml-1 text-[9px] opacity-70">●</span>}
                  </span>
                  <span className="text-emerald-700 dark:text-emerald-300">
                    Receivable {fmtUGX(r.recordedReceivable ?? r.annualReceivable)}
                    {r.recordedReceivable != null && <span className="ml-1 text-[9px] opacity-70">●</span>}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="p-3 space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Building2 className="h-4 w-4 text-primary" /> Rentals listed
          </div>
          <Badge variant="outline" className="text-[10px]">{listings.length}</Badge>
        </div>
        {(() => {
          const gallery = listings.flatMap((l: any) =>
            (Array.isArray(l.image_urls) ? l.image_urls : []).map((src: string, idx: number) => ({
              src,
              title: l.title,
              location: l.village ?? l.district ?? l.address ?? '',
              images: l.image_urls,
              startIndex: idx,
            }))
          );
          if (gallery.length === 0) {
            return (
              <div className="rounded-md bg-muted/30 p-3 space-y-1.5">
                <div className="flex items-start gap-2">
                  <Info className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
                  <div className="space-y-1">
                    <p className="text-xs font-medium">No house photos yet</p>
                    <p className="text-[11px] text-muted-foreground leading-relaxed">
                      This landlord&apos;s listings do not have any images. Agents typically upload house
                      photos during the onboarding visit or from the agent dashboard.
                    </p>
                  </div>
                </div>
                <p className="text-[11px] text-muted-foreground pl-6">
                  To add photos, tap <strong className="text-foreground">Add photos</strong> on any listing below.
                </p>
              </div>
            );
          }
          const PAGE_SIZE = 15;
          const totalPages = Math.ceil(gallery.length / PAGE_SIZE);
          const clampedPage = Math.min(galleryPage, totalPages - 1);
          const pageGallery = gallery.slice(clampedPage * PAGE_SIZE, (clampedPage + 1) * PAGE_SIZE);
          return (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-[11px] uppercase tracking-wide text-muted-foreground">Photo gallery</span>
                <Badge variant="outline" className="text-[9px]">
                  {clampedPage * PAGE_SIZE + 1}-{Math.min((clampedPage + 1) * PAGE_SIZE, gallery.length)} of {gallery.length}
                </Badge>
              </div>
              <div className="grid grid-cols-3 gap-1">
                {pageGallery.map((g, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => openLightbox(g.images, g.startIndex, g.title)}
                    className="relative group block aspect-square overflow-hidden rounded border border-border/40 text-left"
                    title={`${g.title}${g.location ? ' · ' + g.location : ''}`}
                  >
                    <img
                      src={g.src}
                      alt={g.title}
                      loading="lazy"
                      className="h-full w-full object-cover transition-transform group-hover:scale-105"
                    />
                    <div className="absolute inset-x-0 bottom-0 bg-black/60 px-1 py-0.5 text-[9px] text-white truncate opacity-0 group-hover:opacity-100">
                      {g.title}
                    </div>
                  </button>
                ))}
              </div>
              {totalPages > 1 && (
                <div className="flex items-center justify-between pt-1">
                  <button
                    type="button"
                    onClick={() => setGalleryPage((p) => Math.max(0, p - 1))}
                    disabled={clampedPage === 0}
                    className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    <ChevronLeft className="h-3.5 w-3.5" /> Prev
                  </button>
                  <span className="text-[10px] text-muted-foreground">
                    Page {clampedPage + 1} of {totalPages}
                  </span>
                  <button
                    type="button"
                    onClick={() => setGalleryPage((p) => Math.min(totalPages - 1, p + 1))}
                    disabled={clampedPage >= totalPages - 1}
                    className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    Next <ChevronRight className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
            </div>
          );
        })()}
        {listings.length === 0 ? (
          <p className="text-xs text-muted-foreground">No listings recorded.</p>
        ) : (
          <ul className="space-y-2 text-xs">
            {listings.map((l: any) => (
              <li key={l.id} className="border border-border/40 rounded-md p-2 space-y-1.5">
                {Array.isArray(l.image_urls) && l.image_urls.length > 0 ? (
                  <div className="flex gap-1 overflow-x-auto pb-1 -mx-1 px-1">
                    {l.image_urls.slice(0, 8).map((src: string, i: number) => (
                      <button
                        key={i}
                        type="button"
                        onClick={() => openLightbox(l.image_urls, i, l.title)}
                        className="shrink-0"
                      >
                        <img
                          src={src}
                          alt={`${l.title} photo ${i + 1}`}
                          loading="lazy"
                          className="h-20 w-24 object-cover rounded border border-border/40"
                        />
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="rounded border border-dashed border-border/40 bg-muted/20 p-2.5 space-y-1">
                    <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                      <ImagePlus className="h-3.5 w-3.5" />
                      <span className="font-medium">No photos yet</span>
                    </div>
                    <p className="text-[10px] text-muted-foreground leading-relaxed">
                      Images help tenants evaluate the property and boost trust scores.
                      Tap <strong className="text-foreground">Add photos</strong> below to upload.
                    </p>
                  </div>
                )}
                <div className="flex justify-between gap-2">
                  <span className="truncate flex-1 font-medium">{l.title}</span>
                  <span className="font-semibold whitespace-nowrap">{fmtUGX(l.monthly_rent)}</span>
                </div>
                <div className="flex justify-between items-center gap-2">
                  <span className="text-muted-foreground truncate">{l.village ?? l.district ?? l.address ?? '—'}</span>
                  <Badge variant="outline" className="text-[9px]">{l.status}</Badge>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 text-[11px] w-full"
                  onClick={() => setPhotoUploadFor(l)}
                >
                  <ImagePlus className="h-3 w-3 mr-1" />
                  Add photos ({Array.isArray(l.image_urls) ? l.image_urls.length : 0})
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="p-3 space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Link2 className="h-4 w-4 text-primary" /> Linked funders
          </div>
          <Badge variant="outline" className="text-[10px]">{funderLinks.length}</Badge>
        </div>
        {funderLinks.length === 0 ? (
          <p className="text-xs text-muted-foreground">No funders linked yet.</p>
        ) : (
          <ul className="space-y-1 text-xs">
            {funderLinks.map((l: any) => (
              <li key={l.id} className="flex justify-between border-b border-border/40 py-1">
                <span className="truncate">{l.funder?.full_name ?? l.funder_id}</span>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-muted-foreground font-mono">{l.funder?.phone ?? '—'}</span>
                  <ContactActions phone={l.funder?.phone} size="xs" message={`Hello ${l.funder?.full_name ?? ''}, this is Welile Ops.`} />
                </div>
              </li>
            ))}
          </ul>
        )}

        {isOps && (
          <div className="pt-2 border-t border-border/40 space-y-2">
            <UserSearchPicker
              label="+ Link funder"
              selectedUser={linkFunder as any}
              onSelect={(u) => setLinkFunder(u as any)}
              roleFilter="supporter"
            />
            <Input
              placeholder="Reason (min 10 chars)"
              value={linkReason}
              onChange={(e) => setLinkReason(e.target.value)}
              className="h-8 text-sm"
            />
            <Button
              size="sm" className="w-full"
              disabled={!linkFunder || link.isPending}
              onClick={() => link.mutate()}
            >
              {link.isPending ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Plus className="h-3 w-3 mr-1" />}
              Link funder
            </Button>
          </div>
        )}
      </Card>

      <Card className="p-3 space-y-1">
        <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <Link2 className="h-4 w-4" /> LC1 chairperson
        </div>
        <p className="text-xs text-muted-foreground italic">Coming soon — confirm data model to enable.</p>
      </Card>

      {/* Full-screen lightbox */}
      {lightbox.open && (
        <div
          className="fixed inset-0 z-[100] bg-black/95 flex flex-col"
          onClick={(e) => { if (e.target === e.currentTarget) closeLightbox(); }}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3">
            <div className="min-w-0">
              <p className="text-sm text-white font-medium truncate">{lightbox.title}</p>
              <p className="text-[11px] text-white/60">
                {lightbox.index + 1} / {lightbox.images.length}
              </p>
            </div>
            <button
              type="button"
              onClick={closeLightbox}
              className="p-2 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors"
              aria-label="Close"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          {/* Image stage */}
          <div className="flex-1 flex items-center justify-center px-4 relative">
            {lightbox.images.length > 1 && (
              <button
                type="button"
                onClick={prevImage}
                className="absolute left-2 sm:left-4 p-2 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors z-10"
                aria-label="Previous"
              >
                <ChevronLeft className="h-6 w-6" />
              </button>
            )}
            <img
              src={lightbox.images[lightbox.index]}
              alt={`${lightbox.title} ${lightbox.index + 1}`}
              className="max-h-full max-w-full object-contain rounded"
              onClick={(e) => e.stopPropagation()}
            />
            {lightbox.images.length > 1 && (
              <button
                type="button"
                onClick={nextImage}
                className="absolute right-2 sm:right-4 p-2 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors z-10"
                aria-label="Next"
              >
                <ChevronRight className="h-6 w-6" />
              </button>
            )}
          </div>

          {/* Thumbnail strip */}
          {lightbox.images.length > 1 && (
            <div className="flex gap-1 overflow-x-auto px-4 py-3 justify-center">
              {lightbox.images.map((src, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => setLightbox((s) => ({ ...s, index: i }))}
                  className={`shrink-0 rounded border-2 overflow-hidden ${i === lightbox.index ? 'border-primary' : 'border-transparent'}`}
                >
                  <img
                    src={src}
                    alt={`thumb ${i + 1}`}
                    className="h-12 w-16 object-cover"
                  />
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {photoUploadFor && (
        <ListingPhotoUploadDialog
          open={!!photoUploadFor}
          onOpenChange={(v) => { if (!v) setPhotoUploadFor(null); }}
          listingId={photoUploadFor.id}
          listingTitle={photoUploadFor.title}
          existingUrls={Array.isArray(photoUploadFor.image_urls) ? photoUploadFor.image_urls : []}
          district={photoUploadFor.district ?? undefined}
          village={photoUploadFor.village ?? undefined}
          invalidateKeys={[
            ['drilldown-landlord-listings', landlordId],
          ]}
        />
      )}
    </div>
  );
}

function LandlordSmartphoneToggle({
  landlordId, initial, canEdit,
}: { landlordId: string; initial: boolean; canEdit: boolean }) {
  const qc = useQueryClient();
  const [val, setVal] = useState<boolean>(initial);
  const [reason, setReason] = useState('');
  const [editing, setEditing] = useState(false);
  const save = useMutation({
    mutationFn: async (next: boolean) => {
      if (reason.trim().length < 10) throw new Error('Reason must be ≥ 10 characters');
      const { error } = await supabase.rpc('ops_update_landlord_smartphone', {
        p_landlord_id: landlordId,
        p_has_smartphone: next,
        p_reason: reason.trim(),
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Smartphone flag updated');
      setEditing(false); setReason('');
      qc.invalidateQueries({ queryKey: ['drilldown-landlord', landlordId] });
    },
    onError: (e: any) => toast.error(e.message ?? 'Update failed'),
  });

  return (
    <div className="mt-1 pt-2 border-t border-border/40 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs">
          {val ? <Smartphone className="h-3.5 w-3.5 text-emerald-600" /> : <SmartphoneNfc className="h-3.5 w-3.5 text-amber-600" />}
          <span className="font-medium">{val ? 'Has smartphone' : 'No smartphone (USSD / agent-led)'}</span>
        </div>
        {canEdit && (
          <Switch
            checked={val}
            onCheckedChange={(v) => { setVal(v); setEditing(true); }}
          />
        )}
      </div>
      {canEdit && editing && (
        <div className="space-y-1.5">
          <Input
            placeholder="Reason (min 10 chars)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="h-8 text-xs"
          />
          <div className="flex gap-2">
            <Button size="sm" className="flex-1 h-7"
              disabled={save.isPending || reason.trim().length < 10}
              onClick={() => save.mutate(val)}>
              {save.isPending ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
              Save
            </Button>
            <Button size="sm" variant="ghost" className="h-7"
              onClick={() => { setVal(initial); setEditing(false); setReason(''); }}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Recent wallet ledger statements for an agent (mirrors what the     */
/* agent sees on their own wallet dashboard).                          */
/* ------------------------------------------------------------------ */
function AgentWalletStatements({ agentId }: { agentId: string }) {
  return <AgentWalletStatementsInner agentId={agentId} />;
}

/* ------------------------------------------------------------------ */
/* Per-advance detail for an agent — principal, outstanding, status,  */
/* daily deduction and days remaining for every advance on file.      */
/* ------------------------------------------------------------------ */
const ADVANCE_STATUS_META: Record<string, { label: string; variant: 'default' | 'secondary' | 'destructive' }> = {
  active: { label: 'Active', variant: 'default' },
  outstanding: { label: 'Outstanding', variant: 'default' },
  approved: { label: 'Approved', variant: 'default' },
  disbursed: { label: 'Disbursed', variant: 'default' },
  overdue: { label: 'Overdue', variant: 'destructive' },
  completed: { label: 'Completed', variant: 'secondary' },
};

function AgentAdvancesDetail({ agentId }: { agentId: string }) {
  const { data: advances = [], isLoading } = useQuery({
    queryKey: ['drilldown-agent-advances', agentId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('agent_advances')
        .select('id, principal, outstanding_balance, status, issued_at, expires_at, created_at')
        .eq('agent_id', agentId)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });

  if (isLoading) {
    return (
      <Card className="p-3">
        <Loader2 className="h-4 w-4 animate-spin mx-auto text-muted-foreground" />
      </Card>
    );
  }

  if (advances.length === 0) {
    return (
      <Card className="p-3">
        <div className="flex items-center gap-2 text-sm font-medium mb-1">
          <TrendingUp className="h-4 w-4 text-amber-600" /> Advances
        </div>
        <p className="text-xs text-muted-foreground">No advances on file for this agent.</p>
      </Card>
    );
  }

  const totalOutstanding = advances
    .filter((a: any) => a.status !== 'completed')
    .reduce((s: number, a: any) => s + Number(a.outstanding_balance || 0), 0);

  return (
    <Card className="p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium">
          <TrendingUp className="h-4 w-4 text-amber-600" /> Advances ({advances.length})
        </div>
        {totalOutstanding > 0 && (
          <span className="text-[11px] text-amber-700 font-semibold">
            {fmtUGX(totalOutstanding)} outstanding
          </span>
        )}
      </div>
      <div className="space-y-2">
        {advances.map((adv: any) => {
          const meta = ADVANCE_STATUS_META[adv.status] || ADVANCE_STATUS_META.active;
          const daysLeft = adv.expires_at
            ? Math.max(0, Math.ceil((new Date(adv.expires_at).getTime() - Date.now()) / 86400000))
            : 0;
          const interest = Math.max(0, Number(adv.outstanding_balance || 0) - Number(adv.principal || 0));
          const dailyDeduction = adv.status === 'completed'
            ? 0
            : daysLeft > 0
              ? Math.round(Number(adv.outstanding_balance || 0) / daysLeft)
              : Number(adv.outstanding_balance || 0);
          return (
            <div key={adv.id} className="rounded-md bg-muted/40 p-2 space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold">{fmtUGX(adv.principal)}</span>
                <Badge variant={meta.variant} className="text-[10px]">{meta.label}</Badge>
              </div>
              <div className="grid grid-cols-3 gap-2 text-center text-[11px]">
                <div>
                  <p className="text-[9px] uppercase tracking-wider text-muted-foreground">Owed</p>
                  <p className="font-semibold">{fmtUGX(adv.outstanding_balance)}</p>
                </div>
                <div>
                  <p className="text-[9px] uppercase tracking-wider text-muted-foreground">Daily</p>
                  <p className="font-semibold text-red-600">{adv.status === 'completed' ? '—' : fmtUGX(dailyDeduction)}</p>
                </div>
                <div>
                  <p className="text-[9px] uppercase tracking-wider text-muted-foreground">Days left</p>
                  <p className="font-semibold">{adv.status === 'completed' ? '—' : `${daysLeft}d`}</p>
                </div>
              </div>
              <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                <span>
                  Issued {adv.issued_at ? new Date(adv.issued_at).toLocaleDateString() : '—'}
                </span>
                {interest > 0 && adv.status !== 'completed' && (
                  <span>Incl. {fmtUGX(interest)} access fee</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function AgentWalletStatementsInner({ agentId }: { agentId: string }) {
  const { data: entries = [], isLoading } = useQuery({
    queryKey: ['drilldown-agent-statements', agentId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('general_ledger')
        .select('id, transaction_date, amount, direction, category, description')
        .eq('user_id', agentId)
        .in('ledger_scope', ['wallet', 'bridge'])
        .or('classification.neq.admin_correction,category.neq.system_balance_correction')
        .order('transaction_date', { ascending: false })
        .limit(25);
      if (error) throw error;
      return data ?? [];
    },
    enabled: !!agentId,
  });

  return (
    <Card className="p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium">
          <ReceiptText className="h-4 w-4 text-primary" /> Wallet statements
        </div>
        <Badge variant="outline" className="text-[10px]">last {entries.length}</Badge>
      </div>
      {isLoading ? (
        <Loader2 className="h-4 w-4 animate-spin mx-auto my-2" />
      ) : entries.length === 0 ? (
        <p className="text-xs text-muted-foreground">No wallet activity yet.</p>
      ) : (
        <ul className="space-y-1 text-xs max-h-72 overflow-y-auto pr-1">
          {entries.map((e: any) => {
            const isIn = e.direction === 'cash_in';
            return (
              <li key={e.id} className="flex items-start justify-between gap-2 border-b border-border/40 py-1.5">
                <div className="min-w-0 flex-1">
                  <p className="text-[11px] font-medium truncate capitalize">
                    {String(e.category ?? '').replace(/_/g, ' ')}
                  </p>
                  {e.description && (
                    <p className="text-[10px] text-muted-foreground truncate">{e.description}</p>
                  )}
                  <p className="text-[10px] text-muted-foreground">
                    {e.transaction_date ? format(parseISO(e.transaction_date), 'dd MMM yyyy, HH:mm') : '—'}
                  </p>
                </div>
                <span
                  className={`font-semibold whitespace-nowrap text-[11px] ${
                    isIn ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-700 dark:text-rose-400'
                  }`}
                >
                  {isIn ? '+' : '−'} {fmtUGX(e.amount)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Wallet buckets card — full 3-bucket view for any user (profile +   */
/* withdrawable/float/advance). Strict withdrawable from RPC.         */
/* ------------------------------------------------------------------ */
function WalletBucketsCard({ userId }: { userId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['drilldown-wallet-buckets', userId],
    queryFn: async () => {
      const [walletRes, strictRes] = await Promise.all([
        supabase
          .from('wallets')
          .select('withdrawable_balance, float_balance, advance_balance, locked_balance, currency')
          .eq('user_id', userId)
          .maybeSingle(),
        supabase.rpc('get_user_available_balance', { p_user_id: userId } as any),
      ]);
      return {
        wallet: walletRes.data as any,
        strict: Number(strictRes.data ?? 0),
      };
    },
    enabled: !!userId,
  });

  const w = data?.wallet;

  return (
    <Card className="p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Wallet className="h-4 w-4 text-primary" /> Wallet
        </div>
        {w?.currency && (
          <Badge variant="outline" className="text-[10px]">{w.currency}</Badge>
        )}
      </div>
      {isLoading ? (
        <Loader2 className="h-4 w-4 animate-spin mx-auto my-2" />
      ) : !w ? (
        <p className="text-xs text-muted-foreground">No wallet on file.</p>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-2 text-[11px]">
            <div className="rounded-md bg-emerald-50 dark:bg-emerald-950/30 p-2">
              <p className="text-muted-foreground text-[10px] uppercase">Withdrawable</p>
              <p className="font-semibold text-emerald-700 dark:text-emerald-300">
                {fmtUGX(data?.strict ?? 0)}
              </p>
              {Number(w.withdrawable_balance ?? 0) !== (data?.strict ?? 0) && (
                <p className="text-[9px] text-muted-foreground">cache {fmtUGX(w.withdrawable_balance ?? 0)}</p>
              )}
            </div>
            <div className="rounded-md bg-sky-50 dark:bg-sky-950/30 p-2">
              <p className="text-muted-foreground text-[10px] uppercase">Float</p>
              <p className="font-semibold text-sky-700 dark:text-sky-300">
                {fmtUGX(w.float_balance ?? 0)}
              </p>
            </div>
            <div className="rounded-md bg-amber-50 dark:bg-amber-950/30 p-2">
              <p className="text-muted-foreground text-[10px] uppercase">Advance</p>
              <p className="font-semibold text-amber-700 dark:text-amber-300">
                {fmtUGX(w.advance_balance ?? 0)}
              </p>
            </div>
          </div>
          {Number(w.locked_balance ?? 0) > 0 && (
            <p className="text-[10px] text-muted-foreground">
              Locked / pending holds: {fmtUGX(w.locked_balance)}
            </p>
          )}
        </>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* User-to-user transfers — wallet_transactions where this user is    */
/* the sender or recipient. Counterpart names are clickable so any    */
/* operator can open the other party's profile + wallet.              */
/* ------------------------------------------------------------------ */
function UserTransfersList({
  userId, onSelectUser,
}: { userId: string; onSelectUser?: (id: string, name: string) => void }) {
  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['drilldown-transfers', userId],
    queryFn: async () => {
      // User-to-user transfers live in the LEDGER (source of truth), not in
      // wallet_transactions. Each transfer is two `wallet_transfer` legs that
      // share a `reference_id` — one cash_out (sender) and one cash_in
      // (recipient). We read this user's legs, then resolve the counterpart
      // leg (same reference_id, different user) to know who they transacted with.
      const { data: legs, error } = await supabase
        .from('general_ledger')
        .select('id, amount, direction, description, transaction_date, reference_id')
        .eq('user_id', userId)
        .eq('category', 'wallet_transfer')
        .order('transaction_date', { ascending: false })
        .limit(25);
      if (error) throw error;
      const list = legs ?? [];
      const refs = Array.from(
        new Set(list.map((r: any) => r.reference_id).filter(Boolean)),
      );

      // reference_id -> counterpart user_id
      const counterpartByRef: Record<string, string> = {};
      if (refs.length) {
        const { data: others } = await supabase
          .from('general_ledger')
          .select('reference_id, user_id')
          .eq('category', 'wallet_transfer')
          .in('reference_id', refs)
          .neq('user_id', userId);
        (others ?? []).forEach((o: any) => {
          if (o.reference_id && !counterpartByRef[o.reference_id]) {
            counterpartByRef[o.reference_id] = o.user_id;
          }
        });
      }

      const counterpartIds = Array.from(new Set(Object.values(counterpartByRef)));
      const nameMap: Record<string, string> = {};
      if (counterpartIds.length) {
        const { data: profs } = await supabase
          .from('profiles')
          .select('id, full_name')
          .in('id', counterpartIds);
        (profs ?? []).forEach((p: any) => { nameMap[p.id] = p.full_name; });
      }

      return list.map((r: any) => {
        const counterpartId = r.reference_id ? counterpartByRef[r.reference_id] ?? null : null;
        return {
          id: r.id,
          amount: r.amount,
          direction: r.direction,
          description: r.description,
          created_at: r.transaction_date,
          counterpartId,
          counterpartName: counterpartId ? nameMap[counterpartId] ?? null : null,
        };
      });
    },
    enabled: !!userId,
  });

  return (
    <Card className="p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium">
          <ArrowLeftRight className="h-4 w-4 text-primary" /> Transfers
        </div>
        <Badge variant="outline" className="text-[10px]">last {rows.length}</Badge>
      </div>
      <p className="text-[10px] text-muted-foreground">
        Money moved between this user and others. Tap a name to open that person's profile & wallet.
      </p>
      {isLoading ? (
        <Loader2 className="h-4 w-4 animate-spin mx-auto my-2" />
      ) : rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">No transfers on file.</p>
      ) : (
        <ul className="space-y-1 text-xs max-h-72 overflow-y-auto pr-1">
          {rows.map((r: any) => {
            const isOut = r.direction === 'cash_out';
            const counterpartId = r.counterpartId;
            const counterpartName = r.counterpartName || 'Unknown user';
            return (
              <li key={r.id} className="flex items-start justify-between gap-2 border-b border-border/40 py-1.5">
                <div className="min-w-0 flex-1">
                  <p className="text-[11px] font-medium">
                    <span className="text-muted-foreground">{isOut ? 'Sent to' : 'Received from'} </span>
                    {counterpartId ? (
                      <button
                        type="button"
                        onClick={() => onSelectUser?.(counterpartId, counterpartName)}
                        className="text-primary hover:underline disabled:no-underline disabled:text-foreground font-semibold"
                        disabled={!onSelectUser}
                      >
                        {counterpartName}
                      </button>
                    ) : (
                      <span className="font-semibold">{counterpartName}</span>
                    )}
                  </p>
                  {r.description && (
                    <p className="text-[10px] text-muted-foreground truncate">{r.description}</p>
                  )}
                  <p className="text-[10px] text-muted-foreground">
                    {r.created_at ? format(parseISO(r.created_at), 'dd MMM yyyy, HH:mm') : '—'}
                  </p>
                </div>
                <span
                  className={`font-semibold whitespace-nowrap text-[11px] ${
                    isOut ? 'text-rose-700 dark:text-rose-400' : 'text-emerald-700 dark:text-emerald-400'
                  }`}
                >
                  {isOut ? '−' : '+'} {fmtUGX(r.amount)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Tenant statements — rent obligations & repayments from ledger     */
/* ------------------------------------------------------------------ */
function TenantStatements({
  tenantId, dateRange, onDateRangeChange,
}: {
  tenantId: string;
  dateRange: StatementDateRange;
  onDateRangeChange: (v: StatementDateRange) => void;
}) {
  const { gte, lte } = buildDateRange(dateRange);
  const { data: entries = [], isLoading } = useQuery({
    queryKey: ['drilldown-tenant-statements', tenantId, dateRange.preset, gte, lte],
    queryFn: async () => {
      let q = supabase
        .from('general_ledger')
        .select('id, transaction_date, amount, direction, category, description')
        .eq('user_id', tenantId)
        .in('category', TENANT_STATEMENT_CATEGORIES)
        .neq('classification', 'admin_correction');
      if (gte) q = q.gte('transaction_date', gte);
      if (lte) q = q.lte('transaction_date', lte);
      const { data, error } = await q.order('transaction_date', { ascending: false }).limit(500);
      if (error) throw error;
      return data ?? [];
    },
    enabled: !!tenantId,
  });

  const rangeLabel =
    dateRange.preset === 'today'
      ? 'Today'
      : dateRange.preset === 'this_month'
        ? 'This month'
        : dateRange.preset === 'custom' && dateRange.from && dateRange.to
          ? `${format(dateRange.from, 'dd MMM')} – ${format(dateRange.to, 'dd MMM')}`
          : 'All time';

  return (
    <Card className="p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium">
          <ReceiptText className="h-4 w-4 text-primary" /> Transactions & statements
        </div>
        <Badge variant="outline" className="text-[10px]">{entries.length} · {rangeLabel}</Badge>
      </div>
      <StatementDateFilter value={dateRange} onChange={onDateRangeChange} />
      {isLoading ? (
        <Loader2 className="h-4 w-4 animate-spin mx-auto my-2" />
      ) : entries.length === 0 ? (
        <p className="text-xs text-muted-foreground">No rent transactions on file yet.</p>
      ) : (
        <ul className="space-y-1 text-xs max-h-72 overflow-y-auto pr-1">
          {entries.map((e: any) => {
            const isIn = e.direction === 'cash_in';
            const isObligation = e.category === 'rent_obligation';
            return (
              <li key={e.id} className="flex items-start justify-between gap-2 border-b border-border/40 py-1.5">
                <div className="min-w-0 flex-1">
                  <p className="text-[11px] font-medium truncate capitalize">
                    {String(e.category ?? '').replace(/_/g, ' ')}
                  </p>
                  {e.description && (
                    <p className="text-[10px] text-muted-foreground truncate">{e.description}</p>
                  )}
                  <p className="text-[10px] text-muted-foreground">
                    {e.transaction_date ? format(parseISO(e.transaction_date), 'dd MMM yyyy, HH:mm') : '—'}
                  </p>
                </div>
                <span
                  className={`font-semibold whitespace-nowrap text-[11px] ${
                    isObligation
                      ? 'text-amber-700 dark:text-amber-400'
                      : isIn
                        ? 'text-emerald-700 dark:text-emerald-400'
                        : 'text-rose-700 dark:text-rose-400'
                  }`}
                >
                  {isObligation ? '' : isIn ? '+' : '−'} {fmtUGX(e.amount)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Agent tenants list — tenant · outstanding balance · landlord       */
/* ------------------------------------------------------------------ */
type TenantFilter = 'all' | 'active' | 'pending' | 'completed';

const STATUS_GROUPS: Record<TenantFilter, string[]> = {
  all: [],
  active: ['active'],
  pending: ['pending', 'agent_ops_approved', 'agent_verified', 'tenant_ops_approved', 'landlord_ops_approved', 'partner_ops_approved', 'coo_approved'],
  completed: ['completed', 'repaid', 'fully_repaid'],
};

function toWhatsAppUrl(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  const national = digits.startsWith('0') ? digits.slice(1) : digits;
  const intl = national.startsWith('256') ? national : '256' + national;
  const text = encodeURIComponent('Hello, this is your Welile agent.');
  return `https://wa.me/${intl}?text=${text}`;
}

function AgentTenantsList({ agentId, onSelectTenant }: { agentId: string; onSelectTenant?: (id: string, name: string) => void }) {
  const [filter, setFilter] = useState<TenantFilter>('all');
  const [search, setSearch] = useState('');
  const { data, isLoading } = useQuery({
    queryKey: ['drilldown-agent-tenants', agentId],
    queryFn: async () => {
      // Union three sources of "tenants under this agent":
      //   1. rent_requests.assigned_agent_id  (transactional assignment)
      //   2. rent_requests.agent_id           (originating/owning agent — most common)
      //   3. profiles.managing_agent_id       (long-term ownership)
      // `agent_id` is the field the field-ops captures during onboarding;
      // `assigned_agent_id` is set later by Tenant Ops. Many agents (e.g.
      // Mukisa Enock) have 60+ tenants on `agent_id` and 0 on
      // `assigned_agent_id`, so checking only the latter hides their portfolio.
      const cols = 'id, tenant_id, landlord_id, rent_amount, total_repayment, amount_repaid, status, created_at';
      const [rrsAssignedRes, rrsOwnedRes, managedRes] = await Promise.all([
        supabase
          .from('rent_requests')
          .select(cols)
          .eq('assigned_agent_id', agentId)
          .order('created_at', { ascending: false })
          .limit(500),
        supabase
          .from('rent_requests')
          .select(cols)
          .eq('agent_id', agentId)
          .order('created_at', { ascending: false })
          .limit(500),
        supabase
          .from('profiles')
          .select('id')
          .eq('managing_agent_id', agentId)
          .limit(1000),
      ]);
      // Merge & dedupe rent_request rows by id (a row could match both).
      const rrMap = new Map<string, any>();
      for (const r of [...(rrsAssignedRes.data ?? []), ...(rrsOwnedRes.data ?? [])]) {
        if (r?.id && !rrMap.has(r.id)) rrMap.set(r.id, r);
      }
      const list = Array.from(rrMap.values());
      // Keep latest rent request per tenant
      const latestByTenant = new Map<string, any>();
      for (const r of list) {
        if (!r.tenant_id) continue;
        if (!latestByTenant.has(r.tenant_id)) latestByTenant.set(r.tenant_id, r);
      }
      // Seed rows from rent requests
      const rows: any[] = Array.from(latestByTenant.values()).map((r) => ({
        ...r,
        source: 'rent_request' as const,
        rent_request_id: r.id,
      }));
      // Add managed-profile tenants that have no rent request on file
      for (const p of (managedRes.data ?? []) as any[]) {
        if (!latestByTenant.has(p.id)) {
          rows.push({
            id: `managed-${p.id}`,
            tenant_id: p.id,
            landlord_id: null,
            rent_amount: 0,
            total_repayment: 0,
            amount_repaid: 0,
            status: 'no_plan',
            created_at: null,
            source: 'profile' as const,
            rent_request_id: null,
          });
        }
      }
      const tenantIds = rows.map((r) => r.tenant_id).filter(Boolean);
      const landlordIds = Array.from(new Set(rows.map((r) => r.landlord_id).filter(Boolean)));
      const [tenants, landlords, ledgerRes] = await Promise.all([
        tenantIds.length
          ? supabase.from('profiles').select('id, full_name, phone, avatar_url').in('id', tenantIds)
          : Promise.resolve({ data: [] as any[] }),
        landlordIds.length
          ? supabase.from('landlords').select('id, name, phone').in('id', landlordIds as any)
          : Promise.resolve({ data: [] as any[] }),
        tenantIds.length
          ? supabase.from('general_ledger')
              .select('user_id, category, direction, amount')
              .in('user_id', tenantIds)
              .in('category', ['rent_obligation', 'tenant_repayment', 'tenant_repayment_collected', 'rent_repayment'])
          : Promise.resolve({ data: [] as any[] }),
      ]);
      const tMap = new Map((tenants.data ?? []).map((t: any) => [t.id, t]));
      const lMap = new Map((landlords.data ?? []).map((l: any) => [l.id, l]));
      // Lifetime outstanding from the ledger — same formula as Tenant Ops &
      // rent statements: SUM(rent_obligation cash_out) − SUM(repayments cash_in),
      // clamped to 0. Source of truth across the platform.
      const outstandingByTenant = new Map<string, number>();
      for (const tid of tenantIds) outstandingByTenant.set(tid, 0);
      for (const r of (ledgerRes.data ?? []) as any[]) {
        if (!r.user_id) continue;
        const amt = Number(r.amount || 0);
        const cur = outstandingByTenant.get(r.user_id) || 0;
        if (r.category === 'rent_obligation' && r.direction === 'cash_out') {
          outstandingByTenant.set(r.user_id, cur + amt);
        } else if (r.direction === 'cash_in') {
          outstandingByTenant.set(r.user_id, cur - amt);
        }
      }
      const mappedRows = rows
        .map((r) => {
          const outstanding = Math.max(0, outstandingByTenant.get(r.tenant_id) || 0);
          return {
            id: r.id,
            tenantId: r.tenant_id,
            tenant: tMap.get(r.tenant_id) as any,
            landlord: r.landlord_id ? (lMap.get(r.landlord_id) as any) : null,
            outstanding,
            status: r.status,
            source: r.source,
            rentRequestId: r.rent_request_id,
            landlordId: r.landlord_id,
            rentAmount: r.rent_amount,
            totalRepayment: r.total_repayment,
            amountRepaid: r.amount_repaid,
            createdAt: r.created_at,
          };
        })
        .sort((a, b) => b.outstanding - a.outstanding);
      return {
        rows: mappedRows,
        rentRequestCount: list.length,
        managedProfileCount: (managedRes.data ?? []).length,
      };
    },
  });

  const filtered = useMemo(() => {
    if (!data || !Array.isArray((data as any).rows)) return [];
    let out = data.rows;
    if (filter !== 'all') {
      const allowed = STATUS_GROUPS[filter];
      out = out.filter((row) => allowed.includes(row.status));
    }
    const q = search.trim().toLowerCase();
    if (q) {
      out = out.filter((row) => {
        const name = (row.tenant?.full_name ?? '').toLowerCase();
        const phone = (row.tenant?.phone ?? '').toLowerCase();
        return name.includes(q) || phone.includes(q);
      });
    }
    return out;
  }, [data, filter, search]);

  const filterButtons: { key: TenantFilter; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'active', label: 'Active' },
    { key: 'pending', label: 'Pending' },
    { key: 'completed', label: 'Completed' },
  ];

  const downloadCSV = () => {
    const rows = filtered.map((r) => ({
      Tenant: r.tenant?.full_name ?? 'Unnamed tenant',
      Phone: r.tenant?.phone ?? '',
      Landlord: r.landlord?.name ?? r.landlord?.phone ?? 'No landlord on file',
      'Outstanding (UGX)': String(r.outstanding),
      Status: r.status,
    }));
    if (!rows.length) { toast.info('No tenants to export'); return; }
    const headers = Object.keys(rows[0]);
    const csv = [headers.join(','), ...rows.map((r) => headers.map((h) => `"${(r as any)[h]?.toString().replace(/"/g, '""') ?? ''}"`).join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tenants-${agentId.slice(0, 8)}-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast.success('CSV downloaded');
  };

  const downloadPDF = () => {
    if (!filtered.length) { toast.info('No tenants to export'); return; }
    const w = window.open('', '_blank');
    if (!w) { toast.error('Popup blocked — allow popups to download PDF'); return; }
    const rows = filtered.map((r) => `
      <tr>
        <td style="padding:6px;border-bottom:1px solid #e5e7eb;font-size:12px;">${(r.tenant?.full_name ?? 'Unnamed tenant').replace(/</g, '&lt;')}</td>
        <td style="padding:6px;border-bottom:1px solid #e5e7eb;font-size:12px;">${(r.tenant?.phone ?? '').replace(/</g, '&lt;')}</td>
        <td style="padding:6px;border-bottom:1px solid #e5e7eb;font-size:12px;">${(r.landlord?.name ?? r.landlord?.phone ?? 'No landlord on file').replace(/</g, '&lt;')}</td>
        <td style="padding:6px;border-bottom:1px solid #e5e7eb;font-size:12px;text-align:right;">UGX ${Number(r.outstanding).toLocaleString()}</td>
        <td style="padding:6px;border-bottom:1px solid #e5e7eb;font-size:12px;text-align:center;text-transform:capitalize;">${r.status.replace(/</g, '&lt;')}</td>
      </tr>
    `).join('');
    w.document.write(`
      <html><head><title>Tenants Under Management</title></head>
      <body style="font-family:system-ui,sans-serif;padding:24px;">
        <h2 style="margin:0 0 8px;font-size:18px;">Tenants Under Management</h2>
        <p style="margin:0 0 16px;font-size:12px;color:#6b7280;">Exported on ${new Date().toLocaleString()} · ${filtered.length} tenants · Filter: ${filter}</p>
        <table style="width:100%;border-collapse:collapse;">
          <thead>
            <tr style="background:#f3f4f6;">
              <th style="padding:8px;text-align:left;font-size:12px;">Tenant</th>
              <th style="padding:8px;text-align:left;font-size:12px;">Phone</th>
              <th style="padding:8px;text-align:left;font-size:12px;">Landlord</th>
              <th style="padding:8px;text-align:right;font-size:12px;">Outstanding (UGX)</th>
              <th style="padding:8px;text-align:center;font-size:12px;">Status</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
        <script>setTimeout(()=>{window.print();},300);</script>
      </body></html>
    `);
    w.document.close();
  };

  const [sourceModalRow, setSourceModalRow] = useState<any>(null);

  return (
    <Card className="p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Users className="h-4 w-4 text-primary" /> Tenants under management
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={downloadCSV}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-muted text-muted-foreground border border-border hover:bg-muted/80 transition-colors"
            title="Download CSV"
          >
            <Download className="h-3 w-3" /> CSV
          </button>
          <button
            onClick={downloadPDF}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-muted text-muted-foreground border border-border hover:bg-muted/80 transition-colors"
            title="Download PDF"
          >
            <FileText className="h-3 w-3" /> PDF
          </button>
          <Badge variant="outline" className="text-[10px]">{filtered.length}</Badge>
        </div>
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
        <Input
          placeholder="Search tenant name or phone…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-7 h-7 text-xs"
        />
      </div>

      {/* Filter toggles */}
      <div className="flex items-center gap-1 flex-wrap">
        {filterButtons.map((b) => (
          <button
            key={b.key}
            onClick={() => setFilter(b.key)}
            className={`px-2 py-0.5 rounded-full text-[10px] font-medium transition-colors border ${
              filter === b.key
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-muted text-muted-foreground border-border hover:bg-muted/80'
            }`}
          >
            {b.label}
          </button>
        ))}
      </div>

      {/* Source breakdown */}
      {Array.isArray(data?.rows) && data!.rows.length > 0 && (
        <div className="flex items-center gap-2 rounded-md bg-muted/40 px-2.5 py-1.5 text-[11px]">
          <span className="text-muted-foreground shrink-0">Sources:</span>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1" title="Tenants with an assigned rent request">
              <span className="inline-block w-2 h-2 rounded-full bg-sky-500" />
              <span className="font-medium">{data!.rows.filter((r) => !String(r.id).startsWith('managed-')).length}</span>
              <span className="text-muted-foreground hidden sm:inline">rent request</span>
            </div>
            <div className="flex items-center gap-1" title="Tenants linked via profile ownership only">
              <span className="inline-block w-2 h-2 rounded-full bg-amber-500" />
              <span className="font-medium">{data!.rows.filter((r) => String(r.id).startsWith('managed-')).length}</span>
              <span className="text-muted-foreground hidden sm:inline">profile ownership</span>
            </div>
          </div>
          <span className="ml-auto text-muted-foreground">{data!.rows.length} total</span>
        </div>
      )}

      {/* Sparse list warning */}
      {Array.isArray(data?.rows) && data!.rows.length <= 2 && ((data!.rentRequestCount ?? 0) > 0 || (data!.managedProfileCount ?? 0) > 0) && (
        <Alert className="py-2 px-3 text-[11px] border-amber-200 bg-amber-50 text-amber-900">
          <div className="flex items-start gap-2">
            <AlertTriangle className="h-3.5 w-3.5 text-amber-600 shrink-0 mt-0.5" />
            <AlertDescription className="leading-relaxed">
              <span className="font-semibold block mb-0.5">Sparse tenant list</span>
              This agent has <strong>{data!.rentRequestCount ?? 0}</strong> rent request
              {(data!.rentRequestCount ?? 0) !== 1 ? 's' : ''} and <strong>{data!.managedProfileCount ?? 0}</strong> managed profile
              {(data!.managedProfileCount ?? 0) !== 1 ? 's' : ''}. Tenants are merged from both <code className="font-mono text-[10px] bg-amber-100/60 px-1 rounded">rent_requests</code> and <code className="font-mono text-[10px] bg-amber-100/60 px-1 rounded">profiles.managing_agent_id</code>, but some may not appear if profile/landlord lookups fail or if the same tenant exists in both sources.
            </AlertDescription>
          </div>
        </Alert>
      )}

      {isLoading ? (
        <Loader2 className="h-4 w-4 animate-spin mx-auto" />
      ) : filtered.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {filter === 'all'
            ? 'No tenants assigned to this agent yet.'
            : `No ${filter} tenants under this agent.`}
        </p>
      ) : (
        <ul className="space-y-1.5 max-h-80 overflow-y-auto pr-1">
          {filtered.map((row) => (
            <li
              key={row.id}
              onClick={() => onSelectTenant?.(row.tenantId, row.tenant?.full_name ?? 'Unnamed tenant')}
              className={`flex items-center justify-between gap-2 rounded-md border border-border/40 p-2 text-xs ${onSelectTenant ? 'cursor-pointer hover:bg-muted/40 transition-colors' : ''}`}
              title={onSelectTenant ? 'Tap to view full profile' : undefined}
            >
              <div className="min-w-0 flex items-center gap-2">
                <Avatar className="h-7 w-7 shrink-0">
                  <AvatarImage
                    src={row.tenant?.avatar_url ?? undefined}
                    alt={row.tenant?.full_name ?? 'Tenant'}
                  />
                  <AvatarFallback className="text-[10px]">
                    {(row.tenant?.full_name ?? 'T').slice(0, 2).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0">
                  <p className="font-medium truncate">
                    {row.tenant?.full_name ?? 'Unnamed tenant'}
                  </p>
                  <p className="text-[10px] text-muted-foreground truncate flex items-center gap-1">
                    <Home className="h-2.5 w-2.5" />
                    {row.landlord?.name?.trim() || row.landlord?.phone || 'No landlord on file'}
                  </p>
                  {row.tenant?.phone && (
                    <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                      <span className="text-[10px] text-muted-foreground font-mono">{row.tenant.phone}</span>
                      <ContactActions
                        phone={row.tenant.phone}
                        size="xs"
                        message={`Hello ${row.tenant?.full_name ?? ''}, this is Welile Ops regarding your rent.`}
                      />
                    </div>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <div className="text-right">
                  <p className="font-semibold text-amber-700">{fmtUGX(row.outstanding)}</p>
                  <p className="text-[9px] text-muted-foreground capitalize">{row.status}</p>
                </div>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setSourceModalRow(row as any);
                  }}
                  className="p-1 rounded-md hover:bg-muted transition-colors"
                  title="View source details"
                >
                  <Info className="h-3.5 w-3.5 text-muted-foreground" />
                </button>
                {onSelectTenant && (
                  <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* Source details modal */}
      <Dialog open={!!sourceModalRow} onOpenChange={() => setSourceModalRow(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-sm">Source details</DialogTitle>
            <DialogDescription className="text-xs">
              Underlying record that links this tenant to the agent.
            </DialogDescription>
          </DialogHeader>
          {sourceModalRow && (
            <div className="space-y-3 text-xs">
              <div className="flex items-center gap-2">
                <Badge
                  variant={sourceModalRow.source === 'rent_request' ? 'default' : 'secondary'}
                  className="text-[10px]"
                >
                  {sourceModalRow.source === 'rent_request' ? 'Rent request' : 'Profile ownership'}
                </Badge>
                <span className="text-muted-foreground">
                  {sourceModalRow.source === 'rent_request'
                    ? 'Assigned via rent request'
                    : 'Linked via managing_agent_id on profile'}
                </span>
              </div>

              <div className="space-y-2 rounded-md border border-border/60 p-3 bg-muted/30">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Tenant ID</span>
                  <span className="font-mono">{sourceModalRow.tenantId}</span>
                </div>
                {sourceModalRow.rentRequestId && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Rent request ID</span>
                    <span className="font-mono">{sourceModalRow.rentRequestId}</span>
                  </div>
                )}
                {sourceModalRow.landlordId && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Landlord ID</span>
                    <span className="font-mono">{sourceModalRow.landlordId}</span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Status</span>
                  <span className="capitalize">{sourceModalRow.status}</span>
                </div>
                {sourceModalRow.source === 'rent_request' && (
                  <>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Rent amount</span>
                      <span>{fmtUGX(sourceModalRow.rentAmount)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Total repayment</span>
                      <span>{fmtUGX(sourceModalRow.totalRepayment)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Amount repaid</span>
                      <span>{fmtUGX(sourceModalRow.amountRepaid)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Created</span>
                      <span>{sourceModalRow.createdAt ? format(parseISO(sourceModalRow.createdAt), 'dd MMM yyyy') : '—'}</span>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}
          <DialogFooter>
            <Button size="sm" variant="outline" onClick={() => setSourceModalRow(null)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}