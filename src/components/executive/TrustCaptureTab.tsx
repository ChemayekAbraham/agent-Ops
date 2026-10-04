import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  ShieldCheck, Target, MapPin, Banknote, IdCard, Home, Briefcase, CheckCircle2,
  Loader2, Search, AlertTriangle, Users, Share2, Trophy, Sparkles,
} from 'lucide-react';
import { toast } from 'sonner';
import { AgentDailyMissions } from './AgentDailyMissions';

const SIGNAL_TYPES = [
  { key: 'rent_payment', label: 'Rent Payment', icon: Banknote, weight: 'High', color: 'bg-emerald-500' },
  { key: 'venue_visit', label: 'Venue Visit', icon: MapPin, weight: 'Medium', color: 'bg-blue-500' },
  { key: 'id_verified', label: 'National ID Photo', icon: IdCard, weight: 'High', color: 'bg-violet-500' },
  { key: 'landlord_intro', label: 'Landlord Intro', icon: Home, weight: 'Medium', color: 'bg-amber-500' },
  { key: 'salary_proof', label: 'Salary / Income', icon: Briefcase, weight: 'High', color: 'bg-rose-500' },
  { key: 'quick_vouch', label: 'Quick Vouch', icon: CheckCircle2, weight: 'Low', color: 'bg-slate-500' },
];

const VENUE_CATEGORIES = [
  { value: 'residence', label: 'Home / Residence' },
  { value: 'worship', label: 'Worship (Church/Mosque)' },
  { value: 'mall', label: 'Mall / Supermarket' },
  { value: 'market', label: 'Local Market' },
  { value: 'restaurant', label: 'Restaurant / Cafe' },
  { value: 'hotel', label: 'Hotel / Lodge' },
  { value: 'shop', label: 'Shop / Kiosk' },
  { value: 'workplace', label: 'Workplace' },
  { value: 'other', label: 'Other' },
];

const DAILY_QUOTA = 10;

interface CaptureUser {
  id: string;
  full_name: string | null;
  phone: string | null;
}

export function TrustCaptureTab() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [selectedUser, setSelectedUser] = useState<CaptureUser | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  // Today's capture count for this agent
  const { data: todayCount = 0 } = useQuery({
    queryKey: ['trust-capture-today', user?.id],
    enabled: !!user?.id,
    queryFn: async () => {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      const { count } = await supabase
        .from('agent_visits')
        .select('id', { count: 'exact', head: true })
        .eq('agent_id', user!.id)
        .gte('checked_in_at', start.toISOString());
      return count || 0;
    },
    staleTime: 60_000,
  });

  // Referrals: every user who signed up via this agent's shared link.
  // This is the headline KPI — referrals are now a top-tier trust factor (up to 18 pts).
  const { data: referralStats } = useQuery({
    queryKey: ['trust-capture-referrals', user?.id],
    enabled: !!user?.id,
    queryFn: async () => {
      const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
      const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString();

      const [{ count: total }, { count: last7 }, { count: last30 }] = await Promise.all([
        supabase.from('profiles').select('id', { count: 'exact', head: true }).eq('referrer_id', user!.id),
        supabase.from('profiles').select('id', { count: 'exact', head: true }).eq('referrer_id', user!.id).gte('created_at', sevenDaysAgo),
        supabase.from('profiles').select('id', { count: 'exact', head: true }).eq('referrer_id', user!.id).gte('created_at', thirtyDaysAgo),
      ]);

      const totalCount = total || 0;
      // Mirrors the DB formula: LEAST(18, referrals_count * 0.6)
      const referralsScore = Math.min(18, totalCount * 0.6);
      return {
        total: totalCount,
        last7: last7 || 0,
        last30: last30 || 0,
        score: referralsScore,
        topReferrer: totalCount >= 25,
        nextMilestone: totalCount >= 30 ? null : totalCount >= 25 ? 30 : totalCount >= 10 ? 25 : 10,
      };
    },
    staleTime: 5 * 60_000,
  });

  // Untouched users in agent's network (referrals or assigned tenants without recent visit)
  const { data: untouched = [], isLoading: loadingUntouched } = useQuery({
    queryKey: ['trust-untouched-users', user?.id],
    enabled: !!user?.id,
    queryFn: async () => {
      // Pull referred profiles (lean — first 50)
      const { data: refs } = await supabase
        .from('profiles')
        .select('id, full_name, phone, created_at')
        .eq('referrer_id', user!.id)
        .order('created_at', { ascending: false })
        .limit(50);
      const ids = (refs || []).map(r => r.id);
      if (ids.length === 0) return [];

      // Find which of these have NO agent_visit in last 30d
      const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
      const { data: recentVisits } = await supabase
        .from('agent_visits')
        .select('tenant_id')
        .in('tenant_id', ids)
        .gte('checked_in_at', cutoff);
      const visitedSet = new Set((recentVisits || []).map(v => v.tenant_id));
      return (refs || []).filter(r => !visitedSet.has(r.id)).slice(0, 20);
    },
    staleTime: 5 * 60_000,
  });

  // Search users (referrals + assigned tenants)
  const { data: searchResults = [] } = useQuery({
    queryKey: ['trust-capture-search', user?.id, search],
    enabled: !!user?.id && search.length >= 2,
    queryFn: async () => {
      const term = `%${search.trim()}%`;
      const { data } = await supabase
        .from('profiles')
        .select('id, full_name, phone')
        .or(`full_name.ilike.${term},phone.ilike.${term}`)
        .limit(15);
      return (data || []) as CaptureUser[];
    },
    staleTime: 30_000,
  });

  const captureMutation = useMutation({
    mutationFn: async (payload: {
      tenant_id: string;
      signal_type: string;
      venue_category: string;
      venue_name: string;
      latitude: number;
      longitude: number;
      accuracy?: number;
      notes?: string;
    }) => {
      const { data, error } = await supabase.rpc('capture_trust_signal', {
        p_tenant_id: payload.tenant_id,
        p_signal_type: payload.signal_type,
        p_venue_category: payload.venue_category,
        p_venue_name: payload.venue_name,
        p_latitude: payload.latitude,
        p_longitude: payload.longitude,
        p_accuracy: payload.accuracy ?? null,
        p_notes: payload.notes ?? null,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      toast.success('Trust signal captured (+UGX 200 commission queued)');
      qc.invalidateQueries({ queryKey: ['trust-capture-today'] });
      qc.invalidateQueries({ queryKey: ['trust-untouched-users'] });
      setSheetOpen(false);
      setSelectedUser(null);
    },
    onError: (e: any) => {
      toast.error(e?.message || 'Could not capture signal');
    },
  });

  const openCaptureFor = (u: CaptureUser) => {
    setSelectedUser(u);
    setSheetOpen(true);
  };

  const quotaPct = Math.min(100, Math.round((todayCount / DAILY_QUOTA) * 100));
  const quotaMet = todayCount >= DAILY_QUOTA;

  return (
    <div className="space-y-4">
      {/* Referrals Hero — top-tier trust factor (up to 18 pts of the score) */}
      <ReferralsHeroCard stats={referralStats} />

      {/* Daily Missions — gamified to-dos */}
      <AgentDailyMissions onCaptureClick={() => {
        const el = document.getElementById('trust-capture-search');
        el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        (el as HTMLInputElement | null)?.focus();
      }} />

      {/* Quota Card */}
      <div className="rounded-2xl border border-primary/30 bg-gradient-to-br from-primary/10 to-emerald-500/10 p-4">
        <div className="flex items-center gap-2 mb-2">
          <Target className="h-5 w-5 text-primary" />
          <h3 className="text-sm font-bold">Today's Capture Quota</h3>
          {quotaMet && (
            <span className="ml-auto px-2 py-0.5 rounded-full bg-emerald-500 text-white text-[10px] font-bold">
              ✓ MET
            </span>
          )}
        </div>
        <div className="flex items-baseline gap-2 mb-2">
          <span className="text-3xl font-bold">{todayCount}</span>
          <span className="text-sm text-muted-foreground">/ {DAILY_QUOTA} signals</span>
        </div>
        <div className="h-2 bg-muted rounded-full overflow-hidden">
          <div
            className={`h-full transition-all ${quotaMet ? 'bg-emerald-500' : 'bg-primary'}`}
            style={{ width: `${quotaPct}%` }}
          />
        </div>
        <p className="text-[11px] text-muted-foreground mt-2">
          Each verified signal earns <span className="font-bold text-foreground">+UGX 200</span> weekly commission.
          Miss quota for 7 days → commission tier downgrade.
        </p>
      </div>

      {/* Signal type primer */}
      <div className="rounded-2xl border border-border bg-card p-3">
        <h4 className="text-xs font-semibold mb-2 flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-primary" />
          What counts as a Trust Signal?
        </h4>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {SIGNAL_TYPES.map((s) => (
            <div key={s.key} className="flex items-center gap-2 rounded-lg border border-border/60 bg-background p-2">
              <div className={`p-1.5 rounded ${s.color}/20`}>
                <s.icon className={`h-3.5 w-3.5 ${s.color.replace('bg-', 'text-')}`} />
              </div>
              <div className="min-w-0">
                <p className="text-[11px] font-semibold truncate">{s.label}</p>
                <p className="text-[9px] text-muted-foreground">{s.weight} weight</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Untouched users heatmap */}
      <div className="rounded-2xl border border-border bg-card p-3">
        <div className="flex items-center gap-2 mb-2">
          <AlertTriangle className="h-4 w-4 text-amber-500" />
          <h4 className="text-xs font-semibold">Un-scored in your network (last 30 days)</h4>
          {untouched.length > 0 && (
            <span className="ml-auto text-[10px] text-amber-600 font-semibold">
              {untouched.length} need a visit
            </span>
          )}
        </div>
        {loadingUntouched ? (
          <div className="space-y-2">
            {[1, 2, 3].map(i => <div key={i} className="h-10 bg-muted/40 animate-pulse rounded" />)}
          </div>
        ) : untouched.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-4">
            🎉 All your tenants have been visited recently.
          </p>
        ) : (
          <div className="space-y-1.5 max-h-64 overflow-y-auto">
            {untouched.map((u: any) => (
              <button
                key={u.id}
                onClick={() => openCaptureFor(u)}
                className="w-full flex items-center gap-2 p-2 rounded-lg border border-border/60 hover:border-primary/50 hover:bg-muted/40 transition-colors text-left"
              >
                <div className="h-8 w-8 rounded-full bg-amber-500/10 flex items-center justify-center shrink-0">
                  <Users className="h-4 w-4 text-amber-600" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-semibold truncate">{u.full_name || 'Unnamed'}</p>
                  <p className="text-[10px] text-muted-foreground truncate">{u.phone || 'no phone'}</p>
                </div>
                <span className="text-[10px] text-primary font-semibold shrink-0">Capture →</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Manual search */}
      <div className="rounded-2xl border border-border bg-card p-3">
        <h4 className="text-xs font-semibold mb-2 flex items-center gap-2">
          <Search className="h-4 w-4 text-primary" />
          Find any user to capture
        </h4>
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name or phone…"
          className="h-9 text-sm"
        />
        {search.length >= 2 && searchResults.length > 0 && (
          <div className="mt-2 space-y-1 max-h-56 overflow-y-auto">
            {searchResults.map((u) => (
              <button
                key={u.id}
                onClick={() => openCaptureFor(u)}
                className="w-full flex items-center gap-2 p-2 rounded-lg border border-border/60 hover:border-primary/50 transition-colors text-left"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-semibold truncate">{u.full_name || 'Unnamed'}</p>
                  <p className="text-[10px] text-muted-foreground truncate">{u.phone || 'no phone'}</p>
                </div>
                <span className="text-[10px] text-primary font-semibold shrink-0">Capture →</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <CaptureSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        user={selectedUser}
        onSubmit={(payload) => captureMutation.mutate(payload)}
        submitting={captureMutation.isPending}
      />
    </div>
  );
}

interface ReferralStats {
  total: number;
  last7: number;
  last30: number;
  score: number;
  topReferrer: boolean;
  nextMilestone: number | null;
}

function ReferralsHeroCard({ stats }: { stats?: ReferralStats }) {
  const total = stats?.total ?? 0;
  const score = stats?.score ?? 0;
  const scorePct = Math.min(100, Math.round((score / 18) * 100));
  const next = stats?.nextMilestone;

  return (
    <div className="relative overflow-hidden rounded-2xl border-2 border-emerald-500/40 bg-gradient-to-br from-emerald-500/15 via-primary/10 to-amber-500/10 p-4 shadow-lg">
      <div className="absolute -right-6 -top-6 opacity-10">
        <Share2 className="h-32 w-32 text-emerald-600" />
      </div>
      <div className="relative space-y-3">
        <div className="flex items-center gap-2">
          <div className="p-1.5 rounded-lg bg-emerald-500 text-white">
            <Share2 className="h-4 w-4" />
          </div>
          <h3 className="text-sm font-bold uppercase tracking-wide">Your Referrals</h3>
          {stats?.topReferrer && (
            <span className="ml-auto inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-500 text-white text-[10px] font-bold">
              <Trophy className="h-3 w-3" /> TOP REFERRER
            </span>
          )}
        </div>

        <div className="flex items-end gap-2">
          <span className="text-5xl font-bold leading-none text-foreground">{total}</span>
          <span className="text-xs text-muted-foreground pb-1">people signed up via your link</span>
        </div>

        <div className="grid grid-cols-3 gap-2">
          <div className="rounded-lg bg-background/60 p-2 text-center border border-border/50">
            <p className="text-[10px] uppercase text-muted-foreground">Last 7d</p>
            <p className="text-lg font-bold">{stats?.last7 ?? 0}</p>
          </div>
          <div className="rounded-lg bg-background/60 p-2 text-center border border-border/50">
            <p className="text-[10px] uppercase text-muted-foreground">Last 30d</p>
            <p className="text-lg font-bold">{stats?.last30 ?? 0}</p>
          </div>
          <div className="rounded-lg bg-background/60 p-2 text-center border border-border/50">
            <p className="text-[10px] uppercase text-muted-foreground">Trust Pts</p>
            <p className="text-lg font-bold text-emerald-600">{score.toFixed(1)}<span className="text-xs text-muted-foreground">/18</span></p>
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between text-[11px] mb-1">
            <span className="text-muted-foreground">Referral score progress</span>
            <span className="font-semibold">{scorePct}%</span>
          </div>
          <div className="h-2.5 bg-muted rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-emerald-500 via-primary to-amber-500 transition-all"
              style={{ width: `${scorePct}%` }}
            />
          </div>
          {next && (
            <p className="text-[11px] text-muted-foreground mt-1.5">
              <Sparkles className="inline h-3 w-3 text-amber-500 mr-1" />
              <span className="font-semibold text-foreground">{next - total} more</span> referrals to reach the next milestone ({next})
              {next === 25 && ' — unlock the Top Referrer badge'}
              {next === 30 && ' — unlock max referral score (18/18)'}
            </p>
          )}
          {!next && (
            <p className="text-[11px] text-emerald-600 font-semibold mt-1.5">
              🏆 Maxed out — you've earned every referral trust point available.
            </p>
          )}
        </div>

        <p className="text-[11px] text-muted-foreground border-t border-border/40 pt-2">
          Every link sign-up directly raises your <span className="font-bold text-foreground">Welile Trust Score</span> — referrals are now a top-tier factor (up to 18 of 100 points). Share your agent link from the dashboard to keep climbing.
        </p>
      </div>
    </div>
  );
}

interface CaptureSheetProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  user: CaptureUser | null;
  onSubmit: (payload: any) => void;
  submitting: boolean;
}

function CaptureSheet({ open, onOpenChange, user, onSubmit, submitting }: CaptureSheetProps) {
  const [signalType, setSignalType] = useState('venue_visit');
  const [venueCategory, setVenueCategory] = useState('residence');
  const [venueName, setVenueName] = useState('');
  const [notes, setNotes] = useState('');
  const [gettingLocation, setGettingLocation] = useState(false);
  const [location, setLocation] = useState<{ lat: number; lng: number; acc?: number } | null>(null);

  const captureLocation = () => {
    if (!navigator.geolocation) {
      toast.error('GPS not available on this device');
      return;
    }
    setGettingLocation(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocation({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          acc: pos.coords.accuracy,
        });
        setGettingLocation(false);
        toast.success('Location captured');
      },
      (err) => {
        setGettingLocation(false);
        toast.error(`Location failed: ${err.message}`);
      },
      { enableHighAccuracy: true, timeout: 10000 },
    );
  };

  const handleSubmit = () => {
    if (!user) return;
    if (!location) {
      toast.error('Capture GPS location first');
      return;
    }
    if (!venueName.trim()) {
      toast.error('Enter a venue / location name');
      return;
    }
    onSubmit({
      tenant_id: user.id,
      signal_type: signalType,
      venue_category: venueCategory,
      venue_name: venueName.trim(),
      latitude: location.lat,
      longitude: location.lng,
      accuracy: location.acc,
      notes: notes.trim() || undefined,
    });
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="h-[85vh] overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-primary" />
            Capture Trust Signal
          </SheetTitle>
          <SheetDescription>
            {user?.full_name || 'Selected user'} · adds geo-stamped behavior data
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-4 mt-4">
          <div>
            <Label className="text-xs">Signal type</Label>
            <Select value={signalType} onValueChange={setSignalType}>
              <SelectTrigger className="h-9 mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SIGNAL_TYPES.map((s) => (
                  <SelectItem key={s.key} value={s.key}>
                    {s.label} ({s.weight})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label className="text-xs">Venue category</Label>
            <Select value={venueCategory} onValueChange={setVenueCategory}>
              <SelectTrigger className="h-9 mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {VENUE_CATEGORIES.map((v) => (
                  <SelectItem key={v.value} value={v.value}>{v.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label className="text-xs">Venue / Place name</Label>
            <Input
              value={venueName}
              onChange={(e) => setVenueName(e.target.value)}
              placeholder="e.g. Garden City Mall"
              className="h-9 mt-1"
            />
          </div>

          <div>
            <Label className="text-xs">GPS Location *</Label>
            <Button
              type="button"
              variant={location ? 'outline' : 'default'}
              size="sm"
              onClick={captureLocation}
              disabled={gettingLocation}
              className="w-full mt-1 gap-2"
            >
              {gettingLocation ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <MapPin className="h-4 w-4" />
              )}
              {location
                ? `✓ ${location.lat.toFixed(5)}, ${location.lng.toFixed(5)} (±${Math.round(location.acc || 0)}m)`
                : 'Capture my GPS location'}
            </Button>
          </div>

          <div>
            <Label className="text-xs">Notes (optional)</Label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Anything observed worth recording…"
              rows={2}
              className="mt-1 text-sm"
            />
          </div>

          <Button
            onClick={handleSubmit}
            disabled={submitting || !location}
            className="w-full h-11"
          >
            {submitting ? (
              <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Saving…</>
            ) : (
              <><CheckCircle2 className="h-4 w-4 mr-2" /> Capture Signal (+UGX 200)</>
            )}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
