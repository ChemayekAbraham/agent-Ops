import { useState, useEffect, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { formatUGX } from '@/lib/rentCalculations';
import { exportToCSV, exportToPDF, formatNumberForExport } from '@/lib/exportUtils';
import { TrendingUp, Award, Receipt, CheckCircle, Store, Loader2, Download, FileSpreadsheet, FileText } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';
import { toast } from 'sonner';

interface VendorStats {
  id: string;
  name: string;
  location: string | null;
  totalReceipts: number;
  availableReceipts: number;
  markedReceipts: number;
  usedReceipts: number;
  totalVerifiedAmount: number;
  verificationRate: number;
}

const COLORS = ['hsl(var(--primary))', 'hsl(var(--chart-2))', 'hsl(var(--chart-3))', 'hsl(var(--chart-4))', 'hsl(var(--chart-5))'];

export function VendorAnalytics() {
  const [vendorStats, setVendorStats] = useState<VendorStats[]>([]);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const analyticsRef = useRef<HTMLDivElement>(null);
  const [totals, setTotals] = useState({
    totalVendors: 0,
    totalReceipts: 0,
    totalVerified: 0,
    totalVerifiedAmount: 0,
    avgVerificationRate: 0
  });

  useEffect(() => {
    fetchAnalytics();
  }, []);

  const fetchAnalytics = async () => {
    setLoading(true);

    // Fetch vendors
    const { data: vendors } = await supabase
      .from('vendors')
      .select('id, name, location')
      .eq('active', true);

    // Fetch all receipt numbers with their status
    const { data: receipts } = await supabase
      .from('receipt_numbers')
      .select('vendor_id, status, vendor_amount');

    // Fetch verified user receipts
    const { data: userReceipts } = await supabase
      .from('user_receipts')
      .select('receipt_number_id, verified, claimed_amount, receipt_numbers!inner(vendor_id, vendor_amount)')
      .eq('verified', true);

    if (!vendors || !receipts) {
      setLoading(false);
      return;
    }

    // Calculate stats for each vendor
    const stats: VendorStats[] = vendors.map(vendor => {
      const vendorReceipts = receipts.filter(r => r.vendor_id === vendor.id);
      const available = vendorReceipts.filter(r => r.status === 'available').length;
      const marked = vendorReceipts.filter(r => r.status === 'marked').length;
      const used = vendorReceipts.filter(r => r.status === 'used').length;
      const total = vendorReceipts.length;

      // Calculate verified amount from user receipts
      const vendorUserReceipts = (userReceipts || []).filter(
        ur => (ur.receipt_numbers as any)?.vendor_id === vendor.id
      );
      const verifiedAmount = vendorUserReceipts.reduce(
        (sum, ur) => sum + ((ur.receipt_numbers as any)?.vendor_amount || 0), 
        0
      );

      const verificationRate = total > 0 ? (used / total) * 100 : 0;

      return {
        id: vendor.id,
        name: vendor.name,
        location: vendor.location,
        totalReceipts: total,
        availableReceipts: available,
        markedReceipts: marked,
        usedReceipts: used,
        totalVerifiedAmount: verifiedAmount,
        verificationRate
      };
    });

    // Sort by verified receipts (used count)
    stats.sort((a, b) => b.usedReceipts - a.usedReceipts);

    // Calculate totals
    const totalReceipts = stats.reduce((sum, v) => sum + v.totalReceipts, 0);
    const totalVerified = stats.reduce((sum, v) => sum + v.usedReceipts, 0);
    const totalVerifiedAmount = stats.reduce((sum, v) => sum + v.totalVerifiedAmount, 0);
    const avgVerificationRate = stats.length > 0 
      ? stats.reduce((sum, v) => sum + v.verificationRate, 0) / stats.length 
      : 0;

    setVendorStats(stats);
    setTotals({
      totalVendors: vendors.length,
      totalReceipts,
      totalVerified,
      totalVerifiedAmount,
      avgVerificationRate
    });
    setLoading(false);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  const topVendors = vendorStats.slice(0, 5);
  const chartData = topVendors.map(v => ({
    name: v.name.length > 12 ? v.name.substring(0, 12) + '...' : v.name,
    verified: v.usedReceipts,
    marked: v.markedReceipts,
    available: v.availableReceipts
  }));

  const pieData = topVendors.map((v, index) => ({
    name: v.name,
    value: v.totalVerifiedAmount,
    color: COLORS[index % COLORS.length]
  })).filter(d => d.value > 0);

  const handleExportCSV = () => {
    const headers = ['Rank', 'Vendor Name', 'Location', 'Total Receipts', 'Available', 'Marked', 'Verified', 'Verified Amount (UGX)', 'Verification Rate (%)'];
    const rows = vendorStats.map((v, index) => [
      index + 1,
      v.name,
      v.location || 'N/A',
      v.totalReceipts,
      v.availableReceipts,
      v.markedReceipts,
      v.usedReceipts,
      v.totalVerifiedAmount,
      v.verificationRate.toFixed(1)
    ]);

    exportToCSV({ headers, rows }, 'vendor_analytics');
    toast.success('CSV exported successfully!');
  };

  const handleExportPDF = async () => {
    if (!analyticsRef.current) return;
    
    setExporting(true);
    try {
      await exportToPDF(analyticsRef.current, 'vendor_analytics', 'Welile Vendor Analytics Report');
      toast.success('PDF exported successfully!');
    } catch (error) {
      toast.error('Failed to export PDF');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Export Buttons */}
      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={handleExportCSV} className="gap-2">
          <FileSpreadsheet className="h-4 w-4" />
          Export CSV
        </Button>
        <Button variant="outline" size="sm" onClick={handleExportPDF} disabled={exporting} className="gap-2">
          {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
          Export PDF
        </Button>
      </div>

      <div ref={analyticsRef} className="space-y-6 bg-background p-1">
      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-primary/10">
                <Store className="h-5 w-5 text-primary" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Active Vendors</p>
                <p className="text-xl font-bold">{totals.totalVendors}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-blue-500/10">
                <Receipt className="h-5 w-5 text-blue-500" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Total Receipts</p>
                <p className="text-xl font-bold">{totals.totalReceipts}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-green-500/10">
                <CheckCircle className="h-5 w-5 text-green-500" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Verified</p>
                <p className="text-xl font-bold">{totals.totalVerified}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-amber-500/10">
                <TrendingUp className="h-5 w-5 text-amber-500" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Verified Amount</p>
                <p className="text-lg font-bold">{formatUGX(totals.totalVerifiedAmount)}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Charts Row */}
      <div className="grid md:grid-cols-2 gap-6">
        {/* Bar Chart - Receipt Status by Vendor */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Receipts by Vendor</CardTitle>
            <CardDescription>Top 5 vendors by verified receipts</CardDescription>
          </CardHeader>
          <CardContent>
            {chartData.length > 0 ? (
              <ResponsiveContainer width="100%" height={250}>
                <BarChart data={chartData} layout="vertical">
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                  <XAxis type="number" className="text-xs" />
                  <YAxis dataKey="name" type="category" width={80} className="text-xs" />
                  <Tooltip 
                    contentStyle={{ 
                      backgroundColor: 'hsl(var(--background))',
                      border: '1px solid hsl(var(--border))',
                      borderRadius: '8px'
                    }}
                  />
                  <Bar dataKey="verified" fill="hsl(var(--primary))" name="Verified" radius={[0, 4, 4, 0]} />
                  <Bar dataKey="marked" fill="hsl(var(--chart-2))" name="Marked" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <p className="text-center text-muted-foreground py-12">No data available</p>
            )}
          </CardContent>
        </Card>

        {/* Pie Chart - Verified Amount Distribution */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Verified Amount Distribution</CardTitle>
            <CardDescription>Share of verified purchases by vendor</CardDescription>
          </CardHeader>
          <CardContent>
            {pieData.length > 0 ? (
              <ResponsiveContainer width="100%" height={250}>
                <PieChart>
                  <Pie
                    data={pieData}
                    cx="50%"
                    cy="50%"
                    innerRadius={50}
                    outerRadius={80}
                    paddingAngle={2}
                    dataKey="value"
                    label={({ name, percent }) => `${name.substring(0, 8)}... ${(percent * 100).toFixed(0)}%`}
                    labelLine={false}
                  >
                    {pieData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip 
                    formatter={(value: number) => formatUGX(value)}
                    contentStyle={{ 
                      backgroundColor: 'hsl(var(--background))',
                      border: '1px solid hsl(var(--border))',
                      borderRadius: '8px'
                    }}
                  />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <p className="text-center text-muted-foreground py-12">No verified amounts yet</p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Vendor Leaderboard */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Award className="h-5 w-5 text-amber-500" />
            Vendor Leaderboard
          </CardTitle>
          <CardDescription>Ranked by verified receipts</CardDescription>
        </CardHeader>
        <CardContent>
          {vendorStats.length === 0 ? (
            <p className="text-center text-muted-foreground py-8">No vendors registered yet</p>
          ) : (
            <div className="space-y-4">
              {vendorStats.map((vendor, index) => (
                <div 
                  key={vendor.id}
                  className="flex items-center gap-4 p-4 rounded-xl bg-secondary/30 border border-border/50"
                >
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold ${
                    index === 0 ? 'bg-amber-500 text-white' :
                    index === 1 ? 'bg-gray-400 text-white' :
                    index === 2 ? 'bg-amber-700 text-white' :
                    'bg-muted text-muted-foreground'
                  }`}>
                    {index + 1}
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="font-semibold truncate">{vendor.name}</p>
                      {index < 3 && (
                        <Badge variant={index === 0 ? 'default' : 'secondary'} className="shrink-0">
                          {index === 0 ? '🏆 Top' : index === 1 ? '🥈 2nd' : '🥉 3rd'}
                        </Badge>
                      )}
                    </div>
                    {vendor.location && (
                      <p className="text-xs text-muted-foreground truncate">{vendor.location}</p>
                    )}
                    
                    <div className="mt-2 space-y-1">
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-muted-foreground">Verification Rate</span>
                        <span className="font-medium">{vendor.verificationRate.toFixed(1)}%</span>
                      </div>
                      <Progress value={vendor.verificationRate} className="h-1.5" />
                    </div>
                  </div>

                  <div className="text-right shrink-0">
                    <p className="text-lg font-bold text-primary">{vendor.usedReceipts}</p>
                    <p className="text-xs text-muted-foreground">verified</p>
                    <p className="text-sm font-medium mt-1">{formatUGX(vendor.totalVerifiedAmount)}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
      </div>
    </div>
  );
}
