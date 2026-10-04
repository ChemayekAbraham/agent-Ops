import { useState, useEffect } from 'react';
import { useCurrency } from '@/hooks/useCurrency';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Loader2, ArrowDown, ArrowRight, Wallet, Home, RefreshCw, ChevronDown, ChevronUp } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

interface DepositAuditEntry {
  deposit_id: string;
  tenant_name: string;
  tenant_id: string;
  deposit_amount: number;
  provider: string | null;
  transaction_id: string | null;
  approved_at: string | null;
  processor_name: string;
  // Repayment info
  repayment_amount: number;
  to_wallet: number;
  outstanding_before: number;
  outstanding_after: number;
  rent_request_id: string | null;
  rent_amount: number;
  total_repayment: number;
}

export function DepositRentAuditWidget() {
  const [entries, setEntries] = useState<DepositAuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState('today');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const { formatAmount: formatCurrency } = useCurrency();

  useEffect(() => {
    fetchAuditData();
  }, [period]);

  const getDateFilter = () => {
    const now = new Date();
    if (period === 'today') return now.toISOString().split('T')[0];
    if (period === '7days') {
      const d = new Date(now);
      d.setDate(d.getDate() - 7);
      return d.toISOString().split('T')[0];
    }
    if (period === '30days') {
      const d = new Date(now);
      d.setDate(d.getDate() - 30);
      return d.toISOString().split('T')[0];
    }
    return '2020-01-01';
  };

  const fetchAuditData = async () => {
    setLoading(true);
    try {
      const dateFrom = getDateFilter();

      // Fetch approved deposits
      const { data: deposits } = await supabase
        .from('deposit_requests')
        .select('id, user_id, amount, provider, transaction_id, approved_at, processed_by, notes')
        .eq('status', 'approved')
        .gte('approved_at', dateFrom)
        .order('approved_at', { ascending: false });

      if (!deposits || deposits.length === 0) {
        setEntries([]);
        setLoading(false);
        return;
      }

      // Gather unique user IDs
      const userIds = [...new Set([
        ...deposits.map(d => d.user_id),
        ...deposits.map(d => d.processed_by).filter(Boolean),
      ])];

      // Fetch profiles and rent requests in parallel
      const [profilesRes, rentRequestsRes, repaymentsRes] = await Promise.all([
        supabase.from('profiles').select('id, full_name').in('id', userIds),
        supabase.from('rent_requests')
          .select('id, tenant_id, rent_amount, total_repayment, amount_repaid, status')
          .in('tenant_id', deposits.map(d => d.user_id))
          .in('status', ['approved', 'funded', 'disbursed', 'completed']),
        supabase.from('repayments')
          .select('id, tenant_id, rent_request_id, amount, created_at')
          .in('tenant_id', deposits.map(d => d.user_id))
          .gte('created_at', dateFrom)
          .order('created_at', { ascending: false }),
      ]);

      const profileMap = new Map((profilesRes.data || []).map(p => [p.id, p.full_name]));
      const rentRequests = rentRequestsRes.data || [];
      const repayments = repaymentsRes.data || [];

      const auditEntries: DepositAuditEntry[] = deposits.map(dep => {
        const tenantRR = rentRequests.find(rr => rr.tenant_id === dep.user_id);
        
        // Find repayments that happened close to this deposit's approval
        const depositRepayments = repayments.filter(r => 
          r.tenant_id === dep.user_id && 
          dep.approved_at &&
          Math.abs(new Date(r.created_at).getTime() - new Date(dep.approved_at).getTime()) < 60000 // within 1 minute
        );
        
        const repaymentAmount = depositRepayments.reduce((sum, r) => sum + Number(r.amount), 0);
        const toWallet = dep.amount - repaymentAmount;
        
        const totalRepayment = tenantRR ? Number(tenantRR.total_repayment) : 0;
        const amountRepaid = tenantRR ? Number(tenantRR.amount_repaid) : 0;
        const outstandingAfter = totalRepayment - amountRepaid;
        const outstandingBefore = outstandingAfter + repaymentAmount;

        return {
          deposit_id: dep.id,
          tenant_name: profileMap.get(dep.user_id) || 'Unknown',
          tenant_id: dep.user_id,
          deposit_amount: dep.amount,
          provider: dep.provider,
          transaction_id: dep.transaction_id,
          approved_at: dep.approved_at,
          processor_name: profileMap.get(dep.processed_by || '') || 'System',
          repayment_amount: repaymentAmount,
          to_wallet: Math.max(0, toWallet),
          outstanding_before: outstandingBefore,
          outstanding_after: outstandingAfter,
          rent_request_id: tenantRR?.id || null,
          rent_amount: tenantRR ? Number(tenantRR.rent_amount) : 0,
          total_repayment: totalRepayment,
        };
      });

      setEntries(auditEntries);
    } catch (err) {
      console.error('Audit fetch error:', err);
    } finally {
      setLoading(false);
    }
  };

  const totalDeposited = entries.reduce((s, e) => s + e.deposit_amount, 0);
  const totalRepaid = entries.reduce((s, e) => s + e.repayment_amount, 0);
  const totalToWallet = entries.reduce((s, e) => s + e.to_wallet, 0);

  return (
    <Card className="border-border/50">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <ArrowDown className="h-4 w-4 text-green-500" />
            Deposit → Rent Audit Trail
          </CardTitle>
          <div className="flex items-center gap-2">
            <Select value={period} onValueChange={setPeriod}>
              <SelectTrigger className="h-8 w-[110px] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="today">Today</SelectItem>
                <SelectItem value="7days">Last 7 Days</SelectItem>
                <SelectItem value="30days">Last 30 Days</SelectItem>
                <SelectItem value="all">All Time</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={fetchAuditData}>
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Summary */}
        <div className="grid grid-cols-3 gap-2">
          <div className="rounded-lg bg-green-500/10 p-2.5 text-center">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Deposited</p>
            <p className="text-sm font-bold text-green-600">{formatCurrency(totalDeposited)}</p>
          </div>
          <div className="rounded-lg bg-blue-500/10 p-2.5 text-center">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider">→ Rent</p>
            <p className="text-sm font-bold text-blue-600">{formatCurrency(totalRepaid)}</p>
          </div>
          <div className="rounded-lg bg-amber-500/10 p-2.5 text-center">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider">→ Wallet</p>
            <p className="text-sm font-bold text-amber-600">{formatCurrency(totalToWallet)}</p>
          </div>
        </div>

        {loading ? (
          <div className="flex justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : entries.length === 0 ? (
          <p className="text-center text-sm text-muted-foreground py-4">No approved deposits in this period</p>
        ) : (
          <div className="space-y-2">
            {entries.map(entry => (
              <div
                key={entry.deposit_id}
                className="rounded-lg border border-border/50 overflow-hidden"
              >
                <button
                  onClick={() => setExpandedId(expandedId === entry.deposit_id ? null : entry.deposit_id)}
                  className="w-full text-left p-3 hover:bg-muted/30 transition-colors touch-manipulation"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-sm truncate">{entry.tenant_name}</p>
                      <div className="flex items-center gap-1.5 mt-0.5">
                        <Badge variant="outline" className="text-[10px] h-4 px-1.5">
                          {entry.provider?.toUpperCase() || 'N/A'}
                        </Badge>
                        {entry.transaction_id && (
                          <span className="text-[10px] font-mono text-muted-foreground truncate max-w-[100px]">
                            {entry.transaction_id}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-sm font-semibold text-green-600">
                        +{formatCurrency(entry.deposit_amount)}
                      </span>
                      {expandedId === entry.deposit_id ? (
                        <ChevronUp className="h-4 w-4 text-muted-foreground" />
                      ) : (
                        <ChevronDown className="h-4 w-4 text-muted-foreground" />
                      )}
                    </div>
                  </div>
                </button>

                {expandedId === entry.deposit_id && (
                  <div className="border-t border-border/30 bg-muted/20 p-3 space-y-3">
                    {/* Flow visualization */}
                    <div className="flex items-center gap-2 text-xs">
                      <div className="flex items-center gap-1 text-green-600">
                        <ArrowDown className="h-3 w-3" />
                        <span>Deposit</span>
                      </div>
                      <ArrowRight className="h-3 w-3 text-muted-foreground" />
                      {entry.repayment_amount > 0 && (
                        <>
                          <div className="flex items-center gap-1 text-blue-600">
                            <Home className="h-3 w-3" />
                            <span>Rent ({formatCurrency(entry.repayment_amount)})</span>
                          </div>
                          {entry.to_wallet > 0 && (
                            <>
                              <span className="text-muted-foreground">+</span>
                              <div className="flex items-center gap-1 text-amber-600">
                                <Wallet className="h-3 w-3" />
                                <span>Wallet ({formatCurrency(entry.to_wallet)})</span>
                              </div>
                            </>
                          )}
                        </>
                      )}
                      {entry.repayment_amount === 0 && (
                        <div className="flex items-center gap-1 text-amber-600">
                          <Wallet className="h-3 w-3" />
                          <span>Wallet Only ({formatCurrency(entry.to_wallet)})</span>
                        </div>
                      )}
                    </div>

                    {/* Outstanding balance change */}
                    {entry.rent_request_id ? (
                      <div className="rounded-md bg-background p-2.5 space-y-1.5">
                        <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
                          Outstanding Balance Change
                        </p>
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-sm text-destructive">
                            {formatCurrency(entry.outstanding_before)}
                          </span>
                          <ArrowRight className="h-3 w-3 text-muted-foreground" />
                          <span className="font-mono text-sm font-bold text-green-600">
                            {formatCurrency(entry.outstanding_after)}
                          </span>
                          {entry.repayment_amount > 0 && (
                            <Badge className="text-[10px] h-4 bg-green-500/20 text-green-700 border-green-500/30">
                              -{formatCurrency(entry.repayment_amount)}
                            </Badge>
                          )}
                        </div>
                        <p className="text-[10px] text-muted-foreground">
                          Rent: {formatCurrency(entry.rent_amount)} · Total Due: {formatCurrency(entry.total_repayment)}
                        </p>
                      </div>
                    ) : (
                      <div className="rounded-md bg-amber-500/5 border border-amber-500/20 p-2.5">
                        <p className="text-xs text-amber-700">
                          ⚠️ No active rent request — deposit went to wallet only
                        </p>
                      </div>
                    )}

                    {/* Meta */}
                    <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                      <span>Approved by: {entry.processor_name}</span>
                      <span>{entry.approved_at ? new Date(entry.approved_at).toLocaleString() : 'N/A'}</span>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
