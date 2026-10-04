import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { toast } from 'sonner';
import { Loader2, MapPin, Wallet, Info, Link2 } from 'lucide-react';
import { format } from 'date-fns';
import { formatUGX } from '@/lib/businessAdvanceCalculations';

const STATUS_LABEL: Record<string, string> = {
  attached: 'Attached (not yet recovering)',
  active: 'Recovering daily',
  paused: 'Paused',
  completed: 'Fully recovered',
  cancelled: 'Cancelled',
};

export function ServiceCentreAdvancesPanel() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [openEntryId, setOpenEntryId] = useState<string | null>(null);
  const [agentId, setAgentId] = useState('');
  const [amount, setAmount] = useState('');
  const [durationDays, setDurationDays] = useState('30');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const { data: verified, isLoading } = useQuery({
    queryKey: ['service-centre-entries', 'verified'],
    staleTime: 30_000,
    queryFn: async () => {
      const { data } = await supabase
        .from('service_centre_entries')
        .select('*')
        .eq('status', 'verified')
        .order('verified_at', { ascending: false })
        .limit(100);
      return (data || []) as any[];
    },
  });

  const { data: advances } = useQuery({
    queryKey: ['service-centre-advances'],
    staleTime: 30_000,
    queryFn: async () => {
      const { data } = await supabase
        .from('service_centre_advances')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(300);
      return (data || []) as any[];
    },
  });

  const resetForm = () => {
    setOpenEntryId(null);
    setAgentId('');
    setAmount('');
    setDurationDays('30');
    setNotes('');
  };

  const attach = async (entry: any) => {
    const principal = Number(amount);
    const days = Number(durationDays);
    if (!agentId.trim()) {
      toast.error('Select the agent this service centre money belongs to.');
      return;
    }
    if (!principal || principal <= 0) {
      toast.error('Enter the service centre amount (unit price) to attach.');
      return;
    }
    if (!days || days <= 0) {
      toast.error('Enter a recovery duration in days.');
      return;
    }
    setSaving(true);
    try {
      const { error } = await supabase.from('service_centre_advances').insert({
        entry_id: entry.id,
        agent_id: agentId.trim(),
        principal_amount: principal,
        daily_deduction: Math.ceil(principal / days),
        duration_days: days,
        notes: notes.trim() || null,
        attached_by: user?.id ?? null,
        status: 'attached',
      } as any);
      if (error) throw error;
      toast.success('Service centre money attached as an advance.');
      resetForm();
      queryClient.invalidateQueries({ queryKey: ['service-centre-advances'] });
    } catch (err: any) {
      toast.error(err.message || 'Failed to attach service centre money');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* How this will flow */}
      <div className="rounded-xl border border-border bg-muted/40 p-3 space-y-2">
        <p className="text-sm font-semibold text-foreground flex items-center gap-1.5">
          <Info className="h-4 w-4 text-primary" /> How service centre money will flow
        </p>
        <ol className="text-xs text-muted-foreground space-y-1 list-decimal pl-4">
          <li>A service centre entry is approved by COO, then verified by CEO.</li>
          <li>
            Agent Operations attaches the service centre money (the entry’s unit price) to the agent who runs that
            centre. This creates a <span className="font-medium text-foreground">service centre advance</span> record
            linked to the parent service centre.
          </li>
          <li>
            The attached amount becomes a liability the agent owes the company, recovered by a fixed{' '}
            <span className="font-medium text-foreground">daily deduction</span> from the agent’s{' '}
            <span className="font-medium text-foreground">withdrawable wallet</span> — never from float.
          </li>
          <li>
            Daily deduction = attached amount ÷ recovery duration (days). Each recovery will post double-entry ledger
            legs and increase <span className="font-medium text-foreground">Recovered</span> until the advance is
            fully recovered.
          </li>
          <li>If the agent has no withdrawable balance on a given day, the day is skipped and carried as arrears.</li>
        </ol>
        <p className="text-[11px] text-amber-600 dark:text-amber-500 font-medium">
          Phase 1 (now): attach and track only. The automatic daily wallet deduction, ledger posting and arrears engine
          arrive in Phase 2 — nothing is deducted yet.
        </p>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : !verified?.length ? (
        <p className="text-sm text-muted-foreground text-center py-4">
          No verified service centres yet. Verify an entry first, then attach its money here.
        </p>
      ) : (
        <div className="space-y-3">
          {verified.map((e) => {
            const linked = (advances || []).filter((a) => a.entry_id === e.id);
            return (
              <div key={e.id} className="rounded-xl border border-border p-3 space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-foreground flex items-center gap-1 truncate">
                      <MapPin className="h-3.5 w-3.5 text-primary" />{e.stationed_location}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Unit price {formatUGX(Number(e.unit_price) || 0)} · verified{' '}
                      {e.verified_at ? format(new Date(e.verified_at), 'dd MMM yyyy') : '—'}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="shrink-0 gap-1"
                    onClick={() => {
                      setOpenEntryId(openEntryId === e.id ? null : e.id);
                      setAmount(String(Number(e.unit_price) || 0));
                    }}
                  >
                    <Wallet className="h-3 w-3" /> Attach money
                  </Button>
                </div>

                {linked.length > 0 && (
                  <div className="space-y-1.5">
                    {linked.map((a) => (
                      <div key={a.id} className="rounded-lg bg-muted/50 p-2 text-xs space-y-0.5">
                        <p className="font-semibold text-foreground flex items-center gap-1">
                          <Link2 className="h-3 w-3" /> {formatUGX(Number(a.principal_amount) || 0)} ·{' '}
                          {STATUS_LABEL[a.status] || a.status}
                        </p>
                        <p className="text-muted-foreground">
                          Daily {formatUGX(Number(a.daily_deduction) || 0)} over {a.duration_days} days · recovered{' '}
                          {formatUGX(Number(a.amount_recovered) || 0)}
                        </p>
                        {a.notes && <p className="text-muted-foreground">{a.notes}</p>}
                      </div>
                    ))}
                  </div>
                )}

                {openEntryId === e.id && (
                  <div className="space-y-2 rounded-lg border border-dashed border-border p-2">
                    <div className="space-y-1">
                      <Label className="text-xs">Agent (user ID)</Label>
                      <Input
                        placeholder="Agent user ID"
                        value={agentId}
                        onChange={(ev) => setAgentId(ev.target.value)}
                        className="h-9 text-xs"
                      />
                      {(e.assigned_agent_ids || []).length > 0 && (
                        <div className="flex flex-wrap gap-1 pt-1">
                          {(e.assigned_agent_ids || []).map((id: string) => (
                            <button
                              key={id}
                              type="button"
                              onClick={() => setAgentId(id)}
                              className="text-[10px] px-2 py-0.5 rounded-full bg-accent text-accent-foreground"
                            >
                              {id.slice(0, 8)}…
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="space-y-1">
                        <Label className="text-xs">Amount (UGX)</Label>
                        <Input
                          type="number"
                          value={amount}
                          onChange={(ev) => setAmount(ev.target.value)}
                          className="h-9 text-xs"
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">Recovery days</Label>
                        <Input
                          type="number"
                          value={durationDays}
                          onChange={(ev) => setDurationDays(ev.target.value)}
                          className="h-9 text-xs"
                        />
                      </div>
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                      Planned daily deduction:{' '}
                      <span className="font-semibold text-foreground">
                        {formatUGX(
                          Number(durationDays) > 0 ? Math.ceil((Number(amount) || 0) / Number(durationDays)) : 0,
                        )}
                      </span>
                    </p>
                    <Textarea
                      placeholder="Notes (optional)"
                      value={notes}
                      onChange={(ev) => setNotes(ev.target.value)}
                      rows={2}
                      className="text-xs"
                    />
                    <div className="flex gap-2">
                      <Button size="sm" className="flex-1 gap-1" disabled={saving} onClick={() => attach(e)}>
                        {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Wallet className="h-3 w-3" />}
                        Attach as service centre advance
                      </Button>
                      <Button size="sm" variant="ghost" onClick={resetForm}>Cancel</Button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
