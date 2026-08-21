import { useCallback, useEffect, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Phone, MessageCircle, CalendarClock, User } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import { normalizePhone } from '@/components/vouch/agent/lendingHelpers';

interface BorrowedLoan {
  id: string;
  lender_agent_id: string;
  lender_name: string | null;
  lender_phone: string | null;
  principal_ugx: number;
  interest_rate_pct: number | null;
  amount_repaid_ugx: number;
  status: string;
  expected_repayment_date: string | null;
  repayment_frequency: string | null;
  installment_ugx: number | null;
  next_deduction_date: string | null;
  auto_deduct_enabled: boolean | null;
  loan_purpose: string | null;
  created_at: string;
}

function outstandingOf(l: BorrowedLoan): number {
  const interest = (Number(l.principal_ugx) * (Number(l.interest_rate_pct) || 0)) / 100;
  return Math.max(0, Math.round(Number(l.principal_ugx) + interest - (Number(l.amount_repaid_ugx) || 0)));
}

/** Borrower-facing loan portfolio: what they owe, the schedule, and how to reach the lender. */
export default function MyLoansPortfolio({ refreshKey = 0 }: { refreshKey?: number }) {
  const [loans, setLoans] = useState<BorrowedLoan[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await (supabase.rpc('get_my_borrowed_loans' as any) as any);
    setLoans(((data ?? []) as BorrowedLoan[]));
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load, refreshKey]);

  if (loading) return <Skeleton className="h-28 w-full rounded-xl" />;

  return (
    <div className="space-y-2">
      <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">My Loans</Label>
      {loans.length === 0 ? (
        <p className="text-xs text-muted-foreground">No loans yet. Request one from an offer above.</p>
      ) : (
        loans.map((l) => {
          const owed = outstandingOf(l);
          const settled = l.status === 'repaid';
          const intl = normalizePhone(l.lender_phone);
          return (
            <Card key={l.id} className="border-border/60">
              <CardContent className="p-3 space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-bold">{formatUGX(l.principal_ugx)}</p>
                    <p className="text-[10px] text-muted-foreground flex items-center gap-1 truncate">
                      <User className="h-3 w-3 shrink-0" />
                      {l.lender_name ?? 'Lending agent'}{l.lender_phone ? ` · ${l.lender_phone}` : ''}
                    </p>
                  </div>
                  <Badge
                    className={
                      (settled
                        ? 'bg-emerald-500/15 text-emerald-700'
                        : l.status === 'defaulted'
                          ? 'bg-destructive/15 text-destructive'
                          : 'bg-amber-500/15 text-amber-700') +
                      ' border-0 text-[9px] font-bold capitalize'
                    }
                  >
                    {l.status.replace('_', ' ')}
                  </Badge>
                </div>

                <div className="grid grid-cols-3 gap-1.5 text-center">
                  <div className="rounded-lg bg-muted/40 p-1.5">
                    <p className="text-[9px] uppercase text-muted-foreground">Interest</p>
                    <p className="text-[11px] font-bold">{Number(l.interest_rate_pct) || 0}%</p>
                  </div>
                  <div className="rounded-lg bg-muted/40 p-1.5">
                    <p className="text-[9px] uppercase text-muted-foreground">Repaid</p>
                    <p className="text-[11px] font-bold">{formatUGX(Number(l.amount_repaid_ugx) || 0)}</p>
                  </div>
                  <div className="rounded-lg bg-muted/40 p-1.5">
                    <p className="text-[9px] uppercase text-muted-foreground">Still owed</p>
                    <p className="text-[11px] font-bold">{formatUGX(owed)}</p>
                  </div>
                </div>

                {!settled && l.auto_deduct_enabled && l.next_deduction_date && (
                  <p className="text-[10px] text-muted-foreground flex items-center gap-1">
                    <CalendarClock className="h-3 w-3" />
                    {(l.repayment_frequency ?? 'monthly').replace('_', ' ')} auto-deduction of ~{formatUGX(Number(l.installment_ugx) || 0)} · next {l.next_deduction_date}
                  </p>
                )}
                {l.loan_purpose && <p className="text-[10px] text-muted-foreground">Purpose: {l.loan_purpose}</p>}

                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="flex-1 h-8 text-[11px]"
                    disabled={!intl}
                    onClick={() => window.open(`tel:+${intl}`, '_self')}
                  >
                    <Phone className="h-3 w-3 mr-1" /> Call lender
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="flex-1 h-8 text-[11px]"
                    disabled={!intl}
                    onClick={() =>
                      window.open(
                        `https://wa.me/${intl}?text=${encodeURIComponent(`Hello, about my Welile loan of ${formatUGX(l.principal_ugx)}.`)}`,
                        '_blank',
                        'noopener,noreferrer',
                      )
                    }
                  >
                    <MessageCircle className="h-3 w-3 mr-1" /> WhatsApp
                  </Button>
                </div>
              </CardContent>
            </Card>
          );
        })
      )}
    </div>
  );
}
