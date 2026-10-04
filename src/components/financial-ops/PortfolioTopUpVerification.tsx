import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Loader2, CheckCircle2, XCircle, ShieldCheck, Clock, Briefcase } from 'lucide-react';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { format } from 'date-fns';

interface GroupedTopUp {
  portfolio_id: string;
  portfolio_code: string;
  account_name: string | null;
  partner_name: string;
  partner_phone: string;
  current_capital: number;
  ops: { id: string; amount: number; created_at: string }[];
  total: number;
  submitted_at: string;
}

export function PortfolioTopUpVerification() {
  const queryClient = useQueryClient();
  const [processing, setProcessing] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<{ portfolio_id: string; action: 'approve' | 'reject'; group: GroupedTopUp } | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  const { data: groups = [], isLoading } = useQuery({
    queryKey: ['awaiting-verification-topups'],
    queryFn: async () => {
      // Fetch all awaiting_verification portfolio top-ups
      const { data: ops, error } = await supabase
        .from('pending_wallet_operations')
        .select('id, amount, source_id, user_id, created_at, reviewed_at')
        .eq('source_table', 'investor_portfolios')
        .eq('operation_type', 'portfolio_topup')
        .eq('status', 'awaiting_verification')
        .order('reviewed_at', { ascending: true });

      if (error || !ops || ops.length === 0) return [];

      // Get unique portfolio IDs
      const portfolioIds = [...new Set(ops.map(o => o.source_id))];
      const userIds = [...new Set(ops.map(o => o.user_id))];

      // Batch fetch portfolios and profiles
      const [portfolioRes, profileRes] = await Promise.all([
        supabase
          .from('investor_portfolios')
          .select('id, portfolio_code, account_name, investment_amount, investor_id, agent_id')
          .in('id', portfolioIds),
        supabase
          .from('profiles')
          .select('id, full_name, phone')
          .in('id', userIds),
      ]);

      const portfolioMap = new Map((portfolioRes.data || []).map(p => [p.id, p]));
      const profileMap = new Map((profileRes.data || []).map(p => [p.id, p]));

      // Group by portfolio
      const grouped: Record<string, GroupedTopUp> = {};
      for (const op of ops) {
        const pid = op.source_id;
        if (!grouped[pid]) {
          const portfolio = portfolioMap.get(pid);
          const partnerId = portfolio?.investor_id || portfolio?.agent_id;
          const profile = partnerId ? profileMap.get(partnerId) : null;
          grouped[pid] = {
            portfolio_id: pid,
            portfolio_code: portfolio?.portfolio_code || 'Unknown',
            account_name: portfolio?.account_name || null,
            partner_name: profile?.full_name || 'Unknown Partner',
            partner_phone: profile?.phone || '',
            current_capital: portfolio?.investment_amount || 0,
            ops: [],
            total: 0,
            submitted_at: op.reviewed_at || op.created_at,
          };
        }
        grouped[pid].ops.push({ id: op.id, amount: Number(op.amount), created_at: op.created_at });
        grouped[pid].total += Number(op.amount);
      }

      return Object.values(grouped);
    },
    refetchInterval: 60_000,
  });

  async function handleAction(portfolioId: string, action: 'approve' | 'reject', reason?: string) {
    setProcessing(portfolioId);
    try {
      const { data, error } = await supabase.functions.invoke('approve-portfolio-topup', {
        body: { portfolio_id: portfolioId, action, reason },
      });
      if (error) {
        // Non-2xx responses hide the real reason behind a generic
        // "Edge Function returned a non-2xx status code" message.
        // Read the response body so Financial Ops sees the actual cause
        // (e.g. the partner wallet no longer holds enough funds).
        let detail = '';
        const res = (error as any)?.context;
        if (res && typeof res.json === 'function') {
          try {
            const body = await res.clone().json();
            if (body?.error) detail = String(body.error);
          } catch {
            try { detail = (await res.clone().text())?.slice(0, 500) || ''; } catch { /* ignore */ }
          }
        }
        throw new Error(detail || error.message);
      }
      if (data?.error) throw new Error(data.error);

      if (action === 'approve') {
        toast.success(`Top-up approved — ${formatUGX(data.total_parked || data.total_applied || 0)} verified & parked`, {
          description: `Current capital: ${formatUGX(data.current_capital || data.new_investment_total || 0)}. Funds will merge at next ROI cycle.`,
        });
      } else {
        toast.success('Top-up rejected', {
          description: `${data.count} top-up(s) rejected. Funds returned to the partner's wallet.`,
        });
      }

      queryClient.invalidateQueries({ queryKey: ['awaiting-verification-topups'] });
    } catch (e: any) {
      toast.error(`Failed to ${action} top-up`, { description: e.message });
    } finally {
      setProcessing(null);
      setConfirmAction(null);
      setRejectReason('');
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (groups.length === 0) {
    return (
      <div className="text-center py-8 text-sm text-muted-foreground">
        <ShieldCheck className="h-8 w-8 mx-auto mb-2 text-green-500 opacity-60" />
        No portfolio top-ups awaiting verification
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Badge variant="outline" className="text-xs border-blue-500/40 text-blue-600 bg-blue-500/5 gap-1">
          <Clock className="h-3 w-3" />
          {groups.length} portfolio{groups.length > 1 ? 's' : ''} awaiting verification
        </Badge>
      </div>

      {groups.map(g => (
        <Card key={g.portfolio_id} className="border-blue-500/20 bg-blue-500/[0.02]">
          <CardContent className="p-4 space-y-3">
            {/* Header */}
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <Briefcase className="h-4 w-4 text-blue-600 shrink-0" />
                  <span className="font-bold text-sm">{g.account_name || g.portfolio_code}</span>
                  {g.account_name && (
                    <span className="text-[10px] text-muted-foreground">{g.portfolio_code}</span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">{g.partner_name} · {g.partner_phone}</p>
              </div>
              <div className="text-right shrink-0">
                <p className="text-lg font-black text-blue-600 tabular-nums">{formatUGX(g.total)}</p>
                <p className="text-[10px] text-muted-foreground">{g.ops.length} deposit{g.ops.length > 1 ? 's' : ''}</p>
              </div>
            </div>

            {/* Details */}
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div>
                <span className="text-muted-foreground">Current Capital:</span>
                <span className="ml-1 font-semibold tabular-nums">{formatUGX(g.current_capital)}</span>
              </div>
              <div>
                <span className="text-muted-foreground">After Approval:</span>
                <span className="ml-1 font-semibold tabular-nums text-green-600">{formatUGX(g.current_capital + g.total)}</span>
              </div>
            </div>

            {/* Individual ops */}
            {g.ops.length > 1 && (
              <div className="space-y-1">
                {g.ops.map((op, i) => (
                  <div key={op.id} className="flex items-center justify-between text-[11px] text-muted-foreground px-2 py-1 rounded bg-muted/30">
                    <span>Deposit #{i + 1}</span>
                    <span className="font-medium tabular-nums">{formatUGX(op.amount)}</span>
                    <span>{format(new Date(op.created_at), 'dd MMM HH:mm')}</span>
                  </div>
                ))}
              </div>
            )}

            <p className="text-[10px] text-muted-foreground">
              Submitted: {format(new Date(g.submitted_at), 'dd MMM yyyy HH:mm')}
            </p>

            {/* Actions */}
            <div className="flex gap-2">
              <Button
                size="sm"
                className="flex-1 gap-1.5 min-h-[44px]"
                onClick={() => setConfirmAction({ portfolio_id: g.portfolio_id, action: 'approve', group: g })}
                disabled={processing === g.portfolio_id}
              >
                {processing === g.portfolio_id ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                Approve & Apply
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5 min-h-[44px] text-destructive hover:text-destructive"
                onClick={() => setConfirmAction({ portfolio_id: g.portfolio_id, action: 'reject', group: g })}
                disabled={processing === g.portfolio_id}
              >
                <XCircle className="h-4 w-4" />
                Reject
              </Button>
            </div>
          </CardContent>
        </Card>
      ))}

      {/* Confirm dialog */}
      <AlertDialog open={!!confirmAction} onOpenChange={open => { if (!open) { setConfirmAction(null); setRejectReason(''); } }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmAction?.action === 'approve' ? 'Approve Portfolio Top-Up?' : 'Reject Portfolio Top-Up?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmAction?.action === 'approve'
                ? `This will add ${formatUGX(confirmAction.group.total)} to "${confirmAction.group.account_name || confirmAction.group.portfolio_code}" and create ledger entries. This action is irreversible.`
                : `This will reject ${confirmAction?.group.ops.length} deposit(s) totaling ${formatUGX(confirmAction?.group.total || 0)}. The funds stay in the partner's wallet and they will see your reason in their portfolio.`
              }
            </AlertDialogDescription>
          </AlertDialogHeader>
          {confirmAction?.action === 'reject' && (
            <div className="space-y-1.5">
              <Label htmlFor="reject-reason" className="text-xs font-medium">Reason for rejection (shown to the partner)</Label>
              <Textarea
                id="reject-reason"
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                placeholder="e.g. Amount does not match the deposit we received"
                className="min-h-[80px] text-sm"
                maxLength={500}
              />
              <p className="text-[10px] text-muted-foreground">Minimum 5 characters.</p>
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setRejectReason('')}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={confirmAction?.action === 'reject' && rejectReason.trim().length < 5}
              onClick={() => confirmAction && handleAction(confirmAction.portfolio_id, confirmAction.action, rejectReason.trim())}
              className={confirmAction?.action === 'reject' ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90' : ''}
            >
              {confirmAction?.action === 'approve' ? 'Approve & Apply Funds' : 'Reject Top-Up'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
