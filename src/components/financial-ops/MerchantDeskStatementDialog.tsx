import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import type { MerchantFloatPosition } from '@/hooks/useMerchantFloat';

/**
 * One day of a merchant desk, laid out like the paper the agent keeps: float at the start, what came in, what
 * went out, what was sent back, float at the end -- then what we owe the agent for payouts made from her own
 * money, and the net. Read only; every figure comes from `get_merchant_desk_statement`, which reads the same
 * ledger rows and own-money claims as the float board, so it cannot disagree with it.
 */
interface Statement {
  day: string;
  opening_float: number;
  received_from_company: number;
  float_set_up_by_hand: number;
  float_set_down_by_hand: number;
  paid_out_from_float: number;
  paid_out_count: number;
  telecom_from_float: number;
  returned_to_company: number;
  returned_count: number;
  other_movements: number;
  closing_float: number;
  oop_opened_today: number;
  oop_opened_today_count: number;
  oop_owed_payouts: number;
  oop_owed_payouts_count: number;
  oop_owed_telecom: number;
  oop_reimbursed_today: number;
  net_company_owes_agent: number;
}

/** Today's date in Kampala as yyyy-MM-dd, whatever the browser's own time zone is. */
function kampalaToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Kampala' }).format(new Date());
}

function Line({ label, value, tone }: { label: string; value: number; tone?: 'bad' | 'strong' }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span className={`text-[12px] ${tone === 'bad' ? 'text-destructive' : 'text-muted-foreground'}`}>{label}</span>
      <span
        className={`font-mono text-[12px] tabular-nums shrink-0 ${
          tone === 'bad' ? 'text-destructive font-bold' : tone === 'strong' ? 'font-bold text-foreground' : 'text-foreground'
        }`}
      >
        {formatUGX(value)}
      </span>
    </div>
  );
}

export function MerchantDeskStatementDialog({
  position,
  open,
  onOpenChange,
}: {
  position: MerchantFloatPosition | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const [day, setDay] = useState(kampalaToday());
  const agentId = position?.agentId ?? null;

  const { data, isLoading, error } = useQuery({
    queryKey: ['merchant-desk-statement', agentId, day],
    enabled: open && !!agentId,
    retry: false,
    staleTime: 15_000,
    queryFn: async (): Promise<Statement> => {
      const { data, error } = await supabase.rpc('get_merchant_desk_statement' as any, {
        p_agent_id: agentId,
        p_day: day,
      });
      if (error) throw error;
      return data as unknown as Statement;
    },
  });

  const s = data;
  const net = s?.net_company_owes_agent ?? 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Desk statement — {position?.agentName || position?.label || 'Merchant agent'}</DialogTitle>
          <DialogDescription>
            The day written the way the agent writes it on paper, from the same books as the float board.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2">
          <Input type="date" value={day} max={kampalaToday()} onChange={(e) => e.target.value && setDay(e.target.value)} className="h-9 w-44" />
          <Button size="sm" variant="outline" onClick={() => setDay(kampalaToday())}>
            Today
          </Button>
        </div>

        {isLoading && <p className="text-[12px] text-muted-foreground">Loading…</p>}
        {error && <p className="text-[12px] text-destructive">This statement couldn&apos;t load. {(error as any)?.message ?? ''}</p>}

        {s && (
          <div className="space-y-4">
            <div className="rounded-xl border border-border p-3">
              <Line label="Float at the start of the day" value={s.opening_float} />
              <Line label={`+ Received from the company`} value={s.received_from_company} />
              {s.float_set_up_by_hand !== 0 && <Line label="+ Float set up by hand" value={s.float_set_up_by_hand} />}
              {s.float_set_down_by_hand !== 0 && <Line label="− Float set down by hand" value={s.float_set_down_by_hand} />}
              <Line label={`− Paid out to customers (${s.paid_out_count})`} value={s.paid_out_from_float} />
              {s.telecom_from_float !== 0 && <Line label="− Telecom charges" value={s.telecom_from_float} />}
              <Line label={`− Sent back to the company (${s.returned_count})`} value={s.returned_to_company} />
              {Math.abs(s.other_movements) > 0.5 && <Line label="Other movements, not on the paper" value={s.other_movements} tone="bad" />}
              <div className="mt-1 border-t border-border pt-1">
                <Line label="= Float at the end of the day" value={s.closing_float} tone="strong" />
              </div>
            </div>

            <div className="rounded-xl border border-border p-3">
              <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">Her own money</p>
              {s.oop_opened_today !== 0 && <Line label={`Own-money payouts opened this day (${s.oop_opened_today_count})`} value={s.oop_opened_today} />}
              {s.oop_reimbursed_today !== 0 && <Line label="Paid back to her wallet this day" value={s.oop_reimbursed_today} />}
              <Line label={`We owe her for payouts (${s.oop_owed_payouts_count} open)`} value={s.oop_owed_payouts} />
              {s.oop_owed_telecom !== 0 && <Line label="Telecom charges not counted (estimates)" value={s.oop_owed_telecom} />}
              <div className="mt-1 border-t border-border pt-1">
                <Line
                  label={net >= 0 ? 'Net: we owe her' : 'Net: she holds more of ours than we owe'}
                  value={Math.abs(net)}
                  tone="strong"
                />
              </div>
              <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                Net = what we owe her for payouts − the float she still holds. Open claims stay open until finance settles them to her
                withdrawable wallet.
              </p>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
