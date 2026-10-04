import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Loader2, ArrowDownToLine, ArrowUpFromLine, Wallet, Printer, Download, RefreshCw, TrendingUp, TrendingDown, Users, Clock, CheckCircle, XCircle, Banknote, ChevronDown, ChevronUp, Eye } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { format, subDays, subMonths, startOfMonth, endOfMonth } from 'date-fns';
import { toast } from 'sonner';
import { UserAvatar } from '@/components/UserAvatar';

interface LedgerStats {
  totalCashIn: number;
  totalCashOut: number;
  netBalance: number;
  depositCount: number;
  withdrawalCount: number;
  approvedWithdrawals: number;
  rejectedWithdrawals: number;
  pendingWithdrawals: number;
  approvedDeposits: number;
  totalApprovedWithdrawalAmount: number;
  totalRejectedWithdrawalAmount: number;
  totalPendingWithdrawalAmount: number;
  totalApprovedDepositAmount: number;
}

interface WithdrawalDetail {
  id: string;
  user_id: string;
  amount: number;
  status: string;
  mobile_money_number: string | null;
  mobile_money_provider: string | null;
  mobile_money_name: string | null;
  created_at: string;
  processed_at: string | null;
  transaction_id: string | null;
  rejection_reason: string | null;
  user_name: string;
  user_phone: string;
}

const formatUGX = (value: number) => {
  return new Intl.NumberFormat('en-UG', {
    style: 'currency',
    currency: 'UGX',
    minimumFractionDigits: 0,
  }).format(value);
};

export function ManagerLedgerSummary() {
  const [stats, setStats] = useState<LedgerStats | null>(null);
  const [withdrawals, setWithdrawals] = useState<WithdrawalDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [printing, setPrinting] = useState(false);
  const [period, setPeriod] = useState<'7d' | '30d' | 'month' | 'all'>('30d');
  const [statusFilter, setStatusFilter] = useState<'all' | 'approved' | 'rejected' | 'pending'>('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [fundSources, setFundSources] = useState<Record<string, any[]>>({});

  const getDateRange = useCallback(() => {
    const now = new Date();
    switch (period) {
      case '7d': return { from: subDays(now, 7), to: now };
      case '30d': return { from: subDays(now, 30), to: now };
      case 'month': return { from: startOfMonth(now), to: endOfMonth(now) };
      case 'all': return { from: null, to: null };
    }
  }, [period]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      // Server-side aggregation — single RPC call instead of fetching all rows
      const { data: rpcStats, error: rpcErr } = await supabase.rpc('get_wallet_ops_stats', { p_period: period });
      if (rpcErr) throw rpcErr;

      if (rpcStats) {
        setStats(rpcStats as unknown as LedgerStats);
      }

      // Fetch only paginated withdrawal list for display (not all rows)
      let wQuery = supabase
        .from('withdrawal_requests')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(50);

      const range = getDateRange();
      if (range.from) wQuery = wQuery.gte('created_at', range.from.toISOString());
      if (range.to) wQuery = wQuery.lte('created_at', range.to.toISOString());

      const { data: wData, error: wErr } = await wQuery;
      if (wErr) throw wErr;

      const withdrawalData = wData || [];

      // Enrich withdrawals with user profiles (bounded set)
      if (withdrawalData.length > 0) {
        const userIds = [...new Set(withdrawalData.map(w => w.user_id))];
        // Batch profile lookups in chunks of 50 to avoid URL length limits
        const profiles: any[] = [];
        for (let i = 0; i < userIds.length; i += 50) {
          const chunk = userIds.slice(i, i + 50);
          const { data } = await supabase
            .from('profiles')
            .select('id, full_name, phone')
            .in('id', chunk);
          if (data) profiles.push(...data);
        }

        const profileMap = new Map(profiles.map(p => [p.id, p]));

        const enriched: WithdrawalDetail[] = withdrawalData.map(w => ({
          id: w.id,
          user_id: w.user_id,
          amount: w.amount,
          status: w.status,
          mobile_money_number: w.mobile_money_number,
          mobile_money_provider: w.mobile_money_provider,
          mobile_money_name: w.mobile_money_name,
          created_at: w.created_at,
          processed_at: w.processed_at,
          transaction_id: w.transaction_id,
          rejection_reason: w.rejection_reason,
          user_name: profileMap.get(w.user_id)?.full_name || 'Unknown',
          user_phone: profileMap.get(w.user_id)?.phone || '',
        }));

        setWithdrawals(enriched);
      } else {
        setWithdrawals([]);
      }
    } catch (err) {
      console.error('Ledger fetch error:', err);
      toast.error('Failed to load ledger data');
    } finally {
      setLoading(false);
    }
  }, [getDateRange, period]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const filteredWithdrawals = statusFilter === 'all'
    ? withdrawals
    : withdrawals.filter(w => w.status === statusFilter);

  const handlePrintReport = async () => {
    if (!stats) return;
    setPrinting(true);
    try {
      const { jsPDF } = await import('jspdf');
      const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
      const pageWidth = pdf.internal.pageSize.getWidth();
      const margin = 12;
      let y = 15;

      // Header
      pdf.setFontSize(18);
      pdf.setFont('helvetica', 'bold');
      pdf.text('Welile Financial Summary', margin, y);
      y += 7;
      pdf.setFontSize(9);
      pdf.setFont('helvetica', 'normal');
      pdf.setTextColor(100);
      const periodLabel = period === '7d' ? 'Last 7 Days' : period === '30d' ? 'Last 30 Days' : period === 'month' ? 'This Month' : 'All Time';
      pdf.text(`Period: ${periodLabel}  •  Generated: ${format(new Date(), 'MMM dd, yyyy HH:mm')}`, margin, y);
      y += 10;

      // Summary Box
      pdf.setTextColor(0);
      pdf.setFillColor(245, 245, 245);
      pdf.roundedRect(margin, y, pageWidth - margin * 2, 32, 3, 3, 'F');
      y += 8;

      pdf.setFontSize(10);
      pdf.setFont('helvetica', 'bold');
      pdf.text('MONEY SUMMARY', margin + 5, y);
      y += 8;

      pdf.setFontSize(11);
      // Cash In
      pdf.setTextColor(34, 139, 34);
      pdf.text(`💰 Money Coming In (Deposits):  ${formatUGX(stats.totalCashIn)}`, margin + 5, y);
      y += 7;
      // Cash Out
      pdf.setTextColor(220, 53, 69);
      pdf.text(`💸 Money Going Out (Withdrawals):  ${formatUGX(stats.totalCashOut)}`, margin + 5, y);
      y += 7;
      // Net
      pdf.setTextColor(0);
      const netLabel = stats.netBalance >= 0 ? '✅ Net Remaining' : '⚠️ Net Deficit';
      pdf.text(`${netLabel}:  ${formatUGX(Math.abs(stats.netBalance))}`, margin + 5, y);
      y += 12;

      // Withdrawal Breakdown
      pdf.setFontSize(12);
      pdf.setFont('helvetica', 'bold');
      pdf.setTextColor(0);
      pdf.text('Withdrawal Requests Breakdown', margin, y);
      y += 7;

      pdf.setFontSize(10);
      pdf.setFont('helvetica', 'normal');
      pdf.text(`✅ Approved: ${stats.approvedWithdrawals} requests — ${formatUGX(stats.totalApprovedWithdrawalAmount)}`, margin + 3, y);
      y += 6;
      pdf.text(`❌ Rejected: ${stats.rejectedWithdrawals} requests — ${formatUGX(stats.totalRejectedWithdrawalAmount)}`, margin + 3, y);
      y += 6;
      pdf.text(`⏳ Pending: ${stats.pendingWithdrawals} requests — ${formatUGX(stats.totalPendingWithdrawalAmount)}`, margin + 3, y);
      y += 10;

      // Withdrawal Details Table
      pdf.setFontSize(12);
      pdf.setFont('helvetica', 'bold');
      pdf.text(`Withdrawal Details (${filteredWithdrawals.length} records)`, margin, y);
      y += 7;

      // Table header
      pdf.setFontSize(7);
      pdf.setFont('helvetica', 'bold');
      pdf.setFillColor(230, 230, 230);
      pdf.rect(margin, y - 3, pageWidth - margin * 2, 6, 'F');
      const cols = [margin + 2, margin + 32, margin + 62, margin + 95, margin + 125, margin + 155];
      pdf.text('Name', cols[0], y);
      pdf.text('Phone / MoMo', cols[1], y);
      pdf.text('Amount', cols[2], y);
      pdf.text('Status', cols[3], y);
      pdf.text('Txn ID', cols[4], y);
      pdf.text('Date', cols[5], y);
      y += 6;

      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(7);
      for (const w of filteredWithdrawals) {
        if (y > 275) {
          pdf.addPage();
          y = 15;
        }
        pdf.text(w.user_name.substring(0, 18), cols[0], y);
        pdf.text(`${(w.mobile_money_provider || '').toUpperCase()} ${w.mobile_money_number || w.user_phone}`, cols[1], y);
        pdf.text(formatUGX(w.amount), cols[2], y);

        const statusText = w.status === 'approved' ? '✅ Paid' : w.status === 'rejected' ? '❌ No' : '⏳ Wait';
        pdf.text(statusText, cols[3], y);
        pdf.text((w.transaction_id || '-').substring(0, 15), cols[4], y);
        pdf.text(format(new Date(w.created_at), 'MMM dd HH:mm'), cols[5], y);
        y += 5;
      }

      // Total footer
      y += 3;
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(10);
      const totalAmount = filteredWithdrawals.reduce((s, w) => s + w.amount, 0);
      pdf.text(`Total: ${formatUGX(totalAmount)} across ${filteredWithdrawals.length} requests`, margin, y);

      pdf.save(`welile-ledger-${format(new Date(), 'yyyy-MM-dd')}.pdf`);
      toast.success('Report downloaded!');
    } catch (err) {
      console.error('PDF error:', err);
      toast.error('Failed to generate report');
    } finally {
      setPrinting(false);
    }
  };

  if (loading) {
    return (
      <div className="p-8 text-center">
        <Loader2 className="h-8 w-8 animate-spin mx-auto text-muted-foreground" />
        <p className="text-sm text-muted-foreground mt-2">Loading ledger...</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Period Selector & Actions */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex gap-1">
          {[
            { value: '7d', label: '7 Days' },
            { value: '30d', label: '30 Days' },
            { value: 'month', label: 'This Month' },
            { value: 'all', label: 'All Time' },
          ].map(p => (
            <Button
              key={p.value}
              variant={period === p.value ? 'default' : 'outline'}
              size="sm"
              className="h-8 text-xs px-2.5"
              onClick={() => setPeriod(p.value as typeof period)}
            >
              {p.label}
            </Button>
          ))}
        </div>
        <div className="flex gap-1">
          <Button variant="ghost" size="icon" onClick={fetchData} disabled={loading} title="Refresh">
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </Button>
          <Button variant="ghost" size="icon" onClick={handlePrintReport} disabled={printing} title="Print Report">
            {printing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Printer className="h-4 w-4" />}
          </Button>
        </div>
      </div>

      {stats && (
        <>
          {/* Simple Money Summary — "For an Ordinary Mind" */}
          <Card className="border-2 border-primary/20 overflow-hidden">
            <div className="bg-gradient-to-r from-primary/10 to-primary/5 p-4">
              <h3 className="font-bold text-base flex items-center gap-2">
                <Banknote className="h-5 w-5 text-primary" />
                Money Summary
              </h3>
              <p className="text-xs text-muted-foreground mt-0.5">Simple overview of money flow</p>
            </div>
            <CardContent className="p-4 space-y-3">
              {/* Cash In */}
              <div className="flex items-center justify-between p-3 rounded-xl bg-success/10 border border-success/20">
                <div className="flex items-center gap-3">
                  <div className="p-2.5 rounded-full bg-success/20">
                    <ArrowDownToLine className="h-5 w-5 text-success" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-success">Money In</p>
                    <p className="text-[10px] text-muted-foreground">{stats.approvedDeposits} approved deposits</p>
                  </div>
                </div>
                <p className="text-xl font-black text-success">{formatUGX(stats.totalCashIn)}</p>
              </div>

              {/* Cash Out */}
              <div className="flex items-center justify-between p-3 rounded-xl bg-destructive/10 border border-destructive/20">
                <div className="flex items-center gap-3">
                  <div className="p-2.5 rounded-full bg-destructive/20">
                    <ArrowUpFromLine className="h-5 w-5 text-destructive" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-destructive">Money Out</p>
                    <p className="text-[10px] text-muted-foreground">{stats.approvedWithdrawals} approved withdrawals</p>
                  </div>
                </div>
                <p className="text-xl font-black text-destructive">{formatUGX(stats.totalCashOut)}</p>
              </div>

              {/* Net Balance */}
              <div className={`flex items-center justify-between p-3 rounded-xl border-2 ${
                stats.netBalance >= 0 
                  ? 'bg-success/5 border-success/30' 
                  : 'bg-warning/5 border-warning/30'
              }`}>
                <div className="flex items-center gap-3">
                  <div className={`p-2.5 rounded-full ${stats.netBalance >= 0 ? 'bg-success/20' : 'bg-warning/20'}`}>
                    <Wallet className={`h-5 w-5 ${stats.netBalance >= 0 ? 'text-success' : 'text-warning'}`} />
                  </div>
                  <div>
                    <p className="text-sm font-bold">
                      {stats.netBalance >= 0 ? '✅ Net Remaining' : '⚠️ Net Deficit'}
                    </p>
                    <p className="text-[10px] text-muted-foreground">Money In minus Money Out</p>
                  </div>
                </div>
                <p className={`text-xl font-black ${stats.netBalance >= 0 ? 'text-success' : 'text-warning'}`}>
                  {formatUGX(Math.abs(stats.netBalance))}
                </p>
              </div>
            </CardContent>
          </Card>

          {/* Withdrawal Status Cards — Clickable for drill-down */}
          <div className="grid grid-cols-3 gap-2">
            <Card 
              className="border-success/20 bg-success/5 cursor-pointer hover:ring-2 hover:ring-success/40 transition-all active:scale-95"
              onClick={() => setStatusFilter('approved')}
            >
              <CardContent className="p-3 text-center">
                <CheckCircle className="h-5 w-5 text-success mx-auto mb-1" />
                <p className="text-lg font-bold text-success">{stats.approvedWithdrawals}</p>
                <p className="text-[10px] text-muted-foreground">Paid Out</p>
                <p className="text-xs font-semibold mt-0.5">{formatUGX(stats.totalApprovedWithdrawalAmount)}</p>
              </CardContent>
            </Card>
            <Card 
              className="border-destructive/20 bg-destructive/5 cursor-pointer hover:ring-2 hover:ring-destructive/40 transition-all active:scale-95"
              onClick={() => setStatusFilter('rejected')}
            >
              <CardContent className="p-3 text-center">
                <XCircle className="h-5 w-5 text-destructive mx-auto mb-1" />
                <p className="text-lg font-bold text-destructive">{stats.rejectedWithdrawals}</p>
                <p className="text-[10px] text-muted-foreground">Rejected</p>
                <p className="text-xs font-semibold mt-0.5">{formatUGX(stats.totalRejectedWithdrawalAmount)}</p>
              </CardContent>
            </Card>
            <Card 
              className="border-warning/20 bg-warning/5 cursor-pointer hover:ring-2 hover:ring-warning/40 transition-all active:scale-95"
              onClick={() => setStatusFilter('pending')}
            >
              <CardContent className="p-3 text-center">
                <Clock className="h-5 w-5 text-warning mx-auto mb-1" />
                <p className="text-lg font-bold text-warning">{stats.pendingWithdrawals}</p>
                <p className="text-[10px] text-muted-foreground">Waiting</p>
                <p className="text-xs font-semibold mt-0.5">{formatUGX(stats.totalPendingWithdrawalAmount)}</p>
              </CardContent>
            </Card>
          </div>
        </>
      )}

      {/* Withdrawal Details List */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm flex items-center gap-2">
              <Users className="h-4 w-4" />
              Who Requested Withdrawals
            </CardTitle>
            <Select value={statusFilter} onValueChange={v => setStatusFilter(v as typeof statusFilter)}>
              <SelectTrigger className="w-[120px] h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All ({withdrawals.length})</SelectItem>
                <SelectItem value="approved">✅ Paid</SelectItem>
                <SelectItem value="rejected">❌ Rejected</SelectItem>
                <SelectItem value="pending">⏳ Pending</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {filteredWithdrawals.length === 0 ? (
            <div className="p-6 text-center text-muted-foreground">
              <p className="text-sm">No withdrawal requests found</p>
            </div>
          ) : (
            <div className="divide-y divide-border max-h-[500px] overflow-y-auto">
              {filteredWithdrawals.map(w => (
                <div key={w.id} className="hover:bg-muted/30 transition-colors">
                  <div 
                    className="p-3 cursor-pointer"
                    onClick={() => {
                      const newId = expandedId === w.id ? null : w.id;
                      setExpandedId(newId);
                      if (newId && !fundSources[w.id]) {
                        // Load fund sources (ledger credits) for this user
                        supabase
                          .from('general_ledger')
                          .select('amount, category, description, transaction_date')
                          .eq('user_id', w.user_id)
                          .eq('direction', 'cash_in')
                          .order('transaction_date', { ascending: false })
                          .limit(10)
                          .then(({ data }) => {
                            setFundSources(prev => ({ ...prev, [w.id]: data || [] }));
                          });
                      }
                    }}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="font-semibold text-sm truncate">{w.user_name}</p>
                          <Badge
                            variant={w.status === 'approved' ? 'default' : w.status === 'rejected' ? 'destructive' : 'secondary'}
                            className="text-[10px] h-5 px-1.5"
                          >
                            {w.status === 'approved' ? '✅ Paid' : w.status === 'rejected' ? '❌ No' : '⏳ Wait'}
                          </Badge>
                        </div>
                        <div className="flex items-center gap-3 text-[11px] text-muted-foreground mt-0.5 flex-wrap">
                          <span>{(w.mobile_money_provider || '').toUpperCase()} {w.mobile_money_number || w.user_phone}</span>
                          {w.mobile_money_name && <span>• {w.mobile_money_name}</span>}
                          <span>• {format(new Date(w.created_at), 'MMM d, h:mm a')}</span>
                        </div>
                        {w.transaction_id && (
                          <p className="text-[10px] text-muted-foreground mt-0.5">
                            Txn: <span className="font-mono">{w.transaction_id}</span>
                          </p>
                        )}
                        {w.rejection_reason && (
                          <p className="text-[10px] text-destructive mt-0.5">
                            Reason: {w.rejection_reason}
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <p className={`text-base font-bold whitespace-nowrap ${
                          w.status === 'approved' ? 'text-success' : w.status === 'rejected' ? 'text-destructive' : 'text-foreground'
                        }`}>
                          {formatUGX(w.amount)}
                        </p>
                        {expandedId === w.id ? (
                          <ChevronUp className="h-4 w-4 text-muted-foreground" />
                        ) : (
                          <ChevronDown className="h-4 w-4 text-muted-foreground" />
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Expanded Detail Panel */}
                  {expandedId === w.id && (
                    <div className="px-3 pb-3 space-y-2 bg-muted/20 border-t border-dashed">
                      <div className="grid grid-cols-2 gap-2 text-xs pt-2">
                        <div>
                          <p className="text-muted-foreground">Phone</p>
                          <p className="font-medium">{w.user_phone || 'N/A'}</p>
                        </div>
                        <div>
                          <p className="text-muted-foreground">MoMo Name</p>
                          <p className="font-medium">{w.mobile_money_name || 'N/A'}</p>
                        </div>
                        <div>
                          <p className="text-muted-foreground">Provider</p>
                          <p className="font-medium">{(w.mobile_money_provider || 'N/A').toUpperCase()}</p>
                        </div>
                        <div>
                          <p className="text-muted-foreground">MoMo Number</p>
                          <p className="font-medium">{w.mobile_money_number || 'N/A'}</p>
                        </div>
                        <div>
                          <p className="text-muted-foreground">Requested</p>
                          <p className="font-medium">{format(new Date(w.created_at), 'MMM d, yyyy h:mm a')}</p>
                        </div>
                        <div>
                          <p className="text-muted-foreground">Processed</p>
                          <p className="font-medium">{w.processed_at ? format(new Date(w.processed_at), 'MMM d, yyyy h:mm a') : 'Not yet'}</p>
                        </div>
                        {w.transaction_id && (
                          <div className="col-span-2">
                            <p className="text-muted-foreground">Transaction ID</p>
                            <p className="font-mono font-medium text-sm">{w.transaction_id}</p>
                          </div>
                        )}
                        {w.rejection_reason && (
                          <div className="col-span-2">
                            <p className="text-muted-foreground">Rejection Reason</p>
                            <p className="font-medium text-destructive">{w.rejection_reason}</p>
                          </div>
                        )}
                      </div>

                      {/* Source of Funds */}
                      <div className="pt-2 border-t">
                        <p className="text-xs font-semibold text-muted-foreground mb-1 flex items-center gap-1">
                          <Eye className="h-3 w-3" /> Source of Funds (Recent Credits)
                        </p>
                        {!fundSources[w.id] ? (
                          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                        ) : fundSources[w.id].length === 0 ? (
                          <p className="text-[10px] text-muted-foreground">No ledger credits found</p>
                        ) : (
                          <div className="space-y-1">
                            {fundSources[w.id].map((src, i) => (
                              <div key={i} className="flex items-center justify-between text-[11px] bg-background rounded-lg px-2 py-1.5">
                                <div>
                                  <p className="font-medium capitalize">{(src.category || '').replace(/_/g, ' ')}</p>
                                  {src.description && <p className="text-muted-foreground text-[10px]">{src.description}</p>}
                                </div>
                                <div className="text-right">
                                  <p className="font-semibold text-success">{formatUGX(src.amount)}</p>
                                  <p className="text-muted-foreground text-[9px]">{format(new Date(src.transaction_date), 'MMM d')}</p>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Total Footer */}
          {filteredWithdrawals.length > 0 && (
            <div className="p-3 border-t bg-muted/30 flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground">
                {filteredWithdrawals.length} request{filteredWithdrawals.length !== 1 ? 's' : ''}
              </span>
              <span className="text-sm font-bold">
                Total: {formatUGX(filteredWithdrawals.reduce((s, w) => s + w.amount, 0))}
              </span>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
