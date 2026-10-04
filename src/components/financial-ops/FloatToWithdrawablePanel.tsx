import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { ArrowRightLeft, Search, Loader2, Wallet, Building2, Clock } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { invokeEdgeFunction } from '@/lib/invokeEdgeFunction';
import { toast } from 'sonner';
import { format, formatDistanceToNow } from 'date-fns';

interface UserHit {
  id: string;
  full_name: string | null;
  phone: string | null;
  float_balance: number;
  withdrawable_balance: number;
}

const fmt = (n: number) => `UGX ${Math.round(n).toLocaleString()}`;

/**
 * FloatToWithdrawablePanel — finance-leadership tool to reclassify money that is
 * stuck in a user's Operational Float (company money, never withdrawable) into
 * their own Withdrawable balance, without changing their total balance.
 *
 * All movement happens server-side via the `admin-float-to-withdrawable` edge
 * function, which posts a balanced double-entry wallet ledger transaction. This
 * component never touches wallet columns directly.
 */
interface ReclassRow {
  id: string;
  user_id: string;
  created_at: string;
  metadata: {
    target_user_id?: string;
    target_name?: string;
    amount?: number;
    reason?: string;
    reference_id?: string;
  };
  actor_name?: string;
}

export function FloatToWithdrawablePanel() {
  const [term, setTerm] = useState('');
  const [searching, setSearching] = useState(false);
  const [hits, setHits] = useState<UserHit[]>([]);
  const [selected, setSelected] = useState<UserHit | null>(null);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const { data: recent = [], isLoading: recentLoading } = useQuery({
    queryKey: ['float-to-withdrawable-recent'],
    queryFn: async () => {
      const { data: logs, error } = await supabase
        .from('audit_logs')
        .select('id, user_id, created_at, metadata')
        .eq('action_type', 'admin_float_to_withdrawable')
        .order('created_at', { ascending: false })
        .limit(50);
      if (error || !logs?.length) return [];

      const adminIds = [...new Set(logs.map((l) => l.user_id).filter(Boolean))];
      const adminMap = new Map<string, string>();
      if (adminIds.length) {
        const { data: profiles } = await supabase
          .from('profiles')
          .select('id, full_name')
          .in('id', adminIds);
        profiles?.forEach((p) => adminMap.set(p.id, p.full_name || 'Unknown'));
      }

      return logs.map((l) => ({
        ...l,
        actor_name: l.user_id ? adminMap.get(l.user_id) || 'Unknown' : 'System',
      })) as ReclassRow[];
    },
    staleTime: 15000,
  });

  const search = async () => {
    const q = term.trim();
    if (q.length < 2) {
      toast.error('Enter at least 2 characters to search.');
      return;
    }
    setSearching(true);
    setSelected(null);
    try {
      const { data: profiles, error } = await supabase
        .from('profiles')
        .select('id, full_name, phone')
        .or(`full_name.ilike.%${q}%,phone.ilike.%${q}%`)
        .limit(15);
      if (error) throw error;
      const ids = (profiles || []).map((p) => p.id);
      const balances: Record<string, { f: number; w: number }> = {};
      if (ids.length) {
        const { data: wallets } = await supabase
          .from('wallets')
          .select('user_id, float_balance, withdrawable_balance')
          .in('user_id', ids);
        for (const w of wallets || []) {
          balances[w.user_id] = {
            f: Number(w.float_balance ?? 0),
            w: Number(w.withdrawable_balance ?? 0),
          };
        }
      }
      setHits(
        (profiles || []).map((p) => ({
          id: p.id,
          full_name: p.full_name,
          phone: p.phone,
          float_balance: balances[p.id]?.f ?? 0,
          withdrawable_balance: balances[p.id]?.w ?? 0,
        })),
      );
    } catch (e) {
      toast.error('Search failed', { description: (e as Error).message });
    } finally {
      setSearching(false);
    }
  };

  const amountNum = Number(amount.replace(/[, _]/g, ''));
  const validAmount =
    Number.isInteger(amountNum) && amountNum > 0 && amountNum <= 500_000_000;
  const enoughFloat = !!selected && amountNum <= selected.float_balance;
  const canSubmit = !!selected && validAmount && enoughFloat && reason.trim().length >= 20;

  const submit = async () => {
    if (!selected) return;
    setSubmitting(true);
    const { data, error } = await invokeEdgeFunction<{
      message: string;
      float_after: number;
      withdrawable_after: number;
    }>('admin-float-to-withdrawable', {
      body: {
        target_user_id: selected.id,
        amount: amountNum,
        reason: reason.trim(),
      },
      errorTitle: 'Move failed',
    });
    setSubmitting(false);
    setConfirmOpen(false);
    if (error || !data) return;
    toast.success(data.message);
    // Reflect new balances in the selected card and reset the form.
    setSelected({
      ...selected,
      float_balance: data.float_after,
      withdrawable_balance: data.withdrawable_after,
    });
    setHits((prev) =>
      prev.map((h) =>
        h.id === selected.id
          ? { ...h, float_balance: data.float_after, withdrawable_balance: data.withdrawable_after }
          : h,
      ),
    );
    setAmount('');
    setReason('');
  };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl sm:text-2xl font-bold flex items-center gap-2.5">
          <ArrowRightLeft className="h-6 w-6 text-primary" />
          Float → Withdrawable
        </h2>
        <p className="text-sm text-muted-foreground mt-1">
          Reclassify a user's Operational Float (company money) into their own
          Withdrawable balance. Their total balance does not change.
        </p>
      </div>

      {/* Search */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">1. Find the user</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2">
            <Input
              placeholder="Search by name or phone…"
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && search()}
            />
            <Button onClick={search} disabled={searching} className="gap-2 shrink-0">
              {searching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
              Search
            </Button>
          </div>

          {hits.length > 0 && (
            <div className="space-y-2">
              {hits.map((h) => (
                <button
                  key={h.id}
                  onClick={() => setSelected(h)}
                  className={`w-full text-left rounded-lg border p-3 transition-colors ${
                    selected?.id === h.id
                      ? 'border-primary bg-primary/5'
                      : 'border-border hover:bg-muted/50'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-medium truncate">{h.full_name || 'Unknown'}</p>
                      <p className="text-xs text-muted-foreground">{h.phone || '—'}</p>
                    </div>
                    <div className="flex flex-col items-end gap-1 shrink-0">
                      <Badge variant="secondary" className="gap-1 text-[10px]">
                        <Building2 className="h-3 w-3" /> Float {fmt(h.float_balance)}
                      </Badge>
                      <Badge variant="outline" className="gap-1 text-[10px]">
                        <Wallet className="h-3 w-3" /> Withdrawable {fmt(h.withdrawable_balance)}
                      </Badge>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Move form */}
      {selected && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">
              2. Move money for {selected.full_name || 'this user'}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-lg bg-muted/50 p-3">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Available Float</p>
                <p className="font-bold">{fmt(selected.float_balance)}</p>
              </div>
              <div className="rounded-lg bg-muted/50 p-3">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Withdrawable</p>
                <p className="font-bold">{fmt(selected.withdrawable_balance)}</p>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="f2w-amount">Amount to move (UGX)</Label>
              <Input
                id="f2w-amount"
                inputMode="numeric"
                placeholder="e.g. 2000000"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
              {amount && !validAmount && (
                <p className="text-xs text-destructive">Enter a whole amount between 1 and 500,000,000.</p>
              )}
              {amount && validAmount && !enoughFloat && (
                <p className="text-xs text-destructive">Exceeds available float ({fmt(selected.float_balance)}).</p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="f2w-reason">Reason (min 20 characters)</Label>
              <Textarea
                id="f2w-reason"
                rows={2}
                placeholder="Why is this being reclassified?"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </div>

            <Button
              className="w-full gap-2"
              disabled={!canSubmit}
              onClick={() => setConfirmOpen(true)}
            >
              <ArrowRightLeft className="h-4 w-4" />
              Move {validAmount ? fmt(amountNum) : 'funds'} to Withdrawable
            </Button>
          </CardContent>
        </Card>
      )}

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm reclassification</AlertDialogTitle>
            <AlertDialogDescription>
              Move <strong>{validAmount ? fmt(amountNum) : ''}</strong> from{' '}
              <strong>Float</strong> to <strong>Withdrawable</strong> for{' '}
              <strong>{selected?.full_name || 'this user'}</strong>. Their total balance
              will not change. This is recorded in the ledger and audit trail.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={submitting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void submit();
              }}
              disabled={submitting}
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Confirm move'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Recent reclassifications */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Clock className="h-4 w-4 text-primary" />
            Recent Reclassifications
          </CardTitle>
        </CardHeader>
        <CardContent>
          {recentLoading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-primary" />
            </div>
          ) : recent.length === 0 ? (
            <div className="text-center text-sm text-muted-foreground py-6">
              No Float → Withdrawable moves yet.
            </div>
          ) : (
            <ScrollArea className="max-h-[400px]">
              <div className="space-y-2">
                {recent.map((row) => {
                  const meta = row.metadata || {};
                  const amt = Number(meta.amount ?? 0);
                  return (
                    <div
                      key={row.id}
                      className="flex items-start gap-3 rounded-lg border p-3 hover:bg-muted/40 transition-colors"
                    >
                      <div className="mt-0.5 shrink-0">
                        <Badge className="bg-primary/10 text-primary border-0 text-[10px] px-1.5 py-0">
                          {amt > 0 ? fmt(amt) : '—'}
                        </Badge>
                      </div>
                      <div className="flex-1 min-w-0 space-y-0.5">
                        <p className="text-sm font-medium truncate">
                          {meta.target_name || 'Unknown user'}
                        </p>
                        <p className="text-[11px] text-muted-foreground truncate">
                          {meta.reason || 'No reason provided'}
                        </p>
                        <p className="text-[10px] text-muted-foreground/60">
                          By <span className="font-medium">{row.actor_name}</span>
                          {' · '}
                          {formatDistanceToNow(new Date(row.created_at), { addSuffix: true })}
                          {' · '}
                          {format(new Date(row.created_at), 'dd/MM/yyyy HH:mm')}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </ScrollArea>
          )}
        </CardContent>
      </Card>
    </div>
  );
}