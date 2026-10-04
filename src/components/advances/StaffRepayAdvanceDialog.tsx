import { useState, useEffect, useMemo } from 'react';
import { supabase } from '@/integrations/supabase/client';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Loader2, Search, ArrowLeft } from 'lucide-react';
import { formatUGX } from '@/lib/agentAdvanceCalculations';
import { toast } from 'sonner';

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSuccess: () => void;
}

interface AdvanceRow {
  id: string;
  agent_id: string;
  status: string;
  outstanding_balance: number | string;
  profiles?: { full_name: string | null; phone: string | null } | null;
}

/**
 * Staff-initiated voluntary advance repayment: pick an agent with an
 * outstanding advance, then record how much they paid.
 */
export function StaffRepayAdvanceDialog({ open, onOpenChange, onSuccess }: Props) {
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<AdvanceRow[]>([]);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<AdvanceRow | null>(null);

  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('mobile_money');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setSelected(null);
    setAmount('');
    setMethod('mobile_money');
    setReference('');
    setNotes('');

    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const { data, error } = await supabase
          .from('agent_advances')
          .select('id, agent_id, status, outstanding_balance, profiles!agent_advances_agent_id_fkey(full_name, phone)')
          .neq('status', 'completed')
          .gt('outstanding_balance', 0)
          .order('outstanding_balance', { ascending: false })
          .limit(500);
        if (error) throw error;
        if (!cancelled) setRows((data as unknown as AdvanceRow[]) || []);
      } catch (e: any) {
        if (!cancelled) toast.error(e.message || 'Failed to load advances');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows.slice(0, 50);
    return rows
      .filter((r) => {
        const name = (r.profiles?.full_name || '').toLowerCase();
        const phone = (r.profiles?.phone || '').toLowerCase();
        return name.includes(q) || phone.includes(q);
      })
      .slice(0, 50);
  }, [rows, query]);

  const outstanding = selected ? Number(selected.outstanding_balance) : 0;
  const parsed = Number(amount || 0);
  // A wallet offset has no external TID; the edge function generates one.
  const valid = parsed > 0 && parsed <= outstanding && (method === 'wallet_offset' || reference.trim().length > 0);

  const submit = async () => {
    if (!selected || !valid) {
      toast.error('Enter a valid amount');
      return;
    }
    setSubmitting(true);
    try {
      const { data, error } = await supabase.functions.invoke('cfo-record-advance-payment', {
        body: {
          advance_id: selected.id,
          amount: parsed,
          payment_method: method,
          reference: reference.trim(),
          notes: notes || null,
        },
      });
      if (error) throw error;
      if ((data as any)?.error) throw new Error((data as any).error);
      toast.success(`Recorded ${formatUGX(parsed)} repayment`);
      onSuccess();
      onOpenChange(false);
    } catch (e: any) {
      toast.error(e.message || 'Failed to record repayment');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Repay Advance</DialogTitle>
          <DialogDescription>
            {selected
              ? `${selected.profiles?.full_name || 'Agent'} · Outstanding ${formatUGX(outstanding)}`
              : 'Search for the agent whose advance repayment you are recording.'}
          </DialogDescription>
        </DialogHeader>

        {!selected ? (
          <div className="space-y-3 py-2">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                className="pl-9"
                placeholder="Search by agent name or phone"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>

            {loading ? (
              <div className="flex items-center justify-center py-8 text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin" />
              </div>
            ) : filtered.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                No agents with an outstanding advance match that search.
              </p>
            ) : (
              <div className="max-h-72 space-y-2 overflow-y-auto">
                {filtered.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => setSelected(r)}
                    className="w-full rounded-lg border p-3 text-left transition-colors hover:bg-muted"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">
                          {r.profiles?.full_name || 'Unnamed agent'}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                          {r.profiles?.phone || '—'}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="text-sm font-semibold">
                          {formatUGX(Number(r.outstanding_balance))}
                        </p>
                        <Badge variant="outline" className="mt-1 text-[10px]">
                          {r.status.replace(/_/g, ' ')}
                        </Badge>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-4 py-2">
            <div>
              <Label className="text-xs">Amount Paid (UGX)</Label>
              <Input
                type="number"
                placeholder="e.g. 100000"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                max={outstanding}
              />
              <div className="mt-2 flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setAmount(String(outstanding))}
                >
                  Full ({formatUGX(outstanding)})
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setAmount(String(Math.round(outstanding / 2)))}
                >
                  Half
                </Button>
              </div>
            </div>

            <div>
              <Label className="text-xs">Payment Method</Label>
              <Select value={method} onValueChange={setMethod}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="mobile_money">Mobile Money</SelectItem>
                  <SelectItem value="bank_transfer">Bank Transfer</SelectItem>
                  <SelectItem value="cash">Cash</SelectItem>
                  <SelectItem value="wallet_offset">Wallet Offset</SelectItem>
                  <SelectItem value="other">Other</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label className="text-xs">Reference / Transaction ID (required)</Label>
              <Input
                placeholder="e.g. MoMo TXN ID"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
              />
            </div>

            <div>
              <Label className="text-xs">Notes (optional)</Label>
              <Textarea
                placeholder="Context for audit log"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
              />
            </div>
          </div>
        )}

        <DialogFooter>
          {selected ? (
            <>
              <Button
                variant="outline"
                onClick={() => setSelected(null)}
                disabled={submitting}
                className="gap-2"
              >
                <ArrowLeft className="h-4 w-4" />
                Change agent
              </Button>
              <Button onClick={submit} disabled={!valid || submitting}>
                {submitting ? 'Recording...' : `Record ${parsed > 0 ? formatUGX(parsed) : 'Payment'}`}
              </Button>
            </>
          ) : (
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default StaffRepayAdvanceDialog;