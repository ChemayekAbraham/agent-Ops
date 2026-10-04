import { useState, useEffect } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import { UserAvatar } from '@/components/UserAvatar';
import { 
  Users, 
  Building2, 
  TrendingUp, 
  MapPin, 
  Wallet, 
  ArrowDownLeft, 
  ArrowUpRight,
  ChevronDown,
  RefreshCw,
  HandCoins,
  UserCheck,
  Share2,
  Download,
  FileSpreadsheet,
} from 'lucide-react';
import { useRef } from 'react';
import { exportToPDF } from '@/lib/exportUtils';
import welileLogo from '@/assets/welile-logo.png';
import { toast } from 'sonner';
import { motion, AnimatePresence } from 'framer-motion';
import { cn } from '@/lib/utils';

interface DailyReportData {
  active_tenants: number;
  tenants_with_balance: number;
  total_rent_balance: number;
  active_landlords: number;
  total_houses: number;
  total_rent_received: number;
  active_supporters: number;
  total_invested: number;
  supporter_wallets_total: number;
  active_agents: number;
  agent_details: { id: string; full_name: string; avatar_url: string | null; tenant_count: number; wallet_balance: number; total_earnings: number }[];
  locations: { city: string; tenant_count: number }[];
  platform_cash_in: number;
  platform_cash_out: number;
  total_wallet_balance: number;
  wallets_with_balance: number;
  wallets_cash_in_today: number;
  wallets_cash_out_today: number;
}

function MetricSection({ 
  title, icon: Icon, iconColor, children, defaultOpen = false, badge 
}: { 
  title: string; 
  icon: React.ElementType; 
  iconColor: string; 
  children: React.ReactNode; 
  defaultOpen?: boolean;
  badge?: string | number;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Card className="overflow-hidden border-border/40">
      <button 
        onClick={() => setOpen(!open)}
        data-section-toggle
        data-section-open={open}
        className="w-full flex items-center gap-2.5 p-3 text-left active:bg-muted/50 transition-colors touch-manipulation min-h-[48px]"
      >
        <div className={cn("p-2 rounded-lg shrink-0", iconColor)}>
          <Icon className="h-4 w-4" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="font-semibold text-[13px] leading-tight">{title}</h3>
        </div>
        {badge !== undefined && (
          <Badge variant="secondary" className="text-[11px] font-bold shrink-0 px-1.5 py-0.5">
            {badge}
          </Badge>
        )}
        <motion.div animate={{ rotate: open ? 180 : 0 }} transition={{ duration: 0.2 }}>
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        </motion.div>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="px-3 pb-3 space-y-2">
              {children}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </Card>
  );
}

function StatRow({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="flex items-center justify-between py-1.5 border-b border-border/30 last:border-0 gap-2">
      <span className="text-[13px] text-muted-foreground leading-tight">{label}</span>
      <div className="text-right shrink-0">
        <span className="text-[13px] font-bold">{value}</span>
        {sub && <p className="text-[10px] text-muted-foreground leading-tight">{sub}</p>}
      </div>
    </div>
  );
}

export function DailyReportMetrics() {
  const [data, setData] = useState<DailyReportData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [sharing, setSharing] = useState(false);
  const reportRef = useRef<HTMLDivElement>(null);

  const fetchReport = async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    try {
      const { data: result, error } = await supabase.rpc('get_manager_daily_report');
      if (error) throw error;
      setData(result as unknown as DailyReportData);
    } catch (err) {
      console.error('[DailyReport] Error:', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => { fetchReport(); }, []);

  const generatePDF = async (): Promise<Blob> => {
    if (!reportRef.current) throw new Error('No report element');

    // Temporarily expand all sections for the PDF
    const allButtons = reportRef.current.querySelectorAll('button[data-section-toggle]');
    const closedSections: HTMLButtonElement[] = [];
    allButtons.forEach((btn) => {
      const el = btn as HTMLButtonElement;
      if (el.getAttribute('data-section-open') === 'false') {
        closedSections.push(el);
        el.click();
      }
    });
    await new Promise(r => setTimeout(r, 400));

    const html2canvas = (await import('html2canvas')).default;
    const { jsPDF } = await import('jspdf');

    const canvas = await html2canvas(reportRef.current, {
      scale: 1.5,
      useCORS: true,
      logging: false,
      backgroundColor: '#ffffff',
    });
    const dataUrl = canvas.toDataURL('image/png');

    const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4', compress: true });
    const pageWidth = pdf.internal.pageSize.getWidth();
    const margin = 10;

    const logoImg = new Image();
    logoImg.src = welileLogo;
    await new Promise<void>((resolve) => {
      logoImg.onload = () => {
        const logoHeight = 10;
        const logoWidth = (logoImg.width * logoHeight) / logoImg.height;
        pdf.addImage(logoImg.src, 'PNG', margin, margin, logoWidth, logoHeight);
        resolve();
      };
      logoImg.onerror = () => resolve();
    });

    let yPosition = margin + 14;
    pdf.setFontSize(14);
    pdf.setFont('helvetica', 'bold');
    pdf.text('Daily Report', margin, yPosition);
    yPosition += 6;
    pdf.setFontSize(8);
    pdf.setFont('helvetica', 'normal');
    pdf.setTextColor(100, 100, 100);
    pdf.text(`Generated: ${new Date().toLocaleString()}`, margin, yPosition);
    pdf.text('welileapp.com', pageWidth - margin - 30, yPosition);
    yPosition += 6;

    const img = new Image();
    img.src = dataUrl;
    await new Promise<void>((resolve, reject) => {
      img.onload = () => {
        const imgWidth = pageWidth - margin * 2;
        const imgHeight = (img.height * imgWidth) / img.width;
        const pageHeight = pdf.internal.pageSize.getHeight();
        const available = pageHeight - yPosition - margin;
        if (imgHeight <= available) {
          pdf.addImage(dataUrl, 'PNG', margin, yPosition, imgWidth, imgHeight, undefined, 'FAST');
        } else {
          const scale = available / imgHeight;
          pdf.addImage(dataUrl, 'PNG', margin, yPosition, imgWidth * scale, imgHeight * scale, undefined, 'FAST');
        }
        resolve();
      };
      img.onerror = () => reject(new Error('Failed'));
    });

    // Collapse sections back
    closedSections.forEach(btn => btn.click());

    return pdf.output('blob');
  };

  const handleDownloadPDF = async () => {
    setSharing(true);
    try {
      const pdfBlob = await generatePDF();
      const fileName = `Welile_Daily_Report_${new Date().toISOString().split('T')[0]}.pdf`;
      const file = new File([pdfBlob], fileName, { type: 'application/pdf' });

      // Try native share (best for mobile - allows save, print, share)
      if (navigator.share && navigator.canShare?.({ files: [file] })) {
        await navigator.share({ title: 'Welile Daily Report', files: [file] });
      } else {
        // Fallback: direct download
        const url = URL.createObjectURL(pdfBlob);
        const link = document.createElement('a');
        link.href = url;
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      toast.success('PDF ready!');
    } catch (err) {
      console.error('PDF failed:', err);
      toast.error('Failed to generate PDF');
    } finally {
      setSharing(false);
    }
  };

  const handleDownloadCSV = () => {
    if (!data) return;
    const rows = [
      ['Welile Daily Report', new Date().toLocaleString()],
      [],
      ['TENANTS'],
      ['Active Tenants', data.active_tenants],
      ['With Rent Balance', data.tenants_with_balance],
      ['Total Rent Balance', data.total_rent_balance],
      [],
      ['LANDLORDS & PROPERTIES'],
      ['Verified Landlords', data.active_landlords],
      ['Total Houses', data.total_houses],
      ['Total Rent Paid Out', data.total_rent_received],
      [],
      ['FUNDERS'],
      ['Active Funders', data.active_supporters],
      ['Total Invested', data.total_invested],
      ['Combined Wallet Balance', data.supporter_wallets_total],
      [],
      ['AGENTS'],
      ['Active Agents', data.active_agents],
      ...data.agent_details.map(a => [`  ${a.full_name}`, `${a.tenant_count} tenants`, a.total_earnings, a.wallet_balance]),
      [],
      ['LOCATIONS'],
      ...data.locations.map(l => [l.city, l.tenant_count]),
      [],
      ['PLATFORM CASH FLOW'],
      ['Total Cash In', data.platform_cash_in],
      ['Total Cash Out', data.platform_cash_out],
      ['Net Position', data.platform_cash_in - data.platform_cash_out],
      [],
      ['WALLETS'],
      ['Total Wallet Balance', data.total_wallet_balance],
      ['Wallets with Balance', data.wallets_with_balance],
      ['Cash In Today', data.wallets_cash_in_today],
      ['Cash Out Today', data.wallets_cash_out_today],
      ["Today's Net", data.wallets_cash_in_today - data.wallets_cash_out_today],
    ];

    const csvContent = rows.map(row => row.map(v => {
      const s = String(v ?? '');
      return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(',')).join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const fileName = `Welile_Daily_Report_${new Date().toISOString().split('T')[0]}.csv`;
    const file = new File([blob], fileName, { type: 'text/csv' });

    if (navigator.share && navigator.canShare?.({ files: [file] })) {
      navigator.share({ title: 'Welile Daily Report', files: [file] });
    } else {
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    toast.success('CSV ready — open with Google Sheets!');
  };

  const handleShareWhatsApp = async () => {
    setSharing(true);
    try {
      const pdfBlob = await generatePDF();
      const fileName = `Welile_Daily_Report_${new Date().toISOString().split('T')[0]}.pdf`;
      const file = new File([pdfBlob], fileName, { type: 'application/pdf' });

      if (navigator.share && navigator.canShare?.({ files: [file] })) {
        await navigator.share({
          title: 'Welile Daily Report',
          text: '📊 Welile Daily Report - Platform metrics overview',
          files: [file],
        });
      } else {
        const url = URL.createObjectURL(pdfBlob);
        const link = document.createElement('a');
        link.href = url;
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        setTimeout(() => URL.revokeObjectURL(url), 1000);

        const waText = encodeURIComponent('📊 Welile Daily Report\nPlatform metrics overview\nGenerated: ' + new Date().toLocaleString() + '\n\nSee attached PDF.');
        window.open(`https://wa.me/?text=${waText}`, '_blank');
      }
      toast.success('Report ready to share!');
    } catch (err) {
      console.error('Share failed:', err);
      toast.error('Failed to generate report PDF');
    } finally {
      setSharing(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3, 4].map(i => (
          <Skeleton key={i} className="h-20 w-full rounded-2xl" />
        ))}
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="space-y-2" ref={reportRef}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-bold">📊 Daily Report</h2>
          <p className="text-[11px] text-muted-foreground">Platform metrics overview</p>
        </div>
        <div className="flex items-center gap-1">
          <button 
            onClick={handleDownloadPDF}
            disabled={sharing}
            className="p-2 rounded-lg bg-primary/10 text-primary hover:bg-primary/20 active:scale-95 transition-all touch-manipulation min-h-[40px] min-w-[40px] flex items-center justify-center"
            title="Download PDF"
          >
            <Download className={cn("h-4 w-4", sharing && "animate-pulse")} />
          </button>
          <button 
            onClick={handleDownloadCSV}
            className="p-2 rounded-lg bg-chart-2/10 text-chart-2 hover:bg-chart-2/20 active:scale-95 transition-all touch-manipulation min-h-[40px] min-w-[40px] flex items-center justify-center"
            title="Export to Google Sheets (CSV)"
          >
            <FileSpreadsheet className="h-4 w-4" />
          </button>
          <button 
            onClick={handleShareWhatsApp}
            disabled={sharing}
            className="p-2 rounded-lg bg-success/10 text-success hover:bg-success/20 active:scale-95 transition-all touch-manipulation min-h-[40px] min-w-[40px] flex items-center justify-center"
            title="Share on WhatsApp"
          >
            <Share2 className={cn("h-4 w-4", sharing && "animate-pulse")} />
          </button>
          <button 
            onClick={() => fetchReport(true)} 
            disabled={refreshing}
            className="p-2 rounded-lg bg-muted hover:bg-muted/80 active:scale-95 transition-all touch-manipulation min-h-[40px] min-w-[40px] flex items-center justify-center"
          >
            <RefreshCw className={cn("h-4 w-4", refreshing && "animate-spin")} />
          </button>
        </div>
      </div>

      {/* Top Summary Cards */}
      <div className="grid grid-cols-2 gap-1.5">
        <Card className="bg-gradient-to-br from-primary/10 to-primary/5 border-primary/20">
          <CardContent className="p-2.5">
            <div className="flex items-center gap-1.5 mb-0.5">
              <ArrowDownLeft className="h-3.5 w-3.5 text-primary" />
              <span className="text-[9px] font-semibold text-primary uppercase tracking-wider">Cash In Today</span>
            </div>
            <p className="text-base font-black leading-tight">{formatUGX(data.wallets_cash_in_today)}</p>
          </CardContent>
        </Card>
        <Card className="bg-gradient-to-br from-destructive/10 to-destructive/5 border-destructive/20">
          <CardContent className="p-2.5">
            <div className="flex items-center gap-1.5 mb-0.5">
              <ArrowUpRight className="h-3.5 w-3.5 text-destructive" />
              <span className="text-[9px] font-semibold text-destructive uppercase tracking-wider">Cash Out Today</span>
            </div>
            <p className="text-base font-black leading-tight">{formatUGX(data.wallets_cash_out_today)}</p>
          </CardContent>
        </Card>
      </div>

      {/* 1. Platform Cash Flow - PRIMARY */}
      <MetricSection 
        title="Platform Cash Flow" 
        icon={TrendingUp} 
        iconColor="bg-success/10 text-success"
        defaultOpen={true}
        badge={formatUGX(data.platform_cash_in - data.platform_cash_out)}
      >
        <StatRow label="Total Cash In" value={formatUGX(data.platform_cash_in)} sub="All-time inflows" />
        <StatRow label="Total Cash Out" value={formatUGX(data.platform_cash_out)} sub="All-time outflows" />
        <div className="p-2.5 rounded-lg bg-success/10 border border-success/20 mt-1">
          <div className="flex items-center justify-between">
            <span className="text-[13px] font-medium text-success">Net Position</span>
            <span className="text-base font-black text-success">
              {formatUGX(data.platform_cash_in - data.platform_cash_out)}
            </span>
          </div>
        </div>
      </MetricSection>

      {/* 2. Tenants */}
      <MetricSection 
        title="Tenants" 
        icon={Users} 
        iconColor="bg-primary/10 text-primary"
        badge={data.active_tenants}
      >
        <StatRow label="Active Tenants" value={data.active_tenants} />
        <StatRow label="With Rent Balance" value={data.tenants_with_balance} />
        <StatRow label="Total Rent Balance" value={formatUGX(data.total_rent_balance)} sub="Outstanding receivables" />
      </MetricSection>

      {/* 3. Landlords */}
      <MetricSection 
        title="Landlords & Properties" 
        icon={Building2} 
        iconColor="bg-chart-2/10 text-chart-2"
        badge={data.active_landlords}
      >
        <StatRow label="Verified Landlords" value={data.active_landlords} />
        <StatRow label="Total Houses" value={data.total_houses} />
        <StatRow label="Total Rent Paid Out" value={formatUGX(data.total_rent_received)} sub="All-time rent to landlords" />
      </MetricSection>

      {/* 4. Funders / Supporters */}
      <MetricSection 
        title="Funders (Supporters)" 
        icon={HandCoins} 
        iconColor="bg-chart-4/10 text-chart-4"
        badge={data.active_supporters}
      >
        <StatRow label="Active Funders" value={data.active_supporters} />
        <StatRow label="Total Invested" value={formatUGX(data.total_invested)} />
        <StatRow label="Combined Wallet Balance" value={formatUGX(data.supporter_wallets_total)} sub="Current funder balances" />
      </MetricSection>

      {/* 5. Agents */}
      <MetricSection 
        title="Agents" 
        icon={UserCheck} 
        iconColor="bg-chart-5/10 text-chart-5"
        badge={data.active_agents}
      >
        <StatRow label="Active Agents" value={data.active_agents} />
        {data.agent_details.length > 0 && (
          <div className="space-y-1.5 mt-1.5">
            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Top Agents by Tenants</p>
            {data.agent_details.slice(0, 10).map((agent, i) => (
              <div key={agent.id} className="flex items-center gap-2 p-2 rounded-lg bg-muted/40 border border-border/30">
                <span className="text-[11px] font-bold text-muted-foreground w-4 text-center">{i + 1}</span>
                <UserAvatar avatarUrl={agent.avatar_url} fullName={agent.full_name} size="sm" />
                <div className="flex-1 min-w-0">
                  <p className="text-[13px] font-medium truncate">{agent.full_name}</p>
                  <p className="text-[10px] text-muted-foreground leading-tight">
                    {agent.tenant_count} tenants · {formatUGX(agent.total_earnings)} earned
                  </p>
                </div>
                <div className="text-right shrink-0">
                  <p className="text-[11px] font-bold">{formatUGX(agent.wallet_balance)}</p>
                  <p className="text-[9px] text-muted-foreground">balance</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </MetricSection>

      {/* 6. Locations */}
      <MetricSection 
        title="Tenant Locations" 
        icon={MapPin} 
        iconColor="bg-chart-3/10 text-chart-3"
        badge={data.locations.length}
      >
        {data.locations.length > 0 ? (
          <div className="space-y-0.5">
            {data.locations.map((loc) => (
              <div key={loc.city} className="flex items-center justify-between py-1.5 border-b border-border/30 last:border-0">
                <div className="flex items-center gap-1.5">
                  <MapPin className="h-3 w-3 text-chart-3" />
                  <span className="text-[13px]">{loc.city}</span>
                </div>
                <Badge variant="outline" className="text-[11px] px-1.5 py-0">{loc.tenant_count}</Badge>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-[13px] text-muted-foreground text-center py-2">No location data yet</p>
        )}
      </MetricSection>

      {/* 7. Wallets */}
      <MetricSection 
        title="Wallet Balances" 
        icon={Wallet} 
        iconColor="bg-warning/10 text-warning"
        badge={formatUGX(data.total_wallet_balance)}
      >
        <StatRow label="Total Wallet Balance" value={formatUGX(data.total_wallet_balance)} />
        <StatRow label="Wallets with Balance" value={data.wallets_with_balance} />
        <StatRow label="Cash In Today" value={formatUGX(data.wallets_cash_in_today)} />
        <StatRow label="Cash Out Today" value={formatUGX(data.wallets_cash_out_today)} />
        <div className="p-2.5 rounded-lg bg-warning/10 border border-warning/20 mt-1">
          <div className="flex items-center justify-between">
            <span className="text-[13px] font-medium text-warning">Today's Net</span>
            <span className={cn(
              "text-base font-black",
              data.wallets_cash_in_today - data.wallets_cash_out_today >= 0 ? "text-success" : "text-destructive"
            )}>
              {formatUGX(data.wallets_cash_in_today - data.wallets_cash_out_today)}
            </span>
          </div>
        </div>
      </MetricSection>
    </div>
  );
}
