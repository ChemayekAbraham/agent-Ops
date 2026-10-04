import { useState, useEffect, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ScrollArea } from '@/components/ui/scroll-area';
import { 
  Wallet, 
  CheckCircle, 
  XCircle,
  Clock,
  User,
  Calendar,
  Download,
  FileText,
  Loader2
} from 'lucide-react';
import { format, subDays, startOfDay } from 'date-fns';
import { formatUGX } from '@/lib/rentCalculations';
import { exportToCSV, exportToPDF, formatDateForExport } from '@/lib/exportUtils';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';
import { toast } from 'sonner';

interface DepositStats {
  totalApproved: number;
  totalRejected: number;
  totalPending: number;
  approvedCount: number;
  rejectedCount: number;
  pendingCount: number;
}

interface DailyData {
  date: string;
  approved: number;
  rejected: number;
}

interface ProcessedDeposit {
  id: string;
  amount: number;
  status: string;
  created_at: string;
  approved_at: string | null;
  rejected_at: string | null;
  user_name: string;
  processed_by_name: string | null;
}

const COLORS = ['#22c55e', '#ef4444', '#f59e0b'];

export function DepositAnalytics() {
  const [stats, setStats] = useState<DepositStats | null>(null);
  const [dailyData, setDailyData] = useState<DailyData[]>([]);
  const [recentDeposits, setRecentDeposits] = useState<ProcessedDeposit[]>([]);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState<'7d' | '30d' | 'all'>('7d');
  const [exporting, setExporting] = useState<'csv' | 'pdf' | null>(null);
  const reportRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchAnalytics();
  }, [period]);

  const fetchAnalytics = async () => {
    setLoading(true);
    try {
      let query = supabase.from('deposit_requests').select('*');

      if (period !== 'all') {
        const days = period === '7d' ? 7 : 30;
        const startDate = startOfDay(subDays(new Date(), days)).toISOString();
        query = query.gte('created_at', startDate);
      }

      const { data: deposits, error } = await query.order('created_at', { ascending: false });

      if (error) throw error;

      if (deposits && deposits.length > 0) {
        // Calculate stats
        const approved = deposits.filter(d => d.status === 'approved');
        const rejected = deposits.filter(d => d.status === 'rejected');
        const pending = deposits.filter(d => d.status === 'pending');

        setStats({
          totalApproved: approved.reduce((sum, d) => sum + Number(d.amount), 0),
          totalRejected: rejected.reduce((sum, d) => sum + Number(d.amount), 0),
          totalPending: pending.reduce((sum, d) => sum + Number(d.amount), 0),
          approvedCount: approved.length,
          rejectedCount: rejected.length,
          pendingCount: pending.length,
        });

        // Calculate daily data for chart
        const days = period === '7d' ? 7 : period === '30d' ? 30 : 90;
        const dailyMap = new Map<string, { approved: number; rejected: number }>();

        for (let i = 0; i < days; i++) {
          const date = format(subDays(new Date(), i), 'MMM d');
          dailyMap.set(date, { approved: 0, rejected: 0 });
        }

        deposits.forEach(d => {
          const date = format(new Date(d.created_at), 'MMM d');
          if (dailyMap.has(date)) {
            const current = dailyMap.get(date)!;
            if (d.status === 'approved') {
              current.approved += Number(d.amount);
            } else if (d.status === 'rejected') {
              current.rejected += Number(d.amount);
            }
          }
        });

        const chartData = Array.from(dailyMap.entries())
          .map(([date, values]) => ({ date, ...values }))
          .reverse();

        setDailyData(chartData);

        // Get recent processed deposits with user names
        const processedDeposits = deposits
          .filter(d => d.status !== 'pending')
          .slice(0, 20);

        if (processedDeposits.length > 0) {
          const userIds = [...new Set([
            ...processedDeposits.map(d => d.user_id),
            ...processedDeposits.filter(d => d.processed_by).map(d => d.processed_by)
          ])];

          const { data: profiles } = await supabase
            .from('profiles')
            .select('id, full_name')
            .in('id', userIds);

          const profileMap = new Map(profiles?.map(p => [p.id, p.full_name]) || []);

          const enriched: ProcessedDeposit[] = processedDeposits.map(d => ({
            id: d.id,
            amount: d.amount,
            status: d.status,
            created_at: d.created_at,
            approved_at: d.approved_at,
            rejected_at: d.rejected_at,
            user_name: profileMap.get(d.user_id) || 'Unknown',
            processed_by_name: d.processed_by ? profileMap.get(d.processed_by) || 'Unknown' : null,
          }));

          setRecentDeposits(enriched);
        } else {
          setRecentDeposits([]);
        }
      } else {
        setStats({
          totalApproved: 0,
          totalRejected: 0,
          totalPending: 0,
          approvedCount: 0,
          rejectedCount: 0,
          pendingCount: 0,
        });
        setDailyData([]);
        setRecentDeposits([]);
      }
    } catch (error) {
      console.error('Error fetching analytics:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleExportCSV = () => {
    setExporting('csv');
    try {
      const headers = ['User', 'Amount (UGX)', 'Status', 'Created Date', 'Processed Date', 'Processed By'];
      const rows = recentDeposits.map(d => [
        d.user_name,
        d.amount,
        d.status,
        formatDateForExport(d.created_at),
        d.approved_at || d.rejected_at ? formatDateForExport(d.approved_at || d.rejected_at!) : 'N/A',
        d.processed_by_name || 'N/A'
      ]);

      // Add summary row
      rows.unshift(['--- SUMMARY ---', '', '', '', '', '']);
      rows.unshift(['Pending Count', stats?.pendingCount || 0, 'Pending Total', stats?.totalPending || 0, '', '']);
      rows.unshift(['Rejected Count', stats?.rejectedCount || 0, 'Rejected Total', stats?.totalRejected || 0, '', '']);
      rows.unshift(['Approved Count', stats?.approvedCount || 0, 'Approved Total', stats?.totalApproved || 0, '', '']);
      rows.unshift(['Period', period === '7d' ? 'Last 7 days' : period === '30d' ? 'Last 30 days' : 'All time', '', '', '', '']);

      exportToCSV({ headers, rows }, 'deposit_analytics');
      toast.success('CSV exported successfully');
    } catch (error) {
      toast.error('Failed to export CSV');
    } finally {
      setExporting(null);
    }
  };

  const handleExportPDF = async () => {
    if (!reportRef.current) return;
    setExporting('pdf');
    try {
      await exportToPDF(reportRef.current, 'deposit_analytics', 'Deposit Analytics Report');
      toast.success('PDF exported successfully');
    } catch (error) {
      toast.error('Failed to export PDF');
    } finally {
      setExporting(null);
    }
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-3 gap-3">
          {[1, 2, 3].map(i => <Skeleton key={i} className="h-24" />)}
        </div>
        <Skeleton className="h-64" />
      </div>
    );
  }

  const pieData = [
    { name: 'Approved', value: stats?.approvedCount || 0 },
    { name: 'Rejected', value: stats?.rejectedCount || 0 },
    { name: 'Pending', value: stats?.pendingCount || 0 },
  ].filter(d => d.value > 0);

  return (
    <div className="space-y-4">
      {/* Header with Period Selector and Export Buttons */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-2">
          {(['7d', '30d', 'all'] as const).map(p => (
            <Badge
              key={p}
              variant={period === p ? 'default' : 'outline'}
              className="cursor-pointer"
              onClick={() => setPeriod(p)}
            >
              {p === '7d' ? 'Last 7 days' : p === '30d' ? 'Last 30 days' : 'All time'}
            </Badge>
          ))}
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={handleExportCSV}
            disabled={exporting !== null}
          >
            {exporting === 'csv' ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <>
                <Download className="h-4 w-4 mr-1" />
                CSV
              </>
            )}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={handleExportPDF}
            disabled={exporting !== null}
          >
            {exporting === 'pdf' ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <>
                <FileText className="h-4 w-4 mr-1" />
                PDF
              </>
            )}
          </Button>
        </div>
      </div>

      {/* Report Content (ref for PDF export) */}
      <div ref={reportRef} className="space-y-4 bg-background p-1">

      {/* Stats Cards */}
      <div className="grid grid-cols-3 gap-3">
        <Card className="border-success/30 bg-success/5">
          <CardContent className="p-3">
            <div className="flex items-center gap-2 mb-1">
              <CheckCircle className="h-4 w-4 text-success" />
              <span className="text-xs font-medium text-success">Approved</span>
            </div>
            <p className="text-lg font-bold">{formatUGX(stats?.totalApproved || 0)}</p>
            <p className="text-xs text-muted-foreground">{stats?.approvedCount || 0} requests</p>
          </CardContent>
        </Card>

        <Card className="border-destructive/30 bg-destructive/5">
          <CardContent className="p-3">
            <div className="flex items-center gap-2 mb-1">
              <XCircle className="h-4 w-4 text-destructive" />
              <span className="text-xs font-medium text-destructive">Rejected</span>
            </div>
            <p className="text-lg font-bold">{formatUGX(stats?.totalRejected || 0)}</p>
            <p className="text-xs text-muted-foreground">{stats?.rejectedCount || 0} requests</p>
          </CardContent>
        </Card>

        <Card className="border-warning/30 bg-warning/5">
          <CardContent className="p-3">
            <div className="flex items-center gap-2 mb-1">
              <Clock className="h-4 w-4 text-warning" />
              <span className="text-xs font-medium text-warning">Pending</span>
            </div>
            <p className="text-lg font-bold">{formatUGX(stats?.totalPending || 0)}</p>
            <p className="text-xs text-muted-foreground">{stats?.pendingCount || 0} requests</p>
          </CardContent>
        </Card>
      </div>

      {/* Charts */}
      <Tabs defaultValue="bar" className="w-full">
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="bar">Timeline</TabsTrigger>
          <TabsTrigger value="pie">Distribution</TabsTrigger>
        </TabsList>

        <TabsContent value="bar">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Deposits Over Time</CardTitle>
            </CardHeader>
            <CardContent>
              {dailyData.length > 0 ? (
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={dailyData}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                    <XAxis dataKey="date" tick={{ fontSize: 10 }} />
                    <YAxis tick={{ fontSize: 10 }} tickFormatter={(v) => `${(v / 1000).toFixed(0)}k`} />
                    <Tooltip 
                      formatter={(value: number) => formatUGX(value)}
                      contentStyle={{ fontSize: 12 }}
                    />
                    <Bar dataKey="approved" fill="#22c55e" name="Approved" radius={[2, 2, 0, 0]} />
                    <Bar dataKey="rejected" fill="#ef4444" name="Rejected" radius={[2, 2, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <div className="h-[200px] flex items-center justify-center text-muted-foreground">
                  No data for this period
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="pie">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Status Distribution</CardTitle>
            </CardHeader>
            <CardContent>
              {pieData.length > 0 ? (
                <ResponsiveContainer width="100%" height={200}>
                  <PieChart>
                    <Pie
                      data={pieData}
                      cx="50%"
                      cy="50%"
                      innerRadius={40}
                      outerRadius={80}
                      paddingAngle={5}
                      dataKey="value"
                      label={({ name, value }) => `${name}: ${value}`}
                    >
                      {pieData.map((_, index) => (
                        <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip />
                  </PieChart>
                </ResponsiveContainer>
              ) : (
                <div className="h-[200px] flex items-center justify-center text-muted-foreground">
                  No data for this period
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Recent Processed Deposits with Manager Info */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Wallet className="h-4 w-4" />
            Recently Processed
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ScrollArea className="h-64">
            {recentDeposits.length > 0 ? (
              <div className="space-y-2">
                {recentDeposits.map(deposit => (
                  <div
                    key={deposit.id}
                    className="p-3 rounded-lg bg-muted/50 border border-border/50"
                  >
                    <div className="flex items-start justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <User className="h-3 w-3 text-muted-foreground" />
                        <span className="text-sm font-medium">{deposit.user_name}</span>
                      </div>
                      <Badge
                        variant="outline"
                        className={
                          deposit.status === 'approved'
                            ? 'bg-success/10 text-success border-success/30'
                            : 'bg-destructive/10 text-destructive border-destructive/30'
                        }
                      >
                        {deposit.status}
                      </Badge>
                    </div>
                    
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-lg font-bold">{formatUGX(deposit.amount)}</span>
                      <div className="flex items-center gap-1 text-xs text-muted-foreground">
                        <Calendar className="h-3 w-3" />
                        {format(new Date(deposit.approved_at || deposit.rejected_at || deposit.created_at), 'MMM d, h:mm a')}
                      </div>
                    </div>

                    {deposit.processed_by_name && (
                      <div className="flex items-center gap-1 text-xs text-muted-foreground">
                        <span>Processed by:</span>
                        <span className="font-medium text-foreground">{deposit.processed_by_name}</span>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div className="h-full flex items-center justify-center text-muted-foreground">
                No processed deposits yet
              </div>
            )}
          </ScrollArea>
        </CardContent>
      </Card>
      </div>
    </div>
  );
}
