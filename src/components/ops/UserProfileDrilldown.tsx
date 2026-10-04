import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { ContactActions } from './ContactActions';
import { formatUGX } from '@/lib/rentCalculations';
import { format } from 'date-fns';
import {
  MapPin, Phone, Mail, Smartphone, ShieldCheck, Briefcase, TrendingUp,
  Loader2, User, Navigation, Building2, ChevronLeft, ChevronRight, Wallet,
} from 'lucide-react';

/**
 * Read-only user profile drill-down opened on name tap.
 *
 * Four tabs:
 *   • Location   — full address chain + GPS coordinates
 *   • Contacts   — phone / WhatsApp / email / mobile money
 *   • Roles      — every enabled role (dashboards the user can reach)
 *   • Portfolios — the user's investor portfolios
 *
 * Ops / Fin Ops surface — observe only.
 */

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  userId: string | null;
  breadcrumbs?: { label: string; onClick?: () => void }[];
}

function Row({ label, value }: { label: ReactNode; value: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-2 border-b border-border/40 last:border-0">
      <span className="text-xs text-muted-foreground shrink-0">{label}</span>
      <span className="text-sm font-medium text-foreground text-right break-words min-w-0">{value || '—'}</span>
    </div>
  );
}

export function UserProfileDrilldown({ open, onOpenChange, userId, breadcrumbs }: Props) {
  const { data: profile, isLoading: profileLoading } = useQuery({
    queryKey: ['profile-drilldown', userId],
    enabled: !!userId && open,
    staleTime: 30_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, full_name, phone, email, avatar_url, verified, occupation, has_smartphone, mobile_money_number, mobile_money_provider, whatsapp_verified, continent, country, region, district, sub_county, parish, village, town, city, landmark, residence_lat, residence_lng, address_complete, ops_note')
        .eq('id', userId!)
        .maybeSingle();
      if (error) throw error;
      return data as any;
    },
  });

  const { data: roles } = useQuery({
    queryKey: ['profile-drilldown-roles', userId],
    enabled: !!userId && open,
    staleTime: 30_000,
    queryFn: async () => {
      const { data } = await supabase
        .from('user_roles')
        .select('role, enabled')
        .eq('user_id', userId!)
        .eq('enabled', true);
      return (data ?? []).map((r: any) => r.role as string);
    },
  });

  const { data: portfolios, isLoading: portfoliosLoading } = useQuery({
    queryKey: ['profile-drilldown-portfolios', userId],
    enabled: !!userId && open,
    staleTime: 30_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('investor_portfolios')
        .select('id, portfolio_code, investment_amount, roi_percentage, duration_months, status, created_at, maturity_date, total_roi_earned')
        .eq('investor_id', userId!)
        .order('created_at', { ascending: false })
        .limit(100);
      if (error) throw error;
      return data ?? [];
    },
  });

  const addressChain = [
    profile?.village, profile?.parish, profile?.sub_county, profile?.town,
    profile?.city, profile?.district, profile?.region, profile?.country,
  ].filter(Boolean).join(', ');

  const hasGps = profile?.residence_lat != null && profile?.residence_lng != null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-screen h-screen max-w-none sm:max-w-none overflow-y-auto p-0">
        <SheetHeader className="px-4 sm:px-6 pt-5 pb-3 border-b space-y-2">
          {/* Breadcrumbs + back */}
          {breadcrumbs && breadcrumbs.length > 0 && (
            <nav className="flex items-center gap-1 text-[11px] text-muted-foreground">
              {breadcrumbs.map((crumb, idx) => (
                <span key={idx} className="flex items-center gap-1">
                  {idx > 0 && <ChevronRight className="h-3 w-3 text-muted-foreground/60" />}
                  {crumb.onClick ? (
                    <button
                      type="button"
                      onClick={crumb.onClick}
                      className="hover:text-primary transition-colors underline underline-offset-2"
                    >
                      {crumb.label}
                    </button>
                  ) : (
                    <span className={idx === breadcrumbs.length - 1 ? 'text-foreground font-medium' : ''}>
                      {crumb.label}
                    </span>
                  )}
                </span>
              ))}
            </nav>
          )}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="h-8 w-8 rounded-lg border border-border bg-background flex items-center justify-center hover:bg-accent transition-colors shrink-0"
              aria-label="Back"
            >
              <ChevronLeft className="h-4 w-4 text-foreground" />
            </button>
            <SheetTitle className="text-lg flex items-center gap-2">
              <User className="h-5 w-5 text-primary" /> User profile
            </SheetTitle>
          </div>
          <SheetDescription className="text-xs">
            Location, contacts, roles and portfolios. View only.
          </SheetDescription>
        </SheetHeader>

        {profileLoading ? (
          <div className="py-16 text-center text-sm text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin inline mr-2" /> Loading profile…
          </div>
        ) : !profile ? (
          <div className="py-16 text-center text-sm text-muted-foreground">Profile not found.</div>
        ) : (
          <div className="px-4 sm:px-6 py-4 space-y-4">
            {/* Header card */}
            <div className="flex items-start gap-3">
              <Avatar className="h-14 w-14 ring-2 ring-primary/20 shrink-0">
                <AvatarImage src={profile.avatar_url ?? undefined} alt={profile.full_name ?? 'User'} />
                <AvatarFallback className="text-sm font-semibold">
                  {(profile.full_name ?? 'U').slice(0, 2).toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-base font-semibold truncate">{profile.full_name ?? 'Unnamed user'}</span>
                  {profile.verified && (
                    <Badge variant="outline" className="text-[10px] gap-1 text-emerald-600 border-emerald-300">
                      <ShieldCheck className="h-3 w-3" /> Verified
                    </Badge>
                  )}
                </div>
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-xs text-muted-foreground font-mono">{profile.phone ?? '— no phone —'}</span>
                  <ContactActions phone={profile.phone} size="xs" />
                </div>
              </div>
            </div>

            <Tabs defaultValue="location" className="w-full">
              <TabsList className="grid grid-cols-2 sm:grid-cols-4 w-full h-auto">
                <TabsTrigger value="location" className="text-xs py-2 gap-1"><MapPin className="h-3.5 w-3.5" /> Location</TabsTrigger>
                <TabsTrigger value="contacts" className="text-xs py-2 gap-1"><Phone className="h-3.5 w-3.5" /> Contacts</TabsTrigger>
                <TabsTrigger value="roles" className="text-xs py-2 gap-1"><Briefcase className="h-3.5 w-3.5" /> Roles</TabsTrigger>
                <TabsTrigger value="portfolios" className="text-xs py-2 gap-1"><TrendingUp className="h-3.5 w-3.5" /> Portfolios</TabsTrigger>
              </TabsList>

              {/* LOCATION */}
              <TabsContent value="location" className="pt-4">
                <div className="rounded-xl border border-border bg-card p-4">
                  {addressChain && (
                    <p className="text-sm font-medium text-foreground flex items-start gap-2 mb-3">
                      <MapPin className="h-4 w-4 text-primary shrink-0 mt-0.5" /> {addressChain}
                    </p>
                  )}
                  <Row label="Country" value={profile.country} />
                  <Row label="Region" value={profile.region} />
                  <Row label="District" value={profile.district} />
                  <Row label="Sub-county" value={profile.sub_county} />
                  <Row label="Parish" value={profile.parish} />
                  <Row label="Village" value={profile.village} />
                  <Row label="Town / City" value={profile.town || profile.city} />
                  <Row label="Landmark" value={profile.landmark} />
                  <Row label="Address complete" value={profile.address_complete ? 'Yes' : 'No'} />
                  <Row
                    label="GPS"
                    value={hasGps ? (
                      <a
                        href={`https://maps.google.com/?q=${profile.residence_lat},${profile.residence_lng}`}
                        target="_blank" rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-primary hover:underline"
                      >
                        <Navigation className="h-3.5 w-3.5" />
                        {Number(profile.residence_lat).toFixed(5)}, {Number(profile.residence_lng).toFixed(5)}
                      </a>
                    ) : 'Not captured'}
                  />
                </div>
              </TabsContent>

              {/* CONTACTS */}
              <TabsContent value="contacts" className="pt-4">
                <div className="rounded-xl border border-border bg-card p-4 space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-xs text-muted-foreground flex items-center gap-1.5"><Phone className="h-3.5 w-3.5" /> Phone</span>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium font-mono">{profile.phone || '—'}</span>
                      <ContactActions phone={profile.phone} size="xs" />
                    </div>
                  </div>
                  <Row label={<span className="flex items-center gap-1.5"><Mail className="h-3.5 w-3.5" /> Email</span>} value={profile.email} />
                  <Row label="WhatsApp verified" value={profile.whatsapp_verified ? 'Yes' : 'No'} />
                  <Row label={<span className="flex items-center gap-1.5"><Smartphone className="h-3.5 w-3.5" /> Has smartphone</span>} value={profile.has_smartphone ? 'Yes' : 'No'} />
                  <Row label="Mobile money" value={profile.mobile_money_number ? `${profile.mobile_money_number}${profile.mobile_money_provider ? ` (${profile.mobile_money_provider})` : ''}` : '—'} />
                  <Row label="Occupation" value={profile.occupation} />
                  {profile.ops_note && (
                    <p className="text-[11px] text-amber-700 bg-amber-50 dark:bg-amber-950 dark:text-amber-300 border border-amber-200 dark:border-amber-900 rounded px-2 py-1">
                      Ops note: {profile.ops_note}
                    </p>
                  )}
                </div>
              </TabsContent>

              {/* ROLES */}
              <TabsContent value="roles" className="pt-4">
                <div className="rounded-xl border border-border bg-card p-4">
                  {(roles ?? []).length === 0 ? (
                    <p className="text-sm text-muted-foreground">No active roles.</p>
                  ) : (
                    <>
                      <div className="flex flex-wrap gap-1.5">
                        {(roles ?? []).map((r) => (
                          <Badge key={r} variant="outline" className="text-xs capitalize">{r.replace(/_/g, ' ')}</Badge>
                        ))}
                      </div>
                      <p className="text-[11px] text-muted-foreground mt-3">
                        Dashboards accessible: {(roles ?? []).map((r) => r.replace(/_/g, ' ')).join(', ')}
                      </p>
                    </>
                  )}
                </div>
              </TabsContent>

              {/* PORTFOLIOS */}
              <TabsContent value="portfolios" className="pt-4">
                {portfoliosLoading ? (
                  <div className="py-8 text-center text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin inline mr-2" /> Loading portfolios…
                  </div>
                ) : (portfolios ?? []).length === 0 ? (
                  <div className="rounded-xl border border-dashed border-border/60 bg-background p-8 text-center text-sm text-muted-foreground">
                    No portfolios for this user.
                  </div>
                ) : (
                  <div className="space-y-2">
                    {(portfolios ?? []).map((p: any) => (
                      <div key={p.id} className="rounded-xl border border-border bg-card p-3">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-semibold flex items-center gap-1.5">
                            <Building2 className="h-4 w-4 text-primary" /> {p.portfolio_code || p.id.slice(0, 8)}
                          </span>
                          <Badge variant="outline" className="text-[10px] capitalize">{(p.status || '').replace(/_/g, ' ')}</Badge>
                        </div>
                        <div className="grid grid-cols-2 gap-x-4 mt-2">
                          <Row label="Principal" value={formatUGX(Number(p.investment_amount ?? 0))} />
                          <Row label="Returns rate" value={p.roi_percentage != null ? `${p.roi_percentage}%` : '—'} />
                          <Row label="Duration" value={p.duration_months ? `${p.duration_months} mo` : '—'} />
                          <Row label="Returns earned" value={formatUGX(Number(p.total_roi_earned ?? 0))} />
                          <Row label="Started" value={p.created_at ? format(new Date(p.created_at), 'd MMM yyyy') : '—'} />
                          <Row label="Maturity" value={p.maturity_date ? format(new Date(p.maturity_date), 'd MMM yyyy') : '—'} />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </TabsContent>
            </Tabs>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}