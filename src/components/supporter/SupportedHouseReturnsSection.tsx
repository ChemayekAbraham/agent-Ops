import { useEffect } from 'react';
import { usePolling } from '@/hooks/usePolling';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { formatUGX } from '@/lib/rentCalculations';
import { Home, TrendingUp, CheckCircle2, Clock, UserCheck, Banknote } from 'lucide-react';


interface SupportedHouseRow {
  intent_id: string;
  note_id: string;
  house_id: string;
  title: string | null;
  district: string | null;
  sub_county: string | null;
  village: string | null;
  monthly_rent: number;
  monthly_return: number;
  annual_return: number;
  intent_status: string | null;
  note_status: string | null;
  promised_amount: number;
  collected_amount: number;
  is_funded: boolean;
  tenant_activated: boolean;
  tenant_name: string | null;
  listing_agent_name: string | null;
  monthly_paid_this_month: boolean;
  last_paid_at: string | null;
  created_at: string;
}

interface SupportedHouseReturnsPayload {
  houses: SupportedHouseRow[];
  total_monthly_return: number;
  total_annual_return: number;
  house_count: number;
}

const StatusPill = ({
  active,
  label,
  icon: Icon,
}: {
  active: boolean;
  label: string;
  icon: typeof CheckCircle2;
}) => (
  <span
    className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold ${
      active
        ? 'border-primary/30 bg-primary/10 text-primary'
        : 'border-border bg-muted/50 text-muted-foreground'
    }`}
  >
    <Icon className="h-3 w-3" />
    {label}
  </span>
);

export function SupportedHouseReturnsSection() {
  const queryClient = useQueryClient();



  const { data, isLoading, error } = useQuery({
    queryKey: ['partner-supported-house-returns'],
    queryFn: async (): Promise<SupportedHouseReturnsPayload> => {
      const { data, error } = await supabase.rpc('partner_supported_house_returns');
      if (error) throw error;
      return (data as unknown as SupportedHouseReturnsPayload) ?? {
        houses: [],
        total_monthly_return: 0,
        total_annual_return: 0,
        house_count: 0,
      };
    },
    staleTime: 60_000,
  });

  // Real-time status refresh when funding / tenant placement / payouts change
  useEffect(() => {
    const invalidate = () => {
      queryClient.invalidateQueries({ queryKey: ['partner-supported-house-returns'] });
    };
    // promissory_notes is published, so it stays live.
    // promissory_note_house_intents and agent_landlord_payouts are not, so
    // their listeners never fired; they are covered by the 60s poll below
    // (doc 147).
    const channel = supabase
      .channel('partner-supported-house-returns')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'promissory_notes' }, invalidate)
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [queryClient]);
  usePolling(
    () => queryClient.invalidateQueries({ queryKey: ['partner-supported-house-returns'] }),
    60_000,
  );

  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-20 w-full rounded-2xl" />
        <Skeleton className="h-28 w-full rounded-2xl" />
      </div>
    );
  }

  if (error) return null;

  const houses = data?.houses ?? [];
  const houseCount = data?.house_count ?? 0;

  if (houseCount === 0) return null;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 px-1">
        <div className="w-1 h-5 rounded-full bg-primary" />
        <h2 className="text-sm font-black tracking-tight text-foreground">Houses You Support</h2>
        <Badge variant="secondary" className="text-[10px] font-bold">
          {houseCount}
        </Badge>
      </div>

      <Card className="rounded-2xl border-primary/20 bg-primary/5 p-4">

        <div className="grid grid-cols-2 gap-4">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
              Your 15% each month
            </p>
            <p className="text-xl font-black text-primary">{formatUGX(data?.total_monthly_return ?? 0)}</p>
          </div>
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
              Over 12 months
            </p>
            <p className="text-xl font-black text-foreground">{formatUGX(data?.total_annual_return ?? 0)}</p>
          </div>
        </div>
        <p className="mt-3 flex items-start gap-1.5 text-[11px] leading-snug text-muted-foreground">
          <TrendingUp className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
          You earn 15% of the rent you fund every month. The agent who listed the house places the
          tenant and collects the rent monthly.
        </p>
      </Card>

      <div className="space-y-3">
        {houses.map((h) => (
          <Card key={h.intent_id} className="rounded-2xl p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="flex items-center gap-1.5 truncate text-sm font-bold text-foreground">
                  <Home className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  {h.title || 'Empty house'}
                </p>
                <p className="truncate text-[11px] text-muted-foreground">
                  {[h.village, h.sub_county, h.district].filter(Boolean).join(', ') || 'Location pending'}
                </p>
              </div>
              <div className="shrink-0 text-right">
                <p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                  Monthly
                </p>
                <p className="text-base font-black text-primary">{formatUGX(h.monthly_return)}</p>
              </div>
            </div>

            <div className="mt-3 grid grid-cols-2 gap-3 rounded-xl bg-muted/40 p-3">
              <div>
                <p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                  Rent funded
                </p>
                <p className="text-sm font-bold text-foreground">{formatUGX(h.monthly_rent)}</p>
              </div>
              <div>
                <p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                  12-month total
                </p>
                <p className="text-sm font-bold text-foreground">{formatUGX(h.annual_return)}</p>
              </div>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              <StatusPill active={h.is_funded} label={h.is_funded ? 'Funded' : 'Awaiting funding'} icon={h.is_funded ? CheckCircle2 : Clock} />
              <StatusPill
                active={h.tenant_activated}
                label={h.tenant_activated ? `Tenant activated${h.tenant_name ? `: ${h.tenant_name}` : ''}` : 'Tenant pending'}
                icon={UserCheck}
              />
              <StatusPill
                active={h.monthly_paid_this_month}
                label={h.monthly_paid_this_month ? 'Paid this month' : 'Monthly payment pending'}
                icon={Banknote}
              />
            </div>

            {h.listing_agent_name && (
              <p className="mt-2 text-[11px] text-muted-foreground">
                Listing agent: <span className="font-semibold text-foreground">{h.listing_agent_name}</span>
              </p>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}

export default SupportedHouseReturnsSection;
