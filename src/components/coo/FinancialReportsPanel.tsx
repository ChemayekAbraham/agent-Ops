import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { supabase } from '@/integrations/supabase/client';
import { format, startOfDay, startOfWeek, startOfMonth, subDays, subMonths } from 'date-fns';
import { Download, FileText, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

type ReportType = 'daily' | 'weekly' | 'monthly' | 'agent' | 'coverage';

export default function FinancialReportsPanel() {
  const [generating, setGenerating] = useState<ReportType | null>(null);

  const generateReport = async (type: ReportType) => {
    setGenerating(type);
    try {
      let fromDate: string;
      let toDate = new Date().toISOString();
      let filename: string;

      switch (type) {
        case 'daily':
          fromDate = startOfDay(new Date()).toISOString();
          filename = `daily-revenue-${format(new Date(), 'yyyy-MM-dd')}`;
          break;
        case 'weekly':
          fromDate = startOfWeek(new Date(), { weekStartsOn: 1 }).toISOString();
          filename = `weekly-collections-${format(new Date(), 'yyyy-MM-dd')}`;
          break;
        case 'monthly':
          fromDate = startOfMonth(new Date()).toISOString();
          filename = `monthly-summary-${format(new Date(), 'yyyy-MM')}`;
          break;
        case 'agent':
          fromDate = subMonths(new Date(), 1).toISOString();
          filename = `agent-payments-${format(new Date(), 'yyyy-MM-dd')}`;
          break;
      }

      if (type === 'agent') {
        const { data } = await supabase.from('agent_collections').select('*').is('reversed_at', null).gte('created_at', fromDate).order('created_at', { ascending: false });
        const headers = ['Date', 'Agent ID', 'Tenant ID', 'Amount', 'Payment Method', 'Location', 'MoMo Provider', 'MoMo Phone'];
        const rows = (data || []).map(r => [
          r.created_at, r.agent_id, r.tenant_id, r.amount,
          r.payment_method, r.location_name || '', r.momo_provider || '', r.momo_phone || '',
        ]);
        downloadCSV(headers, rows, filename);
      } else if (type === 'coverage') {
        const { data, error } = await supabase.rpc('get_coo_rent_coverage_statement' as any);
        if (error) throw error;
        const { generateRentCoverageStatementPdf } = await import('@/lib/rentCoverageStatementPdf');
        const blob = await generateRentCoverageStatementPdf(data as any);
        downloadBlob(blob, `rent-coverage-statement-${format(new Date(), 'yyyy-MM-dd')}.pdf`);
      } else {
        const { data } = await supabase.from('general_ledger').select('*')
          .gte('transaction_date', fromDate).lte('transaction_date', toDate)
          .order('transaction_date', { ascending: false });
        const headers = ['Date', 'Reference', 'Category', 'Direction', 'Amount', 'Linked Party', 'Description', 'Account'];
        const rows = (data || []).map(r => [
          r.transaction_date, r.reference_id || '', r.category, r.direction,
          r.amount, r.linked_party || '', (r.description || '').replace(/,/g, ' '), r.account || '',
        ]);
        downloadCSV(headers, rows, filename);
      }
      toast.success(`${type.charAt(0).toUpperCase() + type.slice(1)} report downloaded`);
    } catch (e: any) {
      toast.error(e?.message || 'Failed to generate report');
    } finally {
      setGenerating(null);
    }
  };

  const downloadCSV = (headers: string[], rows: any[][], filename: string) => {
    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    downloadBlob(blob, `${filename}.csv`);
  };

  const downloadBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const reports = [
    { type: 'daily' as ReportType, label: 'Daily Revenue Report', desc: "Today's financial activity" },
    { type: 'weekly' as ReportType, label: 'Weekly Collection Report', desc: 'Collections this week' },
    { type: 'monthly' as ReportType, label: 'Monthly Financial Summary', desc: 'Full month ledger summary' },
    { type: 'agent' as ReportType, label: 'Agent Payment Report', desc: 'Agent collections last 30 days' },
    { type: 'coverage' as ReportType, label: 'Rent Coverage Financial Statement (PDF)', desc: 'Real tenants, active tenants, rent disbursed since launch vs collected' },
  ];

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-lg flex items-center gap-2">
          <FileText className="h-4 w-4 text-primary" /> Financial Reports
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {reports.map(r => (
            <div key={r.type} className="flex items-center justify-between p-3 rounded-xl border border-border bg-muted/30">
              <div>
                <p className="text-sm font-medium">{r.label}</p>
                <p className="text-xs text-muted-foreground">{r.desc}</p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => generateReport(r.type)}
                disabled={generating === r.type}
              >
                {generating === r.type ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
              </Button>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
