import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Loader2, Store, ChevronDown, ChevronRight, Mail } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import { cn } from '@/lib/utils';
import mtnLogoAsset from '@/assets/mtn-logo.png.asset.json';
import airtelLogoAsset from '@/assets/airtel-logo.png.asset.json';

interface Transfer {
  tx_id: string;
  amount: number;
  fee: number;
  channel: string | null;
  sent_at: string;
  reference: string | null;
  snippet: string | null;
  matched_float_line: boolean;
}

interface MerchantRow {
  agent_id: string;
  name: string;
  float_phone: string | null;
  is_active: boolean;
  total_sent: number;
  total_fees: number;
  transfer_count: number;
  last_sent_at: string;
  transfers: Transfer[];
}

const RANGES = [7, 30, 90] as const;

function channelLogo(channel: string | null) {
  if (channel === 'mtn_momo') return mtnLogoAsset.url as string;
  if (channel === 'airtel_money') return airtelLogoAsset.url as string;
  return null;
}

function fmtWhen(iso: string) {
  return new Date(iso).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

/**
 * Email extraction of money the Financial Ops manager manually sent out of the
 * MTN / Airtel lines to each merchant agent. Source of truth is the provider
 * email itself (`gmail_transactions`, direction = out), matched to the merchant
 * by their float or personal payout number.
 */
export function MerchantFloatEmailMovementsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [days, setDays] = useState<number>(30);
  const [expanded, setExpanded] = useState<string | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ['merchant-float-email-movements', days],
    enabled: open,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_merchant_float_email_movements' as any, { p_days: days });
      if (error) throw error;
      const d = (data ?? {}) as any;
      return {
        grandTotal: Number(d.grand_total ?? 0),
        grandFees: Number(d.grand_fees ?? 0),
        transferCount: Number(d.transfer_count ?? 0),
        merchants: (d.merchants ?? []) as MerchantRow[],
      };
    },
    staleTime: 30_000,
    retry: false,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Mail className="h-5 w-5 text-primary" />
            Money sent to merchant agents
          </DialogTitle>
          <DialogDescription>
            Extracted from the MTN and Airtel transaction emails — every manual send out of the
            company lines, grouped by the merchant agent who received it.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2">
          {RANGES.map((r) => (
            <Button
              key={r}
              size="sm"
              variant={days === r ? 'default' : 'outline'}
              onClick={() => setDays(r)}
            >
              Last {r} days
            </Button>
          ))}
        </div>

        {isLoading ? (
          <div className="py-12 flex items-center justify-center text-muted-foreground gap-2 text-sm">
            <Loader2 className="h-4 w-4 animate-spin" /> Reading transaction emails…
          </div>
        ) : error ? (
          <p className="py-10 text-center text-sm text-destructive">
            Could not load the email extraction. {(error as Error).message}
          </p>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-3">
              <div className="rounded-xl border border-border bg-muted/30 p-3">
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Total sent out</p>
                <p className="font-mono text-base font-bold tabular-nums">{formatUGX(data?.grandTotal ?? 0)}</p>
              </div>
              <div className="rounded-xl border border-border bg-muted/30 p-3">
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Sending charges</p>
                <p className="font-mono text-base font-bold tabular-nums">{formatUGX(data?.grandFees ?? 0)}</p>
              </div>
              <div className="rounded-xl border border-border bg-muted/30 p-3">
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Transfers</p>
                <p className="font-mono text-base font-bold tabular-nums">{data?.transferCount ?? 0}</p>
              </div>
            </div>

            {(data?.merchants.length ?? 0) === 0 ? (
              <p className="py-10 text-center text-sm text-muted-foreground">
                No outgoing transfers to merchant agents found in this period.
              </p>
            ) : (
              <div className="space-y-2">
                {data!.merchants.map((m) => {
                  const isOpen = expanded === m.agent_id;
                  return (
                    <div key={m.agent_id} className="rounded-xl border border-border overflow-hidden">
                      <button
                        type="button"
                        onClick={() => setExpanded(isOpen ? null : m.agent_id)}
                        className="w-full flex items-center gap-3 p-3 text-left hover:bg-muted/40 transition-colors"
                        aria-expanded={isOpen}
                      >
                        <span className="h-9 w-9 rounded-lg shrink-0 border border-amber-500/20 bg-amber-500/10 flex items-center justify-center">
                          <Store className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                        </span>
                        <span className="flex-1 min-w-0">
                          <span className="flex items-center gap-2 min-w-0">
                            <span className="text-sm font-semibold text-foreground truncate">{m.name}</span>
                            {!m.is_active && (
                              <Badge variant="outline" className="text-[10px]">inactive</Badge>
                            )}
                          </span>
                          <span className="block text-xs text-muted-foreground truncate">
                            {m.float_phone ? `Float line ${m.float_phone} · ` : ''}
                            {m.transfer_count} transfer{m.transfer_count === 1 ? '' : 's'} · last {fmtWhen(m.last_sent_at)}
                          </span>
                        </span>
                        <span className="shrink-0 text-right">
                          <span className="block font-mono text-sm font-bold tabular-nums text-foreground">
                            {formatUGX(m.total_sent)}
                          </span>
                          <span className="block text-[11px] text-muted-foreground">
                            charges {formatUGX(m.total_fees)}
                          </span>
                        </span>
                        {isOpen ? (
                          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                        ) : (
                          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                        )}
                      </button>

                      {isOpen && (
                        <div className="border-t border-border divide-y divide-border bg-muted/20">
                          {m.transfers.map((t) => {
                            const logo = channelLogo(t.channel);
                            return (
                              <div key={t.tx_id} className="p-3 flex items-start gap-3">
                                {logo ? (
                                  <span className="h-6 w-6 rounded-md overflow-hidden shrink-0 border border-border bg-background">
                                    <img src={logo} alt={t.channel ?? ''} className="w-full h-full object-cover" loading="lazy" />
                                  </span>
                                ) : (
                                  <span className="h-6 w-6 rounded-md shrink-0 border border-border bg-background flex items-center justify-center">
                                    <Mail className="h-3 w-3 text-muted-foreground" />
                                  </span>
                                )}
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <span className="font-mono text-sm font-semibold tabular-nums text-foreground">
                                      {formatUGX(t.amount)}
                                    </span>
                                    {t.fee > 0 && (
                                      <span className="text-[11px] text-muted-foreground">
                                        + {formatUGX(t.fee)} charge
                                      </span>
                                    )}
                                    <Badge
                                      variant="outline"
                                      className={cn(
                                        'text-[10px]',
                                        t.matched_float_line && 'border-emerald-500/30 text-emerald-600 dark:text-emerald-400',
                                      )}
                                    >
                                      {t.matched_float_line ? 'float line' : 'personal line'}
                                    </Badge>
                                  </div>
                                  <p className="text-xs text-muted-foreground mt-0.5">
                                    {fmtWhen(t.sent_at)}
                                    {t.reference ? ` · Ref ${t.reference}` : ''}
                                  </p>
                                  {t.snippet && (
                                    <p className="text-[11px] text-muted-foreground/80 mt-1 line-clamp-2">
                                      {t.snippet}
                                    </p>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
