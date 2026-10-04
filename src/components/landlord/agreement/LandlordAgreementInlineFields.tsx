import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { CheckCircle2, Download, ShieldCheck } from 'lucide-react';
import { downloadLandlordAgreementTemplate } from '@/lib/landlordAgreementTemplatePdf';
import { LANDLORD_AGREEMENT_ACCEPT } from '@/lib/landlordAgreementSubmit';

/** The agreement actions embedded in the normal Register Landlord form. */
export type LandlordAgreementInlineValue = {
  file: File | null;
};

export const emptyLandlordAgreementInline: LandlordAgreementInlineValue = { file: null };

export function isLandlordAgreementInlineComplete(value: LandlordAgreementInlineValue) {
  return Boolean(value.file);
}

export function LandlordAgreementInlineFields({
  value,
  onChange,
  landlordName,
  landlordPhone,
  propertyAddress,
}: {
  value: LandlordAgreementInlineValue;
  onChange: (next: LandlordAgreementInlineValue) => void;
  landlordName: string;
  landlordPhone: string;
  propertyAddress: string;
}) {
  return (
    <div className="w-full min-w-0 space-y-3 rounded-lg border bg-muted/20 p-3">
      <div className="flex min-w-0 items-start gap-2">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        <div className="min-w-0">
          <p className="text-sm font-semibold">Landlord contract / agreement</p>
          <p className="text-xs text-muted-foreground">
            You can download the contract, have it completed and signed, then upload the signed copy now or attach it when posting a new Rent Request.
          </p>
        </div>
      </div>

      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-10 w-full gap-2"
        onClick={() => downloadLandlordAgreementTemplate({
          landlordName,
          landlordPhone,
          propertyAddress,
        })}
      >
        <Download className="h-4 w-4" /> Download landlord contract (PDF)
      </Button>

      <div className="min-w-0 space-y-1">
          <label htmlFor="landlord-signed-agreement" className="text-xs font-medium">
          Upload signed contract / agreement (optional)
        </label>
        <Input
          id="landlord-signed-agreement"
          type="file"
          accept={LANDLORD_AGREEMENT_ACCEPT}
          onChange={(event) => onChange({ file: event.target.files?.[0] ?? null })}
          className="h-auto min-h-10 w-full py-2 text-xs"
        />
        <p className="text-[10px] text-muted-foreground">PDF, JPG, or PNG up to 20 MB.</p>
        {value.file && (
          <p className="flex min-w-0 items-center gap-1 text-xs text-success">
            <CheckCircle2 className="h-3 w-3 shrink-0" />
            <span className="truncate">{value.file.name}</span>
          </p>
        )}
      </div>
    </div>
  );
}

export default LandlordAgreementInlineFields;
