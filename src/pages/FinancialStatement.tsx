import { useState, useEffect, useCallback, useRef } from 'react';
import { useCurrency } from '@/hooks/useCurrency';
import { useNavigate } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { 
  ArrowLeft, ArrowUpRight, ArrowDownLeft, Download, Calendar, FileText, 
  X, Wallet, TrendingUp, TrendingDown, Loader2
} from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { roleToSlug } from '@/lib/roleRoutes';
import { supabase } from '@/integrations/supabase/client';
import { fetchOpsWallet } from '@/hooks/ops/useOpsDataLayer';
import { toast } from 'sonner';
import { format } from 'date-fns';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Calendar as CalendarComponent } from '@/components/ui/calendar';
import { exportToCSV } from '@/lib/exportUtils';
import { saveViewCache, loadViewCache } from '@/lib/offlineViewCache';
import { useOffline } from '@/contexts/OfflineContext';
import { WifiOff } from 'lucide-react';
import ScreenLoader from '@/components/common/ScreenLoader';

interface StatementEntry {
  id: string;
  date: string;
  type: 'credit' | 'debit';
  category: string;
  description: string;
  amount: number;
  runningBalance?: number;
  reference: string;
}

export default function FinancialStatement() {
  const navigate = useNavigate();
  const { user, loading: authLoading, role } = useAuth();
  const { isOnline } = useOffline();
  const [entries, setEntries] = useState<StatementEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [cachedAt, setCachedAt] = useState<number | null>(null);
  const [startDate, setStartDate] = useState<Date | undefined>(
    new Date(new Date().getFullYear(), new Date().getMonth(), 1) // First day of current month
  );
  const [endDate, setEndDate] = useState<Date | undefined>(new Date());
  const [walletBalance, setWalletBalance] = useState(0);
  const [userName, setUserName] = useState('');
  const [userPhone, setUserPhone] = useState('');
  const statementRef = useRef<HTMLDivElement>(null);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    if (!authLoading && !user) navigate('/auth');
  }, [user, authLoading, navigate]);

  const fetchAllTransactions = useCallback(async () => {
    if (!user) return;
    // If offline, hydrate purely from cache and bail out of network calls.
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      const cached = loadViewCache<{
        entries: StatementEntry[];
        walletBalance: number;
        userName: string;
        userPhone: string;
      }>('financial_statement', user.id);
      if (cached) {
        setEntries(cached.data.entries);
        setWalletBalance(cached.data.walletBalance);
        setUserName(cached.data.userName);
        setUserPhone(cached.data.userPhone);
        setCachedAt(cached.ts);
      }
      setLoading(false);
      return;
    }
    setLoading(true);

    try {
      const dateFrom = startDate ? startDate.toISOString() : '2020-01-01T00:00:00Z';
      const dateTo = endDate ? new Date(new Date(endDate).setHours(23, 59, 59, 999)).toISOString() : new Date().toISOString();

      // Fetch all data sources in parallel
      // wallet_withdrawals and repayments tables removed - stub them
      const [
        walletRes, profileRes, txRes, depositsRes, earningsRes
      ] = await Promise.all([
        // Authoritative wallet RPC — avoids the heavy `wallets` view.
        fetchOpsWallet(user.id).then((w) => ({ data: w, error: null })).catch((error) => ({ data: null, error })),
        supabase.from('profiles').select('full_name, phone').eq('id', user.id).maybeSingle(),
        supabase.from('wallet_transactions').select('*')
          .or(`sender_id.eq.${user.id},recipient_id.eq.${user.id}`)
          .gte('created_at', dateFrom).lte('created_at', dateTo)
          .order('created_at', { ascending: true }),
        supabase.from('wallet_deposits').select('*')
          .eq('user_id', user.id)
          .gte('created_at', dateFrom).lte('created_at', dateTo)
          .order('created_at', { ascending: true }),
        supabase.from('agent_earnings').select('*')
          .eq('agent_id', user.id)
          .gte('created_at', dateFrom).lte('created_at', dateTo)
          .order('created_at', { ascending: true }),
      ]);
      const withdrawalsRes = { data: [] as any[] };
      const repaymentsRes = { data: [] as any[] };

      setWalletBalance(walletRes.data ? (walletRes.data.withdrawable + walletRes.data.float + walletRes.data.advance) : 0);
      setUserName(profileRes.data?.full_name || '');
      setUserPhone(profileRes.data?.phone || '');

      const allEntries: StatementEntry[] = [];

      // Wallet transactions
      (txRes.data || []).forEach(tx => {
        const isSent = tx.sender_id === user.id;
        allEntries.push({
          id: tx.id,
          date: tx.created_at,
          type: isSent ? 'debit' : 'credit',
          category: isSent ? 'Transfer Out' : 'Transfer In',
          description: tx.description || (isSent ? 'Money sent' : 'Money received'),
          amount: tx.amount,
          reference: `WEL-${tx.id.substring(0, 8).toUpperCase()}`,
        });
      });

      // Deposits
      (depositsRes.data || []).forEach(dep => {
        allEntries.push({
          id: dep.id,
          date: dep.created_at,
          type: 'credit',
          category: 'Deposit',
          description: `Wallet deposit via ${dep.deposit_type || 'mobile money'}`,
          amount: dep.amount,
          reference: `DEP-${dep.id.substring(0, 8).toUpperCase()}`,
        });
      });

      // Withdrawals
      (withdrawalsRes.data || []).forEach(w => {
        allEntries.push({
          id: w.id,
          date: w.created_at,
          type: 'debit',
          category: 'Withdrawal',
          description: 'Wallet withdrawal',
          amount: w.amount,
          reference: `WDR-${w.id.substring(0, 8).toUpperCase()}`,
        });
      });

      // Repayments
      (repaymentsRes.data || []).forEach(r => {
        allEntries.push({
          id: r.id,
          date: r.created_at,
          type: 'debit',
          category: 'Rent Repayment',
          description: 'Rent repayment',
          amount: r.amount,
          reference: `RPY-${r.id.substring(0, 8).toUpperCase()}`,
        });
      });

      // Agent earnings
      (earningsRes.data || []).forEach(e => {
        allEntries.push({
          id: e.id,
          date: e.created_at,
          type: 'credit',
          category: 'Agent Earning',
          description: e.description || e.earning_type,
          amount: e.amount,
          reference: `ERN-${e.id.substring(0, 8).toUpperCase()}`,
        });
      });

      // Sort by date ascending and compute running balance
      allEntries.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

      // Calculate running balance - start from 0 (opening of period)
      let running = 0;
      const withBalance = allEntries.map(entry => {
        running += entry.type === 'credit' ? entry.amount : -entry.amount;
        return { ...entry, runningBalance: running };
      });

      setEntries(withBalance);
      saveViewCache('financial_statement', user.id, {
        entries: withBalance,
        walletBalance: walletRes.data?.balance || 0,
        userName: profileRes.data?.full_name || '',
        userPhone: profileRes.data?.phone || '',
      });
      setCachedAt(Date.now());
    } catch (err) {
      console.error('Error fetching statement:', err);
      // Fall back to cache on transient network error.
      const cached = loadViewCache<{
        entries: StatementEntry[];
        walletBalance: number;
        userName: string;
        userPhone: string;
      }>('financial_statement', user.id);
      if (cached) {
        setEntries(cached.data.entries);
        setWalletBalance(cached.data.walletBalance);
        setUserName(cached.data.userName);
        setUserPhone(cached.data.userPhone);
        setCachedAt(cached.ts);
        toast.message('Showing last saved statement (offline)');
      } else {
        toast.error('Failed to load financial statement');
      }
    } finally {
      setLoading(false);
    }
  }, [user, startDate, endDate]);

  useEffect(() => {
    if (user) fetchAllTransactions();
  }, [user, fetchAllTransactions]);

  const { formatAmount: formatCurrency } = useCurrency();

  const totalCredits = entries.filter(e => e.type === 'credit').reduce((s, e) => s + e.amount, 0);
  const totalDebits = entries.filter(e => e.type === 'debit').reduce((s, e) => s + e.amount, 0);

  const handleDownloadCSV = () => {
    if (entries.length === 0) { toast.error('No entries to export'); return; }
    exportToCSV({
      // Running balance is internal-only and is not exported to users.
      headers: ['Date', 'Category', 'Description', 'Reference', 'Credit (UGX)', 'Debit (UGX)'],
      rows: entries.map(e => [
        format(new Date(e.date), 'yyyy-MM-dd HH:mm'),
        e.category,
        e.description,
        e.reference,
        e.type === 'credit' ? e.amount : '',
        e.type === 'debit' ? e.amount : '',
      ]),
    }, `welile-statement-${userName.replace(/\s+/g, '_')}`);
    toast.success('Statement exported as CSV');
  };

  const handleDownloadPDF = async () => {
    if (!statementRef.current || entries.length === 0) {
      toast.error('No entries to export');
      return;
    }
    setDownloading(true);
    try {
      const { exportToPDF } = await import('@/lib/exportUtils');
      await exportToPDF(statementRef.current, `welile-statement-${userName.replace(/\s+/g, '_')}`, `Financial Statement — ${userName}`);
      toast.success('Statement downloaded as PDF');
    } catch (err) {
      console.error('PDF generation failed:', err);
      toast.error('Failed to generate PDF');
    } finally {
      setDownloading(false);
    }
  };

  if (authLoading || (loading && entries.length === 0)) {
    return (
      <ScreenLoader />
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto px-4 py-6 max-w-4xl">
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <Button variant="ghost" size="icon" onClick={() => navigate(roleToSlug(role))}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div className="flex-1">
            <h1 className="text-xl font-bold">Financial Statement</h1>
            <p className="text-muted-foreground text-sm">Complete transaction history</p>
          </div>
          <div className="flex gap-2">
            <Button onClick={handleDownloadCSV} variant="outline" size="sm" className="gap-1.5">
              <Download className="h-4 w-4" />
              <span className="hidden sm:inline">CSV</span>
            </Button>
            <Button onClick={handleDownloadPDF} size="sm" className="gap-1.5" disabled={downloading}>
              {downloading ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
              <span className="hidden sm:inline">PDF</span>
            </Button>
          </div>
        </div>

        {/* Offline / stale-data banner */}
        {(!isOnline || cachedAt) && !isOnline && (
          <div className="mb-3 flex items-center gap-2 px-3 py-2 rounded-xl bg-warning/10 border border-warning/20 text-xs text-warning">
            <WifiOff className="h-3.5 w-3.5 shrink-0" />
            <span className="flex-1">
              You're offline — showing last saved statement
              {cachedAt ? ` from ${format(new Date(cachedAt), 'MMM dd, HH:mm')}` : ''}
            </span>
          </div>
        )}

        {/* Date Range Filter */}
        <Card className="mb-4">
          <CardContent className="pt-4 pb-4">
            <div className="flex flex-wrap gap-3 items-center">
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" size="sm" className="gap-2">
                    <Calendar className="h-4 w-4" />
                    {startDate ? format(startDate, 'MMM dd, yyyy') : 'From'}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <CalendarComponent mode="single" selected={startDate} onSelect={setStartDate} initialFocus />
                </PopoverContent>
              </Popover>
              <span className="text-muted-foreground text-sm">to</span>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" size="sm" className="gap-2">
                    <Calendar className="h-4 w-4" />
                    {endDate ? format(endDate, 'MMM dd, yyyy') : 'To'}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <CalendarComponent mode="single" selected={endDate} onSelect={setEndDate} initialFocus />
                </PopoverContent>
              </Popover>
              {(startDate || endDate) && (
                <Button variant="ghost" size="sm" onClick={() => { setStartDate(undefined); setEndDate(undefined); }}>
                  <X className="h-4 w-4" />
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Printable Statement */}
        <div ref={statementRef}>
          {/* Account Summary */}
          <Card className="mb-4">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Wallet className="h-4 w-4" /> Account Summary
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-1 text-sm mb-4">
                <p><span className="text-muted-foreground">Name:</span> <span className="font-medium">{userName}</span></p>
                <p><span className="text-muted-foreground">Phone:</span> <span className="font-medium">{userPhone}</span></p>
                <p><span className="text-muted-foreground">Period:</span> <span className="font-medium">
                  {startDate ? format(startDate, 'MMM dd, yyyy') : 'All time'} — {endDate ? format(endDate, 'MMM dd, yyyy') : 'Present'}
                </span></p>
                <p><span className="text-muted-foreground">Current Balance:</span> <span className="font-bold text-primary">{formatCurrency(walletBalance)}</span></p>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div className="bg-green-500/10 rounded-lg p-3 text-center">
                  <TrendingUp className="h-4 w-4 text-green-600 mx-auto mb-1" />
                  <p className="text-xs text-muted-foreground">Total In</p>
                  <p className="font-bold text-green-600 text-sm">{formatCurrency(totalCredits)}</p>
                </div>
                <div className="bg-destructive/10 rounded-lg p-3 text-center">
                  <TrendingDown className="h-4 w-4 text-destructive mx-auto mb-1" />
                  <p className="text-xs text-muted-foreground">Total Out</p>
                  <p className="font-bold text-destructive text-sm">{formatCurrency(totalDebits)}</p>
                </div>
                <div className="bg-primary/10 rounded-lg p-3 text-center">
                  <Wallet className="h-4 w-4 text-primary mx-auto mb-1" />
                  <p className="text-xs text-muted-foreground">Net</p>
                  <p className="font-bold text-primary text-sm">{formatCurrency(totalCredits - totalDebits)}</p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Statement Table */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Transaction Details ({entries.length})</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {entries.length === 0 ? (
                <div className="text-center py-12 text-muted-foreground">
                  <FileText className="h-10 w-10 mx-auto mb-3 opacity-50" />
                  <p>No transactions found for this period</p>
                </div>
              ) : (
                <>
                  {/* Desktop Table */}
                  <div className="hidden md:block overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b bg-muted/50">
                          <th className="text-left py-2.5 px-4 font-medium text-muted-foreground">Date</th>
                          <th className="text-left py-2.5 px-4 font-medium text-muted-foreground">Category</th>
                          <th className="text-left py-2.5 px-4 font-medium text-muted-foreground">Description</th>
                          <th className="text-left py-2.5 px-4 font-medium text-muted-foreground">Reference</th>
                          <th className="text-right py-2.5 px-4 font-medium text-muted-foreground">Credit</th>
                          <th className="text-right py-2.5 px-4 font-medium text-muted-foreground">Debit</th>
                        </tr>
                      </thead>
                      <tbody>
                        {entries.map((entry) => (
                          <tr key={entry.id} className="border-b last:border-0 hover:bg-muted/30">
                            <td className="py-2.5 px-4 whitespace-nowrap">{format(new Date(entry.date), 'MMM dd, yyyy')}</td>
                            <td className="py-2.5 px-4">
                              <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                                entry.type === 'credit' ? 'bg-green-500/10 text-green-600' : 'bg-destructive/10 text-destructive'
                              }`}>
                                {entry.category}
                              </span>
                            </td>
                            <td className="py-2.5 px-4 max-w-[200px] truncate">{entry.description}</td>
                            <td className="py-2.5 px-4 font-mono text-xs text-muted-foreground">{entry.reference}</td>
                            <td className="py-2.5 px-4 text-right text-green-600 font-medium">
                              {entry.type === 'credit' ? formatCurrency(entry.amount) : ''}
                            </td>
                            <td className="py-2.5 px-4 text-right text-destructive font-medium">
                              {entry.type === 'debit' ? formatCurrency(entry.amount) : ''}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr className="bg-muted/50 font-semibold">
                          <td colSpan={4} className="py-2.5 px-4">Totals</td>
                          <td className="py-2.5 px-4 text-right text-green-600">{formatCurrency(totalCredits)}</td>
                          <td className="py-2.5 px-4 text-right text-destructive">{formatCurrency(totalDebits)}</td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>

                  {/* Mobile List */}
                  <div className="md:hidden divide-y">
                    {entries.map((entry) => (
                      <div key={entry.id} className="flex items-center gap-3 p-4">
                        <div className={`p-2 rounded-full shrink-0 ${
                          entry.type === 'credit' ? 'bg-green-500/20' : 'bg-destructive/20'
                        }`}>
                          {entry.type === 'credit' ? (
                            <ArrowDownLeft className="h-4 w-4 text-green-500" />
                          ) : (
                            <ArrowUpRight className="h-4 w-4 text-destructive" />
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-sm truncate">{entry.category}</p>
                          <p className="text-xs text-muted-foreground truncate">{entry.description}</p>
                          <p className="text-xs text-muted-foreground">{format(new Date(entry.date), 'MMM dd, yyyy')}</p>
                        </div>
                        <div className="text-right shrink-0">
                          <p className={`font-semibold text-sm ${entry.type === 'credit' ? 'text-green-600' : 'text-destructive'}`}>
                            {entry.type === 'credit' ? '+' : '-'}{formatCurrency(entry.amount)}
                          </p>
                        </div>
                      </div>
                    ))}
                    {/* Totals for mobile */}
                    <div className="p-4 bg-muted/50">
                      <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground">Total In:</span>
                        <span className="font-semibold text-green-600">{formatCurrency(totalCredits)}</span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground">Total Out:</span>
                        <span className="font-semibold text-destructive">{formatCurrency(totalDebits)}</span>
                      </div>
                      <div className="flex justify-between text-sm border-t mt-2 pt-2">
                        <span className="font-medium">Net:</span>
                        <span className="font-bold text-primary">{formatCurrency(totalCredits - totalDebits)}</span>
                      </div>
                    </div>
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          {/* Footer */}
          <p className="text-center text-xs text-muted-foreground mt-4">
            Generated on {format(new Date(), 'MMMM dd, yyyy HH:mm')} • Welile Financial Statement
          </p>
        </div>
      </div>
    </div>
  );
}
