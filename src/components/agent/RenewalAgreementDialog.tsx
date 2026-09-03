import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Download, RefreshCw } from 'lucide-react';
import { downloadLandlordAgreementTemplate } from '@/lib/landlordAgreementTemplatePdf';
import { LandlordAgreementUploader } from '@/components/landlord/agreement/LandlordAgreementUploader';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  landlordId: string;
  landlordName: string;
  landlordPhone?: string | null;
  propertyAddress?: string | null;
  monthlyRent?: number | null;
  onContinue: () => void;
}

export function RenewalAgreementDialog({
  open,
  onOpenChange,
  landlordId,
  landlordName,
  landlordPhone,
  propertyAddress,
  monthlyRent,
  onContinue,
}: Props) {
  const continueWithRenewal = () => {
    onOpenChange(false);
    onContinue();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <RefreshCw className="h-4 w-4 text-primary" />
            Landlord agreement for renewal
          </DialogTitle>
          <DialogDescription className="text-xs leading-relaxed">
            A signed landlord agreement is optional when renewing {landlordName}. You can upload one now or continue without it.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 rounded-lg border border-primary/20 bg-primary/5 p-3">
          <p className="text-xs text-muted-foreground">
            If you have a signed copy, upload it to keep the landlord record up to date.
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-10 w-full gap-2"
            onClick={() => downloadLandlordAgreementTemplate({
              landlordName,
              landlordPhone,
              propertyAddress,
              monthlyRent,
            })}
          >
            <Download className="h-4 w-4" />
            Download agreement template (PDF)
          </Button>
        </div>

        <LandlordAgreementUploader
          landlordId={landlordId}
          landlordName={landlordName}
          landlordPhone={landlordPhone || ''}
          propertyAddress={propertyAddress}
          monthlyRent={monthlyRent}
          kind="renewal"
          uploadOnly
          onSubmitted={continueWithRenewal}
        />

        <Button
          type="button"
          variant="outline"
          onClick={continueWithRenewal}
          className="w-full"
        >
          Renew without agreement
        </Button>
      </DialogContent>
    </Dialog>
  );
}
