import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft, BadgeCheck, Phone, Mail, IdCard, MapPin, Calendar, ShieldAlert,
  Settings as SettingsIcon, Smartphone, Loader2, UserRound,
} from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { UserAvatar } from '@/components/UserAvatar';
import { BusinessAdvanceStatusHero } from '@/components/tenant/BusinessAdvanceStatusHero';
import { format } from 'date-fns';


/**
 * "Your Profile" — the signed-in user's own identity record.
 *
 * Read-only by design: every field shown here already has a governed edit
 * surface (Settings, the profile completion gate, KYC). This screen answers
 * "what does Welile hold about me?" without duplicating those write paths.
 */
export default function YourProfile() {
  const navigate = useNavigate();
  const { user, role, roles } = useAuth();

  const { data: profile, isLoading } = useQuery({
    queryKey: ['your-profile', user?.id],
    enabled: !!user?.id,
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('profiles')
        .select('full_name, phone, email, avatar_url, verified, national_id, created_at, district, village, sub_county, parish, region, country, mobile_money_number, mobile_money_provider, is_frozen, frozen_reason, whatsapp_verified, last_active_at')
        .eq('id', user!.id)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const dt = (d?: string | null, withTime = false) => {
    if (!d) return '—';
    try { return format(new Date(d), withTime ? 'dd MMM yyyy, HH:mm' : 'dd MMM yyyy'); } catch { return '—'; }
  };
  const txt = (s?: string | null) => (s && s.trim().length ? s.trim() : '—');

  const location = useMemo(() => {
    if (!profile) return '—';
    const bits = [profile.village, profile.parish, profile.sub_county, profile.district, profile.region]
      .map(b => (b || '').trim())
      .filter(Boolean);
    return bits.length ? bits.join(', ') : '—';
  }, [profile]);

  const payout = useMemo(() => {
    if (!profile?.mobile_money_number) return null;
    return `${profile.mobile_money_number}${profile.mobile_money_provider ? ` (${profile.mobile_money_provider})` : ''}`;
  }, [profile]);

  const rows: { icon: typeof Phone; label: string; value: string }[] = [
    { icon: UserRound, label: 'Full name', value: txt(profile?.full_name) },
    { icon: Phone, label: 'Phone number', value: txt(profile?.phone) },
    { icon: Mail, label: 'Email address', value: txt(profile?.email) },
    { icon: IdCard, label: 'National ID', value: txt(profile?.national_id) },
    { icon: MapPin, label: 'Location', value: location },
    { icon: Smartphone, label: 'Mobile money', value: payout || 'Not on file' },
    { icon: Calendar, label: 'Member since', value: dt(profile?.created_at) },
    { icon: Calendar, label: 'Last active', value: dt(profile?.last_active_at, true) },
  ];

  return (
    <div className="min-h-screen bg-background pb-28">
      <header className="sticky top-0 z-20 bg-primary text-primary-foreground px-4 py-3 flex items-center gap-3 shadow-md">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => navigate(-1)}
          aria-label="Go back"
          className="h-10 w-10 text-primary-foreground/90 hover:text-primary-foreground hover:bg-white/10 rounded-xl"
        >
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <h1 className="text-base font-semibold">Your Profile</h1>
      </header>

      <main className="px-4 py-4 space-y-4 max-w-2xl mx-auto">
        {isLoading ? (
          <div className="flex items-center justify-center py-20 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading your profile…
          </div>
        ) : (
          <>
            <Card className="rounded-2xl overflow-hidden">
              <CardContent className="p-5 flex items-center gap-4">
                <UserAvatar
                  fullName={profile?.full_name || 'You'}
                  avatarUrl={profile?.avatar_url || undefined}
                  size="lg"
                />
                <div className="min-w-0 flex-1">
                  <p className="text-lg font-semibold truncate">{txt(profile?.full_name)}</p>
                  <p className="text-sm text-muted-foreground truncate">{txt(profile?.phone)}</p>
                  <div className="flex flex-wrap items-center gap-1.5 mt-2">
                    {profile?.verified ? (
                      <Badge className="gap-1"><BadgeCheck className="h-3 w-3" /> Verified</Badge>
                    ) : (
                      <Badge variant="secondary">Unverified</Badge>
                    )}
                    {profile?.whatsapp_verified && <Badge variant="outline">WhatsApp verified</Badge>}
                    {role && <Badge variant="outline" className="capitalize">{role.replace(/_/g, ' ')}</Badge>}
                  </div>
                </div>
              </CardContent>
            </Card>

            {profile?.is_frozen && (
              <Card className="rounded-2xl border-destructive/40 bg-destructive/5">
                <CardContent className="p-4 flex gap-3">
                  <ShieldAlert className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
                  <div>
                    <p className="text-sm font-semibold text-destructive">This account is restricted</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      {txt(profile.frozen_reason)} Contact support to resolve this.
                    </p>
                  </div>
                </CardContent>
              </Card>
            )}

            <Card className="rounded-2xl">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Identity details</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <ul className="divide-y">
                  {rows.map(r => (
                    <li key={r.label} className="flex items-start gap-3 px-4 py-3">
                      <div className="p-1.5 rounded-lg bg-primary/10 shrink-0">
                        <r.icon className="h-4 w-4 text-primary" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{r.label}</p>
                        <p className="text-sm font-medium break-words">{r.value}</p>
                      </div>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>

            {roles && roles.length > 1 && (
              <Card className="rounded-2xl">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Your access</CardTitle>
                </CardHeader>
                <CardContent className="flex flex-wrap gap-1.5">
                  {roles.map(r => (
                    <Badge key={r} variant={r === role ? 'default' : 'outline'} className="capitalize">
                      {r.replace(/_/g, ' ')}
                    </Badge>
                  ))}
                </CardContent>
              </Card>
            )}

            <Button variant="outline" className="w-full h-12 rounded-xl gap-2" onClick={() => navigate('/settings')}>
              <SettingsIcon className="h-4 w-4" /> Edit details in Settings
            </Button>
          </>
        )}
      </main>
    </div>
  );
}
