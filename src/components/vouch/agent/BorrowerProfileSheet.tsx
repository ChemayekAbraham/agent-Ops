import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Sheet, SheetContent, SheetTitle,
} from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { UserAvatar } from '@/components/UserAvatar';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Banknote, BadgeCheck, MapPin, Phone, ShieldCheck } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { formatLocation } from '@/lib/locationText';
import { cn } from '@/lib/utils';

export interface DirectoryPerson {
  id: string;
  full_name: string | null;
  phone: string | null;
  avatar_url: string | null;
  village: string | null;
  parish: string | null;
  sub_county: string | null;
  district: string | null;
  city: string | null;
  trust?: { user_id: string; ai_id: string | null; borrowing_limit_ugx: number | string | null } | null;
}

interface Props {
  person: DirectoryPerson | null;
  onLend: (phone: string) => void;
  onClose: () => void;
}

/**
 * Detailed borrower profile shown when a lending agent selects someone from
 * the "See users that I can lend to" directory: identity (AI ID), contact,
 * full location, Welile trust/vouch details and this agent's own lending
 * history with that person.
 */
export default function BorrowerProfileSheet({ person, onLend, onClose }: Props) {
  const { user } = useAuth();
  const [loans, setLoans] = useState<
    { id: string; principal_ugx: number; amount_repaid_ugx: number; status: string; created_at: string; borrower_display_name: string | null; funding_source?: string | null }[]
  >([]);
  const [loansLoading, setLoansLoading] = useState(false);

  const trustQuery = useQuery({
    queryKey: ['borrower-profile-trust', person?.id],
    enabled: !!person,
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('welile_trust_score_cache')
        .select('user_id, ai_id, score, tier, data_points, borrowing_limit_ugx, breakdown, agent_earned_vouch_ugx, last_calculated_at')
        .eq('user_id', person!.id)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  // This agent's own lending history with the selected person.
  useEffect(() => {
    if (!person || !user) { setLoans([]); return; }
    let cancelled = false;
    setLoansLoading(true);
    (supabase
      .from('lending_agent_loans' as any)
      .select('id, principal_ugx, amount_repaid_ugx, status, created_at, borrower_display_name, funding_source')
      .eq('lender_agent_id', user.id)
      .eq('borrower_user_id', person.id)
      .order('created_at', { ascending: false })
      .limit(50) as any)
      .then(({ data }: any) => {
        if (!cancelled) setLoans((data ?? []) as typeof loans);
        if (!cancelled) setLoansLoading(false);
      });
    return () => { cancelled = true; };
  }, [person, user]);

  const open = !!person;
  const name = person?.full_name || 'Welile user';
  const trust = trustQuery.data;
  const score = Math.max(0, Math.min(100, Number(trust?.score) || 0));
  const tier = trust?.tier ?? 'unrated';
  const limit = Number(trust?.borrowing_limit_ugx ?? person?.trust?.borrowing_limit_ugx) || 0;
  const b = (trust?.breakdown ?? {}) as Record<string, number>;
  const risk = score >= 75 ? 'Low risk' : score >= 50 ? 'Moderate risk' : 'High risk';
  const riskChip = score >= 75
    ? 'bg-emerald-500/10 text-emerald-700 border-emerald-500/30'
    : score >= 50
      ? 'bg-amber-500/10 text-amber-700 border-amber-500/30'
      : 'bg-destructive/10 text-destructive border-destructive/30';

  const totalLent = loans.reduce((s, l) => s + (Number(l.principal_ugx) || 0), 0);
  const stillOwed = loans.reduce((s, l) => s + Math.max(0, (Number(l.principal_ugx) || 0) - (Number(l.amount_repaid_ugx) || 0)), 0);

  const locationParts = person ? [person.village, person.parish, person.sub_county, person.district, person.city] : [];
  const shortLocation = formatLocation(locationParts);

  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent side="bottom" className="h-[92dvh] overflow-y-auto rounded-t-lg p-0">
        <div className="mx-auto max-w-3xl px-5 pt-6 pb-[calc(2.5rem+env(safe-area-inset-bottom))] space-y-5">
          {/* Identity header */}
          <div className="flex items-start gap-4">
            <UserAvatar avatarUrl={person?.avatar_url} fullName={name} size="lg" />
            <div className="min-w-0 flex-1">
              <SheetTitle className="text-xl font-semibold text-foreground">{name}</SheetTitle>
              <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                <BadgeCheck className="h-3.5 w-3.5 shrink-0" />
                <span className="break-all">{trust?.ai_id ?? person?.trust?.ai_id ?? 'AI ID not available'}</span>
              </p>
              {trustQuery.isLoading ? (
                <Skeleton className="mt-2 h-5 w-28 rounded-full" />
              ) : (
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <span className={cn('rounded-md border px-1.5 py-0.5 text-[10px] font-bold capitalize', riskChip)}>{tier}</span>
                  <span className={cn('rounded-md border px-1.5 py-0.5 text-[10px] font-semibold', riskChip)}>{risk}</span>
                </div>
              )}
            </div>
          </div>

          {/* Contact & location */}
          <section className="rounded-2xl border border-border bg-card p-4 space-y-3">
            <div className="flex items-start gap-3">
              <Phone className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Phone number</p>
                {person?.phone ? (
                  <a href={`tel:${person.phone}`} className="text-base font-semibold text-foreground break-all">{person.phone}</a>
                ) : (
                  <p className="text-sm text-muted-foreground">Not provided</p>
                )}
              </div>
            </div>
            <div className="flex items-start gap-3 border-t border-border pt-3">
              <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Location</p>
                {locationParts.some(Boolean) ? (
                  <>
                    <p className="text-sm font-semibold text-foreground">{shortLocation || '—'}</p>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {(['village', 'parish', 'sub_county', 'district', 'city'] as const).map((k) => (
                        person?.[k] ? (
                          <Badge key={k} variant="outline" className="text-[10px] font-normal capitalize">
                            {k.replace('_', ' ')}: {person[k]}
                          </Badge>
                        ) : null
                      ))}
                    </div>
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">Not provided</p>
                )}
              </div>
            </div>
          </section>

          {/* Welile trust / vouch */}
          <section className="rounded-2xl border border-emerald-500/40 bg-gradient-to-br from-emerald-500/15 to-emerald-500/5 p-4 space-y-3">
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-emerald-700 dark:text-emerald-400" />
              <p className="text-sm font-bold text-foreground">Welile vouch</p>
            </div>
            {trustQuery.isLoading ? (
              <Skeleton className="h-10 w-40 rounded-lg" />
            ) : (
              <>
                <p className="text-3xl font-semibold text-foreground tabular-nums">{formatUGX(limit)}</p>
                <p className="text-xs text-muted-foreground">
                  Maximum amount Welile stands behind for this borrower.
                  {trust?.agent_earned_vouch_ugx != null && Number(trust.agent_earned_vouch_ugx) > 0
                    ? ` Welile agents have earned ${formatUGX(Number(trust.agent_earned_vouch_ugx))} from them so far.`
                    : ''}
                </p>
                <div className="flex items-center gap-2 rounded-xl border border-border bg-background/60 px-3 py-2">
                  <span className="text-2xl font-bold tabular-nums text-foreground">{score}</span>
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground">/ 100 trust</span>
                  <span className="ml-auto text-[10px] text-muted-foreground">{trust?.data_points ?? 0} data points</span>
                </div>
                <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
                  {([
                    ['Payment', b.payment], ['Wallet', b.wallet], ['Network', b.network],
                    ['Verification', b.verification], ['Behaviour', b.behavior], ['Landlord', b.landlord],
                  ] as const).map(([label, value]) => (
                    <div key={label}>
                      <div className="flex items-center justify-between gap-1">
                        <span className="text-[10px] text-muted-foreground truncate">{label}</span>
                        <span className="text-[10px] font-semibold tabular-nums">{Math.max(0, Number(value) || 0)}</span>
                      </div>
                      <div className="h-1 rounded-full bg-border overflow-hidden">
                        <div
                          className={cn('h-full rounded-full', score >= 75 ? 'bg-emerald-500' : score >= 50 ? 'bg-amber-500' : 'bg-destructive')}
                          style={{ width: `${Math.min(100, Math.max(0, Number(value) || 0))}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </section>

          {/* This agent's history with the borrower */}
          <section className="rounded-2xl border border-border bg-card p-4 space-y-3">
            <div className="flex items-center gap-2">
              <Banknote className="h-4 w-4 text-muted-foreground" />
              <p className="text-sm font-bold text-foreground">Your history with this borrower</p>
            </div>
            {loansLoading ? (
              <Skeleton className="h-14 w-full rounded-lg" />
            ) : loans.length === 0 ? (
              <p className="text-xs text-muted-foreground">You have not lent to this person yet. Any amount you lend here will appear on your Borrowers list.</p>
            ) : (
              <>
                <div className="grid grid-cols-3 gap-2 text-center">
                  <div className="rounded-lg bg-muted p-2">
                    <p className="text-[10px] text-muted-foreground">Loans</p>
                    <p className="text-sm font-bold tabular-nums">{loans.length}</p>
                  </div>
                  <div className="rounded-lg bg-muted p-2">
                    <p className="text-[10px] text-muted-foreground">Lent</p>
                    <p className="text-sm font-bold tabular-nums">{formatUGX(totalLent)}</p>
                  </div>
                  <div className="rounded-lg bg-muted p-2">
                    <p className="text-[10px] text-muted-foreground">Still owed</p>
                    <p className="text-sm font-bold tabular-nums">{formatUGX(stillOwed)}</p>
                  </div>
                </div>
                <div className="space-y-1.5">
                  {loans.slice(0, 5).map((l) => (
                    <div key={l.id} className="flex items-center justify-between gap-2 text-xs">
                      <span className="text-muted-foreground">{new Date(l.created_at).toLocaleDateString()}</span>
                      <span className="font-semibold tabular-nums">{formatUGX(Number(l.principal_ugx))}</span>
                      <Badge variant="outline" className="text-[9px] capitalize">{(l.status || '').replace(/_/g, ' ')}</Badge>
                    </div>
                  ))}
                </div>
              </>
            )}
          </section>

          {/* Lend action */}
          <Button
            className="h-14 w-full text-base font-semibold"
            disabled={!person?.phone}
            onClick={() => { if (person?.phone) { onClose(); onLend(person.phone); } }}
          >
            <Banknote className="mr-2 h-5 w-5" />Lend to {name}
          </Button>
          {!person?.phone && (
            <p className="text-center text-xs text-muted-foreground">This borrower has no phone number on file, so they cannot receive a transfer.</p>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
