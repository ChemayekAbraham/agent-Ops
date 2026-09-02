import { useState } from 'react';
import { submitLandlordAgreementFile } from '@/lib/landlordAgreementSubmit';
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

type AgreementForm = {
  landlord_name: string;
  landlord_phone: string;
  nin: string;
  agreement_date: string;
  start_date: string;
  end_date: string;
  property_address: string;
  house_number: string;
  house_category: string;
  monthly_rent: string;
  payment_day: string;
  payout_mode: string;
  bank_name: string;
  account_number: string;
  mobile_money_name: string;
  mobile_money_number: string;
  water_meter_number: string;
  water_registered_name: string;
  electricity_meter_number: string;
  electricity_registered_name: string;
  landlord_signature_name: string;
  landlord_signed_on: string;
  welile_signature_name: string;
  welile_signed_on: string;
  witness_name: string;
  witness_signed_on: string;
};

type Props = {
  landlordId: string;
  landlordName: string;
  landlordPhone: string;
  propertyAddress?: string | null;
  monthlyRent?: number | null;
  initialDetails?: Record<string, string | number | null | undefined>;
  onSubmitted?: () => void;
  kind?: 'original' | 'addendum' | 'renewal';
  /** Resubmissions only need the signed file; the existing landlord/request data supplies the metadata. */
  uploadOnly?: boolean;
};

const today = () => new Date().toISOString().slice(0, 10);
const textValue = (value: unknown, fallback = '') => value === null || value === undefined ? fallback : String(value);

function getInitialForm(
  landlordName: string,
  landlordPhone: string,
  propertyAddress?: string | null,
  monthlyRent?: number | null,
  initialDetails?: Record<string, string | number | null | undefined>,
): AgreementForm {
  const details = initialDetails ?? {};
  const value = (key: keyof AgreementForm, fallback = '') => textValue(details[key], fallback);
  return {
    landlord_name: value('landlord_name', landlordName),
    landlord_phone: value('landlord_phone', landlordPhone),
    nin: value('nin'),
    agreement_date: value('agreement_date', today()),
    start_date: value('start_date', today()),
    end_date: value('end_date'),
    property_address: value('property_address', propertyAddress ?? ''),
    house_number: value('house_number'),
    house_category: value('house_category'),
    monthly_rent: value('monthly_rent', monthlyRent != null ? String(monthlyRent) : '0'),
    payment_day: value('payment_day', '1'),
    payout_mode: value('payout_mode'),
    bank_name: value('bank_name'),
    account_number: value('account_number'),
    mobile_money_name: value('mobile_money_name'),
    mobile_money_number: value('mobile_money_number'),
    water_meter_number: value('water_meter_number'),
    water_registered_name: value('water_registered_name'),
    electricity_meter_number: value('electricity_meter_number'),
    electricity_registered_name: value('electricity_registered_name'),
    landlord_signature_name: value('landlord_signature_name', landlordName),
    landlord_signed_on: value('landlord_signed_on'),
    welile_signature_name: value('welile_signature_name', 'Welile Technologies Limited'),
    welile_signed_on: value('welile_signed_on'),
    witness_name: value('witness_name', 'As named in the signed agreement'),
    witness_signed_on: value('witness_signed_on'),
  };
}

export function LandlordAgreementUploader({
  landlordId, landlordName, landlordPhone, propertyAddress, monthlyRent, initialDetails,
  onSubmitted, kind = 'original', uploadOnly = false,
}: Props) {
  const { user } = useAuth();
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<AgreementForm>(() => getInitialForm(
    landlordName, landlordPhone, propertyAddress, monthlyRent, initialDetails,
  ));

  const set = (key: keyof AgreementForm, value: string) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const submit = async () => {
    if (!user) return toast.error('Please sign in again before uploading.');
    if (!file) return toast.error('Upload the signed agreement file first.');

    // Upload-only is used from an agent resubmission. It intentionally does not
    // ask the agent to recreate the contract metadata: the existing landlord
    // and rent-request records remain the source of truth.
    if (!uploadOnly && (
      !form.landlord_name.trim() || !form.landlord_phone.trim() || !form.property_address.trim()
      || !form.monthly_rent.trim() || !form.payment_day.trim() || !form.agreement_date
      || !form.start_date || !form.landlord_signature_name.trim() || !form.welile_signature_name.trim()
      || !form.witness_name.trim()
    )) {
      return toast.error('Complete the agreement details marked in the contract before uploading.');
    }

    const start = form.start_date || today();
    const end = form.end_date || (() => {
      const date = new Date(`${start}T00:00:00`);
      date.setFullYear(date.getFullYear() + 1);
      date.setDate(date.getDate() - 1);
      return date.toISOString().slice(0, 10);
    })();
    const details = {
      landlord_name: form.landlord_name.trim() || landlordName.trim(),
      landlord_phone: form.landlord_phone.trim() || landlordPhone.trim(),
      nin: form.nin,
      agreement_date: form.agreement_date || today(),
      start_date: start,
      end_date: end,
      property_address: form.property_address.trim() || propertyAddress?.trim() || '',
      house_number: form.house_number,
      house_category: form.house_category,
      monthly_rent: form.monthly_rent || (monthlyRent != null ? String(monthlyRent) : ''),
      payment_day: form.payment_day || '1',
      payout_mode: form.payout_mode,
      bank_name: form.bank_name,
      account_number: form.account_number,
      mobile_money_name: form.mobile_money_name,
      mobile_money_number: form.mobile_money_number,
      water_meter_number: form.water_meter_number,
      water_registered_name: form.water_registered_name,
      electricity_meter_number: form.electricity_meter_number,
      electricity_registered_name: form.electricity_registered_name,
      landlord_signature_name: form.landlord_signature_name.trim() || landlordName.trim() || 'As named in the signed agreement',
      landlord_signed_on: form.landlord_signed_on,
      welile_signature_name: form.welile_signature_name.trim() || 'Welile Technologies Limited',
      welile_signed_on: form.welile_signed_on,
      witness_name: form.witness_name.trim() || 'As named in the signed agreement',
      witness_signed_on: form.witness_signed_on,
    };

    if (!details.landlord_name || !details.landlord_phone || !details.property_address || !details.monthly_rent) {
      return toast.error('The existing landlord record is missing required agreement details.');
    }

    setSaving(true);
    try {
      await submitLandlordAgreementFile({ landlordId, file, kind, details });
      toast.success(kind === 'original' ? 'Signed agreement uploaded' : 'Signed addendum uploaded');
      setFile(null);
      onSubmitted?.();
    } catch (error: any) {
      toast.error(error?.message || 'Could not save the agreement');
    } finally {
      setSaving(false);
    }
  };

  const field = (key: keyof AgreementForm, label: string, options?: { required?: boolean; type?: string }) => (
    <div className="min-w-0 space-y-1">
      <Label className="text-xs leading-4">
        {label}{options?.required ? ' *' : ' (optional)'}
      </Label>
      <Input
        type={options?.type ?? 'text'}
        value={form[key]}
        onChange={(event) => set(key, event.target.value)}
        className="h-10 w-full"
      />
    </div>
  );

  return (
    <div className="w-full min-w-0 space-y-4 rounded-lg border bg-muted/20 p-3 sm:p-4">
      <div className="flex min-w-0 items-start gap-2">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        <div className="min-w-0">
          <p className="text-sm font-semibold">{uploadOnly ? 'Attach signed landlord agreement' : kind === 'original' ? 'Signed 12-month agreement' : 'Signed agreement change'}</p>
          <p className="text-xs text-muted-foreground">
            {uploadOnly
              ? 'Upload the signed contract for this existing landlord. The request details are kept unchanged.'
              : 'Complete the contract details, download the approved template, then upload the signed copy.'}
          </p>
        </div>
      </div>

      <Alert>
        <AlertDescription className="text-xs">The signed file must contain the completed contract and the landlord, Welile, and witness signatures.</AlertDescription>
      </Alert>

      {!uploadOnly && <div className="space-y-2 rounded-md border border-dashed bg-background p-3">
        <p className="text-xs text-muted-foreground">Download, print, sign, and upload the approved agreement.</p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-10 w-full gap-2 sm:w-auto"
          onClick={() => downloadLandlordAgreementTemplate({
            landlordName: form.landlord_name,
            landlordPhone: form.landlord_phone,
            nin: form.nin,
            propertyAddress: form.property_address,
            monthlyRent: form.monthly_rent ? Number(form.monthly_rent) : null,
            houseNumber: form.house_number,
            paymentDay: form.payment_day,
          })}
        >
          <Download className="h-4 w-4" /> Download agreement template (PDF)
        </Button>
      </div>}

      {!uploadOnly && <>
        <fieldset className="min-w-0 space-y-3">
          <legend className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Property and landlord</legend>
          <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
            {field('landlord_name', 'Landlord name', { required: true })}
            {field('landlord_phone', 'Phone', { required: true })}
            {field('nin', 'NIN')}
            {field('property_address', 'Property location', { required: true })}
            {field('house_number', 'House / unit')}
            {field('house_category', 'House type')}
            {field('monthly_rent', 'Monthly rent (UGX)', { required: true, type: 'number' })}
            {field('payment_day', 'Payment date', { required: true, type: 'number' })}
            {field('agreement_date', 'Agreement date', { required: true, type: 'date' })}
            {field('start_date', 'Start date', { required: true, type: 'date' })}
            {field('end_date', 'End date')}
          </div>
        </fieldset>

        <fieldset className="min-w-0 space-y-3">
          <legend className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Payment and utility details</legend>
          <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
            {field('payout_mode', 'Payment method')}
            {field('bank_name', 'Bank / Mobile Money name')}
            {field('account_number', 'Account / Mobile Money number')}
            {field('water_meter_number', 'NWSC meter number')}
            {field('water_registered_name', 'NWSC registered name')}
            {field('electricity_meter_number', 'UEDCL meter number')}
            {field('electricity_registered_name', 'UEDCL registered name')}
          </div>
        </fieldset>

        <fieldset className="min-w-0 space-y-3">
          <legend className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Acceptance and signatures</legend>
          <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
            {field('landlord_signature_name', 'Landlord name', { required: true })}
            {field('landlord_signed_on', 'Landlord date', { type: 'date' })}
            {field('welile_signature_name', 'Welile name', { required: true })}
            {field('welile_signed_on', 'Welile date', { type: 'date' })}
            {field('witness_name', 'Witness name', { required: true })}
            {field('witness_signed_on', 'Witness date', { type: 'date' })}
          </div>
        </fieldset>
      </>}

      <div className="min-w-0 space-y-1">
        <Label className="text-xs">Signed agreement file *</Label>
        <Input
          type="file"
          accept={ACCEPTED}
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          className="h-auto min-h-10 w-full py-2 text-xs"
        />
        <p className="text-[10px] text-muted-foreground">PDF, JPG, or PNG up to 20 MB.</p>
      </div>

      <Button type="button" onClick={submit} disabled={saving} className="h-10 w-full gap-2">
        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileUp className="h-4 w-4" />}
        {saving ? 'Saving signed agreement…' : 'Upload signed agreement'}
      </Button>
      {file && (
        <p className="flex min-w-0 items-center gap-1 text-xs text-success">
          <CheckCircle2 className="h-3 w-3 shrink-0" />
          <span className="truncate">{file.name}</span>
        </p>
      )}
    </div>
  );
}
