import { useState } from 'react';
import { format } from 'date-fns';
import { FileText, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import {
  generateAgentProductsServicesPdf,
  type ApsReport,
} from '@/lib/agentProductsServicesPdf';

const toDateKey = (d: Date) => format(d, 'yyyy-MM-dd');

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * Toolbar action: fetches the products & services report for today and
 * downloads the branded PDF. Replaces the removed "Reporting" tab.
 */
export function ExportProductsPdfButton() {
  const { user } = useAuth();
  const [busy, setBusy] = useState(false);

  const handleExport = async () => {
    setBusy(true);
    try {
      const todayKey = toDateKey(new Date());
      const [{ data: reportData, error }, { data: cumData }, { data: profile }] = await Promise.all([
        supabase.rpc('get_agent_products_services_report' as any, { p_date: todayKey, p_from: todayKey }),
        supabase.rpc('get_agent_products_cumulative' as any, { p_date: todayKey }),
        user?.id
          ? supabase.from('profiles').select('full_name').eq('id', user.id).maybeSingle()
          : Promise.resolve({ data: null } as any),
      ]);
      if (error) throw error;
      if (!reportData) throw new Error('No report data available');

      const blob = generateAgentProductsServicesPdf({
        report: reportData as unknown as ApsReport,
        actor: profile?.full_name || user?.email || 'Agent Ops user',
        cumulative: (cumData as any) ?? null,
        prev: null,
      });
      downloadBlob(blob, `agent-products-services-${todayKey}.pdf`);
      toast.success('Report downloaded');
    } catch (err: any) {
      toast.error(err?.message || 'Could not generate the report');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button size="sm" variant="outline" className="h-8 text-[11px]" disabled={busy} onClick={handleExport}>
      {busy ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <FileText className="h-3.5 w-3.5 mr-1" />}
      Export PDF
    </Button>
  );
}
