import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { FileText, Loader2, ShieldAlert, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { LandlordAgreementUploader } from './LandlordAgreementUploader';

type Row = {
  id: string; agreement_no: string; kind: string; status: string; is_current: boolean;
  agreement_date: string; start_date: string; end_date: string; monthly_rent: number | null;
  payment_day: number | null; landlord_name: string; landlord_phone: string;
  signed_file_path: string; signed_file_name: string | null; bucket: string;
  uploaded_by_name: string | null; created_at: string;
};

const fmt = (v?: string | null) => (v ? new Date(v).toLocaleDateString('en-UG', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');

export function LandlordAgreementHistory({
  landlordId, landlordName, landlordPhone, propertyAddress, monthlyRent, canAdd = false,
}: {
  landlordId: string; landlordName: string; landlordPhone: string;
  propertyAddress?: string | null; monthlyRent?: number | null; canAdd?: boolean;
}) {
  const [adding, setAdding] = useState<null | 'original' | 'addendum'>(null);
  const { data = [], isLoading, refetch } = useQuery({
    queryKey: ['landlord-agreement-history', landlordId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('landlord_agreement_history', { p_landlord_id: landlordId });
      if (error) throw error;
      return (data ?? []) as unknown as Row[];
    },
    enabled: !!landlordId,
  });

  const open = async (row: Row, download = false) => {
    const { data, error } = await supabase.storage
      .from(row.bucket || 'landlord-agreements')
      .createSignedUrl(row.signed_file_path, 600, download ? { download: row.signed_file_name || true } : undefined);
    if (error || !data?.signedUrl) return toast.error('Could not open the signed agreement');
    window.open(data.signedUrl, '_blank', 'noopener');
  };

  const current = data.find((r) => r.is_current && r.status === 'active');

  return <Card className="p-3 space-y-2">
    <div className="flex items-center justify-between gap-2">
      <div className="flex items-center gap-2 text-sm font-medium"><FileText className="h-4 w-4 text-primary" /> Landlord agreement</div>
      <Badge variant="outline" className="text-[10px]">{data.length} version{data.length === 1 ? '' : 's'}</Badge>
    </div>

    {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : current ? (
      <p className="flex items-center gap-1.5 text-[11px] text-emerald-700"><ShieldCheck className="h-3.5 w-3.5" /> Signed agreement on file ({current.agreement_no}, valid to {fmt(current.end_date)})</p>
    ) : (
      <p className="flex items-center gap-1.5 text-[11px] text-amber-700"><ShieldAlert className="h-3.5 w-3.5" /> Landlord Agreement Not Attached</p>
    )}

    {data.length > 0 && <ul className="space-y-1.5">
      {data.map((row) => <li key={row.id} className="rounded-md border border-border/60 p-2 space-y-1">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-semibold">{row.agreement_no}</span>
          <div className="flex items-center gap-1">
            <Badge variant="outline" className="text-[9px] capitalize">{row.kind}</Badge>
            <Badge variant={row.is_current ? 'default' : 'secondary'} className="text-[9px] capitalize">{row.is_current ? 'current' : row.status}</Badge>
          </div>
        </div>
        <p className="text-[11px] text-muted-foreground">
          {fmt(row.start_date)} → {fmt(row.end_date)} · rent {row.monthly_rent != null ? `UGX ${Number(row.monthly_rent).toLocaleString()}` : '—'} · pay day {row.payment_day ?? '—'}
        </p>
        <p className="text-[10px] text-muted-foreground">Signed {fmt(row.agreement_date)} · uploaded by {row.uploaded_by_name ?? 'staff'} on {fmt(row.created_at)}</p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => open(row)}>
            <FileText className="mr-1.5 h-3.5 w-3.5" /> View signed document
          </Button>
          <Button size="sm" variant="ghost" className="h-7 text-[11px]" onClick={() => open(row, true)}>
            Download
          </Button>
        </div>
      </li>)}
    </ul>}

    {canAdd && (adding ? (
      <div className="space-y-2">
        <LandlordAgreementUploader
          landlordId={landlordId} landlordName={landlordName} landlordPhone={landlordPhone}
          propertyAddress={propertyAddress} monthlyRent={monthlyRent} kind={adding}
          onSubmitted={() => { setAdding(null); refetch(); }}
        />
        <Button size="sm" variant="ghost" className="h-7 text-[11px]" onClick={() => setAdding(null)}>Cancel</Button>
      </div>
    ) : (
      <div className="flex gap-2">
        {!current && <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => setAdding('original')}>Add signed agreement</Button>}
        {current && <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => setAdding('addendum')}>Add signed addendum</Button>}
      </div>
    ))}
  </Card>;
}

export default LandlordAgreementHistory;
