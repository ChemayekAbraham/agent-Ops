import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft, BadgeCheck, Phone, Mail, IdCard, MapPin, Calendar, ShieldAlert,
  Smartphone, Loader2, Globe, Shield, Pencil,
} from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { FlipCard, FlipCardFront, FlipCardBack } from '@/components/ui/flip-card';
import { UserAvatar } from '@/components/UserAvatar';
import { BusinessAdvanceStatusHero } from '@/components/tenant/BusinessAdvanceStatusHero';
import { format } from 'date-fns';


/**
 * "Your Profile" — the signed-in user's own identity record.
 *
 * Read-only by design: every field shown here already has a governed edit
 * surface (Settings, the profile completion gate, KYC). This screen answers
 * "what does Welile hold about me?" without duplicating those write paths.
 *
 * Visual design inspired by Airbnb's profile screen.
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

  const firstName = useMemo(() => {
    if (!profile?.full_name) return 'You';
    return profile.full_name.split(' ').pop() || profile.full_name;
  }, [profile]);

  const memberYears = useMemo(() => {
    if (!profile?.created_at) return 0;
    const diff = Date.now() - new Date(profile.created_at).getTime();
    return Math.max(0, Math.floor(diff / (365.25 * 24 * 60 * 60 * 1000)));
  }, [profile]);

  const memberLabel = useMemo(() => {
    if (!profile?.created_at) return '—';
    const months = Math.floor((Date.now() - new Date(profile.created_at).getTime()) / (30.44 * 24 * 60 * 60 * 1000));
    if (months < 1) return 'New member';
    if (months < 12) return `${months} month${months > 1 ? 's' : ''}`;
    return `${memberYears} year${memberYears !== 1 ? 's' : ''}`;
  }, [profile, memberYears]);

  const payout = useMemo(() => {
    if (!profile?.mobile_money_number) return null;
    return `${profile.mobile_money_number}${profile.mobile_money_provider ? ` (${profile.mobile_money_provider})` : ''}`;
  }, [profile]);

  return (
    <div className="min-h-screen bg-background pb-28">
      {/* Clean header — Airbnb style: back arrow left, Edit right */}
      <header className="sticky top-0 z-20 bg-background px-4 py-3 flex items-center justify-between border-b border-border/40">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => navigate(-1)}
          aria-label="Go back"
          className="h-10 w-10 rounded-full hover:bg-muted"
        >
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <Button
          variant="ghost"
          onClick={() => navigate('/settings')}
          className="text-sm font-semibold underline underline-offset-2 hover:bg-transparent hover:text-foreground"
        >
          Edit
        </Button>
      </header>

      <main className="px-4 py-6 space-y-6 max-w-lg mx-auto">
        {isLoading ? (
          <div className="flex items-center justify-center py-20 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading your profile…
          </div>
        ) : (
          <>
            {/* ─── Hero flip card: front = avatar+stats, back = contact details ─── */}
            <FlipCard className="h-52 w-full">
              <FlipCardFront className="rounded-2xl border border-border/60 bg-card shadow-sm p-6">
                <div className="flex items-center gap-6 h-full">
                  {/* Avatar + name column */}
                  <div className="flex flex-col items-center text-center shrink-0">
                    <div className="relative">
                      <UserAvatar
                        fullName={profile?.full_name || 'You'}
                        avatarUrl={profile?.avatar_url || undefined}
                        size="lg"
                        className="h-20 w-20 text-2xl"
                      />
                      {profile?.verified && (
                        <div className="absolute -bottom-1 -right-1 bg-primary rounded-full p-1">
                          <BadgeCheck className="h-4 w-4 text-primary-foreground" />
                        </div>
                      )}
                    </div>
                    <p className="text-lg font-bold mt-3">{firstName}</p>
                    <p className="text-xs text-muted-foreground">{txt(profile?.district)}{profile?.region ? `, ${profile.region}` : ''}</p>
                  </div>

                  {/* Stats column — Airbnb style */}
                  <div className="flex-1 flex flex-col gap-3 pl-4 border-l border-border/40">
                    {role && (
                      <div>
                        <p className="text-xl font-extrabold leading-none capitalize">{role.replace(/_/g, ' ')}</p>
                        <p className="text-xs text-muted-foreground mt-0.5">Role</p>
                      </div>
                    )}
                    <div className="border-t border-border/30 pt-2">
                      <p className="text-xl font-extrabold leading-none">{profile?.verified ? '✓' : '—'}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">Verified</p>
                    </div>
                    <div className="border-t border-border/30 pt-2">
                      <p className="text-xl font-extrabold leading-none">{memberLabel}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">On Welile</p>
                    </div>
                  </div>
                </div>
                <p className="absolute bottom-2 right-3 text-[10px] text-muted-foreground/50">Hover to see details</p>
              </FlipCardFront>

              <FlipCardBack className="rounded-2xl overflow-hidden shadow-lg">
                <div className="relative h-full w-full p-6 flex flex-col justify-between"
                  style={{
                    background: 'linear-gradient(135deg, #7c3aed 0%, #c026d3 35%, #e11d48 70%, #f97316 100%)',
                  }}
                >
                  {/* Subtle decorative pattern */}
                  <div className="absolute inset-0 opacity-10" style={{
                    backgroundImage: `url("data:image/svg+xml,%3Csvg width='40' height='40' viewBox='0 0 40 40' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M20 5c-1.5 0-2.7.8-3.4 2l-1.5 2.6c-.3.5-.8.9-1.4 1l-3 .4c-1.4.2-2.5 1.2-2.8 2.5-.3 1.3.2 2.7 1.3 3.5l2.2 1.7c.4.3.7.8.8 1.3l.5 3c.2 1.4 1.3 2.5 2.7 2.7 1.3.2 2.7-.4 3.4-1.5L20 21l1.7 2.2c.7 1 2 1.7 3.4 1.5 1.3-.2 2.4-1.3 2.7-2.7l.5-3c.1-.5.4-1 .8-1.3l2.2-1.7c1-1 1.5-2.2 1.3-3.5-.3-1.3-1.4-2.3-2.8-2.5l-3-.4c-.5-.1-1-.5-1.4-1L23.4 7c-.7-1.2-2-2-3.4-2z' fill='%23ffffff' fill-opacity='0.3'/%3E%3C/svg%3E")`,
                    backgroundSize: '40px 40px',
                  }} />

                  {/* Top section: Name + verified status */}
                  <div className="relative z-10">
                    <p className="text-xl font-bold text-white">{firstName}</p>
                    <p className="text-white/80 text-sm mt-0.5">
                      {profile?.verified
                        ? `Verified since ${dt(profile?.created_at)}`
                        : 'Verification pending'}
                    </p>
                  </div>

                  {/* Bottom section: trust message + photo */}
                  <div className="relative z-10 flex items-end justify-between gap-4">
                    <p className="text-white/90 text-xs leading-relaxed max-w-[65%]">
                      Trust is the cornerstone of Welile's community, and identity verification is part of how we build it.
                    </p>
                    <UserAvatar
                      fullName={profile?.full_name || 'You'}
                      avatarUrl={profile?.avatar_url || undefined}
                      size="lg"
                      className="h-16 w-16 text-xl rounded-lg border-2 border-white/30 shrink-0"
                    />
                  </div>
                </div>
              </FlipCardBack>
            </FlipCard>

            {/* ─── Frozen account alert ─── */}
            {profile?.is_frozen && (
              <div className="flex gap-3 p-4 rounded-2xl border border-destructive/30 bg-destructive/5">
                <ShieldAlert className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-semibold text-destructive">This account is restricted</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {txt(profile.frozen_reason)} Contact support to resolve this.
                  </p>
                </div>
              </div>
            )}

            {/* ─── Business advance tracker ─── */}
            <BusinessAdvanceStatusHero />

            {/* ─── Info rows — Airbnb style: icon + label, clean dividers ─── */}
            <div className="space-y-0">
              {[
                { icon: Phone, text: txt(profile?.phone) },
                { icon: Mail, text: txt(profile?.email) },
                { icon: MapPin, text: location },
                { icon: IdCard, text: profile?.national_id ? 'ID on file' : 'No ID on file' },
                { icon: Smartphone, text: payout || 'Mobile money not set up' },
                { icon: Globe, text: profile?.whatsapp_verified ? 'WhatsApp verified' : 'WhatsApp not verified' },
                { icon: Shield, text: profile?.verified ? 'Identity verified' : 'Identity not verified' },
              ].map((row, i) => (
                <div key={i} className="flex items-center gap-4 py-4 border-b border-border/30 last:border-b-0">
                  <row.icon className="h-5 w-5 text-muted-foreground shrink-0" />
                  <p className="text-sm text-foreground">{row.text}</p>
                </div>
              ))}
            </div>

            {/* ─── Roles section ─── */}
            {roles && roles.length > 1 && (
              <>
                <div className="border-t border-border/30 pt-6">
                  <p className="text-lg font-semibold mb-3">Your roles</p>
                  <div className="flex flex-wrap gap-2">
                    {roles.map(r => (
                      <span
                        key={r}
                        className={`px-3 py-1.5 rounded-full text-sm font-medium capitalize ${
                          r === role
                            ? 'bg-foreground text-background'
                            : 'bg-muted text-muted-foreground'
                        }`}
                      >
                        {r.replace(/_/g, ' ')}
                      </span>
                    ))}
                  </div>
                </div>
              </>
            )}

            {/* ─── Member since footer ─── */}
            <div className="border-t border-border/30 pt-6">
              <p className="text-xs text-muted-foreground">
                Member since {dt(profile?.created_at)} · Last active {dt(profile?.last_active_at, true)}
              </p>
            </div>

            {/* ─── Bottom CTA ─── */}
            <Button
              variant="outline"
              className="w-full h-12 rounded-full gap-2 font-semibold"
              onClick={() => navigate('/settings')}
            >
              <Pencil className="h-4 w-4" /> Edit profile
            </Button>
          </>
        )}
      </main>
    </div>
  );
}
