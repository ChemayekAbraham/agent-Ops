import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/agentAdvanceCalculations';

interface Props {
  advanceId: string;
}

interface DeductionRow {
  id: string;
  created_at: string;
  amount: number | string;
  description: string | null;
}

/** What each kind of repayment line is called to the agent. Anything unknown shows the line's own description. */
function labelFor(description: string | null): string {
  const d = (description || '').toLowerCase();
  if (d.includes('auto-recovered from new earning')) return 'Taken from a commission';
  if (d.includes('collected before withdrawal')) return 'Taken when you withdrew';
  if (d.includes('daily deduction')) return 'Daily deduction';
  if (d.includes('automatic advance recovery')) return 'Automatic recovery';
  if (d.includes('voluntary') || d.includes('pay now')) return 'You paid';
  return description || 'Advance repayment';
}

const when = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', {
    timeZone: 'Africa/Kampala', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });

/**
 * Every deduction made toward one advance: the date and time, how it was taken and how much. These are the actual lines posted to the agent's wallet
 * (what left the wallet toward the advance), so the total here matches what the wallet shows.
 */
export function AdvanceDeductionsList({ advanceId }: Props) {
  const [open, setOpen] = useState(false);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['advance-deductions', advanceId],
    enabled: open,
    staleTime: 15_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('general_ledger')
        .select('id, created_at, amount, description')
        .eq('source_table', 'agent_advances')
        .eq('source_id', advanceId)
        .eq('category', 'agent_repayment')
        .eq('ledger_scope', 'wallet')
        .eq('direction', 'cash_out')
        .order('created_at', { ascending: false })
        .limit(500);
      if (error) throw error;
      return (data || []) as DeductionRow[];
    },
  });

  const rows = data || [];
  const total = rows.reduce((s, r) => s + Number(r.amount || 0), 0);

  return (
    <div className="space-y-1.5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between rounded-md bg-muted/60 px-2.5 py-1.5 text-[11px] font-semibold"
        aria-expanded={open}
      >
        <span>View deductions{open && data ? ` (${rows.length})` : ''}</span>
        {open ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
      </button>
      {open && (
        <div className="rounded-md border border-border/60 bg-card">
          {isLoading && <p className="p-2.5 text-[11px] text-muted-foreground">Loading…</p>}
          {isError && <p className="p-2.5 text-[11px] text-destructive">Could not load your deductions. Please try again.</p>}
          {!isLoading && !isError && rows.length === 0 && (
            <p className="p-2.5 text-[11px] text-muted-foreground">Nothing has been deducted toward this advance yet.</p>
          )}
          {rows.length > 0 && (
            <>
              <div className="flex items-center justify-between border-b border-border/60 px-2.5 py-1.5 text-[11px]">
                <span className="text-muted-foreground">Total deducted</span>
                <span className="font-bold tabular-nums">{formatUGX(total)}</span>
              </div>
              <ul className="max-h-64 divide-y divide-border/60 overflow-y-auto">
                {rows.map((r) => (
                  <li key={r.id} className="flex items-start justify-between gap-2 px-2.5 py-1.5">
                    <div className="min-w-0">
                      <p className="text-[11px] font-medium leading-tight">{labelFor(r.description)}</p>
                      <p className="text-[10px] leading-tight text-muted-foreground">{when(r.created_at)}</p>
                    </div>
                    <span className="shrink-0 text-[11px] font-bold tabular-nums">{formatUGX(Number(r.amount || 0))}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default AdvanceDeductionsList;
