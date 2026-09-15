import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, Check, Loader2, ScrollText, X } from 'lucide-react';
import { toast } from 'sonner';

import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';

/**
 * Tenant balance changes awaiting the CFO.
 *
 * Tenant Operations can propose a new rent amount or outstanding balance, but
 * nothing moves on the tenant's plan until the designated CFO approver decides
 * here. The figures shown are read live, so the CFO always sees what the plan
 * owes *now* — not what it owed when the change was proposed.
 */
interface PendingEdit {
  edit_id: string;
  rent_request_id: string;
  tenant_name: string | null;
  tenant_phone: string | null;
  agent_name: string | null;
  editor_name: string | null;
  submitted_at: string;
  reason: string | null;
  current_rent_amount: number | null;
  current_outstanding: number | null;
  target_rent_amount: number | null;
  target_outstanding: number | null;
  can_decide: boolean;
}

type LooseRpc = (fn: string, args?: Record<string, unknown>) =>
  Promise<{ data: unknown; error: { message: string } | null }>;
const rpc = supabase.rpc.bind(supabase) as unknown as LooseRpc;

export function CFOTenantBalanceApprovals() {
  const qc = useQueryClient();
  const [notes, setNotes] = useState<Record<string, string>>({});

  const { data, isLoading } = useQuery({
    queryKey: ['cfo-tenant-balance-edits'],
    queryFn: async (): Promise<PendingEdit[]> => {
      const { data, error } = await rpc('tenant_balance_edits_pending');
      if (error) throw error;
      return (data as PendingEdit[]) ?? [];
    },
    staleTime: 30_000,
  });

  const decide = useMutation({
    mutationFn: async (vars: { editId: string; approve: boolean }) => {
      const { data, error } = await rpc('cfo_decide_tenant_balance_edit', {
        p_edit_id: vars.editId,
        p_approve: vars.approve,
        p_note: notes[vars.editId]?.trim() || null,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: (_d, vars) => {
      toast.success(vars.approve ? 'Balance change approved and applied' : 'Balance change rejected');
      qc.invalidateQueries({ queryKey: ['cfo-tenant-balance-edits'] });
      qc.invalidateQueries({ queryKey: ['ops-tenant-rents'] });
      qc.invalidateQueries({ queryKey: ['agent-capacity-map'] });
      qc.invalidateQueries({ queryKey: ['agent-daily-eligibility'] });
    },
    onError: (e: Error) => toast.error(e.message || 'Could not record your decision'),
  });

  const rows = data ?? [];
  if (isLoading) {
    return (
      <Card><CardContent className="flex items-center gap-2 p-5 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading balance changes…
      </CardContent></Card>
    );
  }
  if (rows.length === 0) return null;

  return (
    <Card className="border-warning/40">
      <CardContent className="space-y-4 p-4 sm:p-5">
        <div className="flex items-start gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-warning/10">
            <ScrollText className="h-5 w-5 text-warning" />
          </span>
          <div className="min-w-0">
            <h3 className="text-base font-bold">Tenant balance changes awaiting you</h3>
            <p className="text-xs text-muted-foreground">
              {rows.length} change{rows.length === 1 ? '' : 's'} proposed by Tenant Operations. Nothing has moved on
              any tenant's plan yet.
            </p>
          </div>
        </div>

        <div className="space-y-3">
          {rows.map((r) => {
            const rentMoves = r.target_rent_amount != null
              && Number(r.target_rent_amount) !== Number(r.current_rent_amount ?? 0);
            const balMoves = r.target_outstanding != null
              && Number(r.target_outstanding) !== Number(r.current_outstanding ?? 0);
            const delta = r.target_outstanding != null
              ? Number(r.target_outstanding) - Number(r.current_outstanding ?? 0)
              : 0;

            return (
              <div key={r.edit_id} className="rounded-xl border bg-background p-3.5">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-bold">{r.tenant_name ?? 'Tenant'}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {r.tenant_phone ?? '—'}
                      {r.agent_name ? ` · agent ${r.agent_name}` : ''}
                    </p>
                  </div>
                  <p className="shrink-0 text-[11px] text-muted-foreground">
                    by {r.editor_name ?? 'Tenant Ops'} · {new Date(r.submitted_at).toLocaleString('en-GB', {
                      dateStyle: 'medium', timeStyle: 'short',
                    })}
                  </p>
                </div>

                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  {balMoves && (
                    <div className="rounded-lg border bg-muted/40 p-2.5">
                      <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                        Outstanding balance
                      </p>
                      <p className="mt-0.5 flex items-center gap-1.5 text-sm font-bold tabular-nums">
                        {formatUGX(Number(r.current_outstanding ?? 0))}
                        <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span className="text-primary">{formatUGX(Number(r.target_outstanding ?? 0))}</span>
                      </p>
                      <p className={`mt-0.5 text-[11px] font-semibold tabular-nums ${
                        delta > 0 ? 'text-destructive' : 'text-emerald-600 dark:text-emerald-400'}`}>
                        {delta > 0 ? '+' : ''}{formatUGX(Math.abs(delta))} {delta > 0 ? 'more owed' : 'written down'}
                      </p>
                    </div>
                  )}
                  {rentMoves && (
                    <div className="rounded-lg border bg-muted/40 p-2.5">
                      <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                        Rent amount
                      </p>
                      <p className="mt-0.5 flex items-center gap-1.5 text-sm font-bold tabular-nums">
                        {formatUGX(Number(r.current_rent_amount ?? 0))}
                        <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span className="text-primary">{formatUGX(Number(r.target_rent_amount ?? 0))}</span>
                      </p>
                      <p className="mt-0.5 text-[11px] text-muted-foreground">Fees and daily amount recalculate</p>
                    </div>
                  )}
                </div>

                {r.reason && (
                  <p className="mt-2.5 rounded-lg bg-muted/40 p-2.5 text-[13px] leading-relaxed text-muted-foreground">
                    <span className="font-semibold text-foreground">Reason: </span>{r.reason}
                  </p>
                )}

                {r.can_decide && (
                  <CfoApprovalGate>
                    <Textarea
                      rows={2}
                      className="mt-2.5 text-sm"
                      placeholder="Note for the record (optional)"
                      value={notes[r.edit_id] ?? ''}
                      onChange={(e) => setNotes((n) => ({ ...n, [r.edit_id]: e.target.value }))}
                    />
                    <div className="mt-2.5 flex flex-wrap gap-2">
                      <Button size="sm" disabled={decide.isPending}
                        onClick={() => decide.mutate({ editId: r.edit_id, approve: true })}>
                        <Check className="mr-1.5 h-4 w-4" /> Approve &amp; apply
                      </Button>
                      <Button size="sm" variant="outline" disabled={decide.isPending}
                        onClick={() => decide.mutate({ editId: r.edit_id, approve: false })}>
                        <X className="mr-1.5 h-4 w-4" /> Reject
                      </Button>
                    </div>
                  </CfoApprovalGate>
                )}
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
