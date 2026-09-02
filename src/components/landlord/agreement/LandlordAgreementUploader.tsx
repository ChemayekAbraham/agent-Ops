import { useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { CheckCircle2, Download, FileUp, Loader2, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { downloadLandlordAgreementTemplate } from '@/lib/landlordAgreementTemplatePdf';


const ACCEPTED = '.pdf,.jpg,.jpeg,.png';
const MAX_BYTES = 20 * 1024 * 1024;

type Props = {
  landlordId: string;
  landlordName: string;
  landlordPhone: string;
  propertyAddress?: string | null;
  monthlyRent?: number | null;
  initialDetails?: Record<string, string | number | null | undefined>;
  onSubmitted?: () => void;
  kind?: 'original' | 'addendum' | 'renewal';
};

function isoDate(value: string) {
  return value || new Date().toISOString().slice(0, 10);
}

export function LandlordAgreementUploader({
  landlordId, landlordName, landlordPhone, propertyAddress, monthlyRent, initialDetails,
  onSubmitted, kind = 'original',
}: Props) {
  const { user } = useAuth();
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(() => ({
    landlord_name: landlordName, landlord_phone: landlordPhone,
    nin: '', agreement_date: isoDate(''), start_date: isoDate(''), end_date: '',
    property_address: propertyAddress ?? '', monthly_rent: monthlyRent ? String(monthlyRent) : '',
    payment_day: '1', house_number: '', house_category: '', number_of_rooms: '', payout_mode: '',
    bank_name: '', account_number: '', mobile_money_name: '', mobile_money_number: '',
    water_meter_number: '', water_registered_name: '', electricity_meter_number: '',
    electricity_registered_name: '', landlord_signature_name: landlordName,
    landlord_signed_on: isoDate(''), welile_signature_name: 'Welile Technologies Limited',
    welile_signed_on: isoDate(''), witness_name: '', witness_signed_on: isoDate(''),
    ...Object.fromEntries(
      Object.entries(initialDetails ?? {}).filter(([, value]) => value !== null && value !== undefined)
        .map(([key, value]) => [key, String(value)]),
    ),
  }));

  const set = (key: string, value: string) => setForm((current) => ({ ...current, [key]: value }));
  const submit = async () => {
    if (!user) return toast.error('Please sign in again before uploading.');
    if (!file) return toast.error('Upload the signed agreement file first.');
    if (file.size > MAX_BYTES) return toast.error('The agreement must be 20 MB or smaller.');
    const end = form.end_date || (() => {
      const d = new Date(`${form.start_date}T00:00:00`); d.setFullYear(d.getFullYear() + 1); d.setDate(d.getDate() - 1); return d.toISOString().slice(0, 10);
    })();
    if (!form.nin.trim() || !form.property_address.trim() || !form.monthly_rent || !form.witness_name.trim()) {
      return toast.error('NIN, property, rent, and witness details are required.');
    }
    setSaving(true);
    try {
      const path = `${landlordId}/${crypto.randomUUID()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      const upload = await supabase.storage.from('landlord-agreements').upload(path, file, { upsert: false, contentType: file.type });
      if (upload.error) throw upload.error;
      const bytes = await file.arrayBuffer();
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      const sha256 = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
      const { error } = await supabase.rpc('submit_landlord_agreement', {
        p_landlord_id: landlordId, p_kind: kind, p_file_path: path, p_file_name: file.name,
        p_file_sha256: sha256, p_file_mime_type: file.type, p_details: { ...form, end_date: end },
      });
      if (error) throw error;
      toast.success(kind === 'original' ? 'Signed agreement uploaded' : 'Signed addendum uploaded');
      setFile(null); onSubmitted?.();
    } catch (error: any) {
      toast.error(error?.message || 'Could not save the agreement');
    } finally { setSaving(false); }
  };

  const field = (key: string, label: string, required = false, type = 'text') => (
    <div className="space-y-1"><Label className="text-xs">{label}{required ? ' *' : ''}</Label><Input type={type} value={(form as any)[key]} onChange={(e) => set(key, e.target.value)} /></div>
  );

  return <div className="space-y-3 rounded-lg border bg-muted/20 p-3">
    <div className="flex items-start gap-2"><ShieldCheck className="h-4 w-4 text-primary mt-0.5" /><div><p className="text-sm font-semibold">{kind === 'original' ? 'Signed 12-month agreement' : 'Signed agreement change'}</p><p className="text-[11px] text-muted-foreground">Each upload is saved as a permanent, separate version. Old documents are never overwritten.</p></div></div>
    <Alert><AlertDescription className="text-xs">The signed file must contain the landlord, Welile, and witness signatures, dates, rent/payment terms, property details, and required identity information.</AlertDescription></Alert>
    <div className="rounded-md border border-dashed bg-background p-2">
      <p className="text-[11px] text-muted-foreground mb-2">No signed paper yet? Download the ready-made template, print it, have the landlord and a witness sign, then upload it below.</p>
      <Button type="button" variant="outline" size="sm" className="w-full gap-2" onClick={() => downloadLandlordAgreementTemplate({
        landlordName: form.landlord_name, landlordPhone: form.landlord_phone, nin: form.nin,
        propertyAddress: form.property_address, monthlyRent: form.monthly_rent ? Number(form.monthly_rent) : null,
        houseNumber: form.house_number, paymentDay: form.payment_day,
      })}>
        <Download className="h-4 w-4" /> Download agreement template (PDF)
      </Button>
    </div>

    <div className="grid grid-cols-2 gap-2">
      {field('nin', 'Landlord NIN', true)}{field('agreement_date', 'Agreement date', true, 'date')}
      {field('start_date', 'Start date', true, 'date')}{field('end_date', 'End date (optional)', false, 'date')}
      {field('property_address', 'Property address', true)}{field('monthly_rent', 'Monthly rent (UGX)', true, 'number')}
      {field('payment_day', 'Payment day', true, 'number')}{field('house_number', 'House number')}
      {field('house_category', 'House category')}{field('number_of_rooms', 'Number of rooms', false, 'number')}
      {field('payout_mode', 'Payout mode')}{field('bank_name', 'Bank name')}
      {field('account_number', 'Account number')}{field('mobile_money_name', 'MoMo name')}
      {field('mobile_money_number', 'MoMo number')}{field('water_meter_number', 'Water meter')}
      {field('electricity_meter_number', 'Electricity meter')}{field('landlord_signature_name', 'Landlord signature name', true)}
      {field('landlord_signed_on', 'Landlord signed on', true, 'date')}{field('welile_signature_name', 'Welile signer', true)}
      {field('welile_signed_on', 'Welile signed on', true, 'date')}{field('witness_name', 'Witness name', true)}
      {field('witness_signed_on', 'Witness signed on', true, 'date')}
    </div>
    <div className="space-y-1"><Label className="text-xs">Signed agreement file *</Label><Input type="file" accept={ACCEPTED} onChange={(e) => setFile(e.target.files?.[0] ?? null)} /><p className="text-[10px] text-muted-foreground">PDF, JPG, or PNG up to 20 MB.</p></div>
    <Button type="button" onClick={submit} disabled={saving} className="w-full gap-2">{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileUp className="h-4 w-4" />}{saving ? 'Saving signed agreement…' : 'Upload signed agreement'}</Button>
    {file && <p className="flex items-center gap-1 text-[11px] text-emerald-700"><CheckCircle2 className="h-3 w-3" /> {file.name}</p>}
  </div>;
}
