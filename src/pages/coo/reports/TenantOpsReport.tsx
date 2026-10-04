import ExecutiveDashboardLayout from '@/components/layout/ExecutiveDashboardLayout';
import COOReportPage from '@/components/coo/COOReportPage';
import { useTenantOpsReportData } from '@/components/coo/useCOOReportData';
import { usePersistedActiveTab } from '@/hooks/usePersistedActiveTab';
import { Home, UserPlus, Clock, ShieldCheck, FileWarning, HeartHandshake, AlertTriangle, Banknote } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Download, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { generateAndDownloadActiveTenantsPdf } from '@/lib/activeTenantsReportPdf';

const ugx = (n: number) => `UGX ${new Intl.NumberFormat('en-UG').format(Math.round(n || 0))}`;

/**
 * COO → Reports → Tenant Ops
 * Live data from `rent_requests` (the canonical Rent Plan pipeline).
 */
export default function TenantOpsReportPage() {
  const [, setActiveTab] = usePersistedActiveTab('coo');
  const { data, isLoading, refetch } = useTenantOpsReportData();
  const [exporting, setExporting] = useState(false);

  const handleExport = async () => {
    setExporting(true);
    try {
      const count = await generateAndDownloadActiveTenantsPdf();
      toast.success(`Active tenants report ready (${count} tenants)`);
    } catch (e: any) {
      toast.error(e?.message || 'Failed to generate report');
    } finally {
      setExporting(false);
    }
  };

  const k = data?.kpis ?? { total: 0, pending: 0, approved: 0, funded: 0, disbursed: 0, rejected: 0, totalRent: 0 };
  const activities = data?.activities ?? [];
  const trend = data?.trend ?? [];
  const funnel = data?.funnel ?? [];

  return (
    <ExecutiveDashboardLayout role="coo" activeTab="reports-tenant-ops" onTabChange={setActiveTab}>
      <div className="flex justify-end mb-3">
        <Button onClick={handleExport} disabled={exporting} className="gap-2">
          {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
          Tenants Report — Active Plans (PDF)
        </Button>
      </div>
      <COOReportPage
        title="Tenant Ops Report"
        description="Live Rent Plan pipeline — submissions, approvals, funding, and disbursements across the last 30 days."
        icon={Home}
        loading={isLoading}
        onGenerate={async () => { await refetch(); }}
        statusOptions={['pending', 'approved', 'funded', 'disbursed', 'rejected']}
        activityTypeOptions={['Rent plan request']}
        departmentOptions={['Tenant Ops']}
        kpis={[
          { label: 'Submitted (30d)',     value: String(k.total),     sub: 'Total Rent Plans',     icon: UserPlus,       severity: 'info' },
          { label: 'Pending review',      value: String(k.pending),   sub: 'Awaiting Tenant Ops',  icon: Clock,          severity: 'warning', urgent: k.pending > 0 },
          { label: 'Approved',            value: String(k.approved),  sub: 'Cleared for funding',  icon: ShieldCheck,    severity: 'success' },
          { label: 'Funded',              value: String(k.funded),    sub: 'Capital allocated',    icon: HeartHandshake, severity: 'success' },
          { label: 'Disbursed to landlord', value: String(k.disbursed), sub: 'Cash routed',        icon: Banknote,       severity: 'success' },
          { label: 'Rejected',            value: String(k.rejected),  sub: 'Did not pass',         icon: FileWarning,    severity: 'destructive' },
          { label: 'Total rent value',    value: ugx(k.totalRent),    sub: 'Sum of monthly rent',  icon: Banknote,       severity: 'info' },
          { label: 'Conversion: sub→fund', value: k.total ? `${Math.round((k.funded / k.total) * 100)}%` : '0%', sub: 'Funded / submitted', icon: AlertTriangle, severity: 'neutral' },
        ]}
        charts={[
          {
            kind: 'line',
            title: 'Daily Rent Plan submissions (last 14 days)',
            seriesKeys: ['count'],
            data: trend,
          },
          {
            kind: 'bar',
            title: 'Pipeline funnel',
            seriesKeys: ['value'],
            data: funnel,
          },
        ]}
        activities={activities}
        insights={[
          { kind: k.pending > 0 ? 'pending' : 'trend', title: `${k.pending} Rent Plan requests pending`, body: 'Tenant Ops should triage within SLA — every hour late delays landlord disbursement.' },
          { kind: 'trend', title: 'Pipeline conversion', body: `${k.approved} approved, ${k.funded} funded, ${k.disbursed} disbursed of ${k.total} submitted.` },
          { kind: 'priority', title: `${k.rejected} rejections this month`, body: 'Review rejection reasons to refine the inbound qualification criteria.' },
          { kind: 'action', title: 'Total rent under management', body: `Rent Plans worth ${ugx(k.totalRent)} entered the pipeline this window.` },
        ]}
      />
    </ExecutiveDashboardLayout>
  );
}
