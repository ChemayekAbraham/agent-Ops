import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Circle, Home, Loader2, MapPin, UserCheck } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { supabase } from '@/integrations/supabase/client';
import { formatDynamic } from '@/lib/currencyFormat';
import { HOUSE_MONTHLY_ROI_RATE } from './SelfSupportHousesSection';

const PLACEMENT_PROMISE_DAYS = 7;

interface PlacementRow {
  house_id: string;
  title: string | null;
  house_category: string | null;
  district: string | null;
  sub_county: string | null;
  village: string | null;
  image_url: string | null;
  monthly_rent: number | null;
  principal: number | null;
  status: string | null;
  listing_agent_id: string | null;
  agent_name: string | null;
  supported_at: string | null;
  placed_at: string | null;
  days_to_place: number | null;
}

const fmtDate = (iso: string | null) =>
  iso
    ? new Intl.DateTimeFormat('en-UG', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        timeZone: 'Africa/Kampala',
      }).format(new Date(iso))
    : null;

const addDays = (iso: string, days: number) => {
  const d = new Date(iso);
  d.setDate(d.getDate() + days);
  return d.toISOString();
};

const locationLine = (r: PlacementRow) =>
  [r.village, r.sub_county, r.district].filter(Boolean).join(', ') || 'Location on file';

type StepState = 'done' | 'current' | 'upcoming';

function Step({ state, label, detail }: { state: StepState; label: string; detail?: string | null }) {
  return (
    <li className="flex items-start gap-2.5">
      <span className="mt-0.5 flex-none" aria-hidden>
        {state === 'done' ? (
          <CheckCircle2 className="h-4 w-4 text-success" />
        ) : state === 'current' ? (
          <Loader2 className="h-4 w-4 animate-spin text-primary" />
        ) : (
          <Circle className="h-4 w-4 text-muted-foreground/50" />
        )}
      </span>
      <span className="min-w-0">
        <span
          className={`block text-[12px] font-semibold leading-tight ${
            state === 'upcoming' ? 'text-muted-foreground' : 'text-foreground'
          }`}
        >
          {label}
        </span>
        {detail && (
          <span className="block text-[10px] leading-snug text-muted-foreground">{detail}</span>
        )}
      </span>
    </li>
  );
}

/**
 * Per-house tenant placement timeline for houses a funder has funded:
 * funded → agent notified → sourcing tenant → tenant placed (7-day promise).
 * Self-contained: fetches its own rows and renders nothing when the funder
 * has not funded any house yet.
 */
export function HousePlacementTimeline({
  partnerId,
  refreshKey = 0,
}: {
  partnerId: string;
  refreshKey?: number;
}) {
  const query = useQuery({
    queryKey: ['psm-house-placement', partnerId, refreshKey],
    enabled: !!partnerId,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('partner_house_placement_status', {
        p_partner_id: partnerId,
      });
      if (error) throw error;
      return (data ?? []) as unknown as PlacementRow[];
    },
    staleTime: 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const rows = query.data ?? [];
  if (!query.isLoading && rows.length === 0) return null;

  return (
    <section aria-label="Tenant placement progress for your funded houses" className="space-y-2">
      <div className="flex items-center gap-2">
        <Home className="h-4 w-4 text-primary" aria-hidden />
        <h3 className="text-sm font-extrabold">Your funded houses — tenant placement</h3>
      </div>

      {query.isLoading ? (
        <Card className="rounded-2xl border p-4 text-xs text-muted-foreground">
          Loading placement progress…
        </Card>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => {
            const agentKnown = !!r.listing_agent_id;
            const placed = !!r.placed_at;
            const dueBy = r.supported_at ? addDays(r.supported_at, PLACEMENT_PROMISE_DAYS) : null;
            const inReview = r.status !== 'active' && !placed;
            const monthlyReturn = Number(r.principal ?? 0) * (HOUSE_MONTHLY_ROI_RATE / 100);

            return (
              <li key={r.house_id}>
                <Card className="overflow-hidden rounded-2xl border">
                  <div className="flex gap-3 p-3">
                    {r.image_url && (
                      <img
                        src={r.image_url}
                        alt={`${r.title || 'Funded house'} photo`}
                        loading="lazy"
                        className="h-16 w-16 flex-none rounded-xl object-cover"
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] font-bold leading-tight">
                        {r.title || 'Funded house'}
                        {r.house_category ? (
                          <span className="font-medium text-muted-foreground"> · {r.house_category}</span>
                        ) : null}
                      </p>
                      <p className="mt-0.5 flex items-center gap-1 truncate text-[10px] text-muted-foreground">
                        <MapPin className="h-3 w-3 flex-none" aria-hidden />
                        {locationLine(r)}
                      </p>
                      <p className="mt-1 text-[11px] font-bold text-success">
                        You earn {formatDynamic(monthlyReturn)} every month
                      </p>
                    </div>
                    {placed ? (
                      <Badge className="h-fit flex-none rounded-full bg-success/10 text-[10px] font-bold text-success hover:bg-success/10">
                        Tenant placed
                      </Badge>
                    ) : inReview ? (
                      <Badge variant="secondary" className="h-fit flex-none rounded-full text-[10px] font-bold">
                        Being set up
                      </Badge>
                    ) : (
                      <Badge className="h-fit flex-none rounded-full bg-primary/10 text-[10px] font-bold text-primary hover:bg-primary/10">
                        Sourcing tenant
                      </Badge>
                    )}
                  </div>

                  <ol className="space-y-2.5 border-t border-border/60 px-3 py-3">
                    <Step state="done" label="You funded this house" detail={fmtDate(r.supported_at)} />
                    <Step
                      state={agentKnown ? 'done' : 'current'}
                      label={
                        agentKnown
                          ? `Agent notified — ${r.agent_name || 'your Welile agent'}`
                          : 'Welile agent being notified'
                      }
                      detail={
                        agentKnown
                          ? 'The agent is now responsible for placing a tenant'
                          : 'A Welile agent is being assigned to this house'
                      }
                    />
                    <Step
                      state={placed ? 'done' : agentKnown ? 'current' : 'upcoming'}
                      label="Tenant being sourced"
                      detail={
                        placed
                          ? undefined
                          : dueBy
                            ? `Tenant promised within ${PLACEMENT_PROMISE_DAYS} days — by ${fmtDate(dueBy)}`
                            : undefined
                      }
                    />
                    <Step
                      state={placed ? 'done' : 'upcoming'}
                      label={placed ? 'Tenant placed' : 'Tenant placed — you start earning'}
                      detail={
                        placed
                          ? `${fmtDate(r.placed_at)}${
                              r.days_to_place != null
                                ? ` · placed in ${r.days_to_place} day${r.days_to_place === 1 ? '' : 's'}${
                                    r.days_to_place <= PLACEMENT_PROMISE_DAYS
                                      ? ' — within the 7-day promise'
                                      : ''
                                  }`
                                : ''
                            }`
                          : 'Your Returns start once the tenant begins paying rent'
                      }
                    />
                  </ol>

                  {placed && (
                    <p className="flex items-center gap-1.5 border-t border-success/20 bg-success/5 px-3 py-2 text-[11px] font-semibold text-success">
                      <UserCheck className="h-3.5 w-3.5 flex-none" aria-hidden />
                      Rent collection is running — your Returns are paid monthly.
                    </p>
                  )}
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export default HousePlacementTimeline;
