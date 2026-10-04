import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Building2, Share2, Loader2, Eye, Download } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import LandlordRegistrationForm from '@/components/shared/LandlordRegistrationForm';
import {
  generateLandlordRegistrationFormPdf,
  shareLandlordRegistrationFormPdf,
} from '@/lib/landlordRegistrationFormPdf';

interface RegisterLandlordDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: (landlord?: {
    id: string;
    name: string;
    phone: string;
    property_address: string | null;
    house_category?: string | null;
    latitude?: number | null;
    longitude?: number | null;
  }) => void;
  minimal?: boolean;
}

export default function RegisterLandlordDialog({ open, onOpenChange, onSuccess, minimal }: RegisterLandlordDialogProps) {
  const [building, setBuilding] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewBlob, setPreviewBlob] = useState<Blob | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  // Revoke the object URL when it changes or the component unmounts.
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  // Step 1: build the branded PDF and open the preview so the agent can
  // confirm it looks correct before sharing.
  const handlePreviewForm = async () => {
    setBuilding(true);
    try {
      const blob = await generateLandlordRegistrationFormPdf();
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewBlob(blob);
      setPreviewUrl(URL.createObjectURL(blob));
      setPreviewOpen(true);
    } catch {
      toast.error('Could not create the form', {
        description: 'Please try again in a moment.',
      });
    } finally {
      setBuilding(false);
    }
  };

  // Step 2: share the already-previewed PDF.
  const handleShareForm = async () => {
    if (!previewBlob) return;
    setSharing(true);
    try {
      await shareLandlordRegistrationFormPdf(previewBlob);
    } catch {
      toast.error('Could not share the form', {
        description: 'Please try again in a moment.',
      });
    } finally {
      setSharing(false);
    }
  };

  const handleDownloadForm = () => {
    if (!previewUrl) return;
    const a = document.createElement('a');
    a.href = previewUrl;
    a.download = 'Welile-Landlord-Registration-Form.pdf';
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Building2 className="h-5 w-5 text-primary" />
            Register Landlord
          </DialogTitle>
          <DialogDescription>
            Register a property owner for your portfolio
          </DialogDescription>
        </DialogHeader>
        <Button
          type="button"
          variant="outline"
          onClick={handlePreviewForm}
          disabled={building}
          className="w-full h-11 gap-2 border-primary/30 text-primary hover:bg-primary/5 touch-manipulation select-none"
        >
          {building ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />}
          {building ? 'Preparing form…' : 'Preview printable form'}
        </Button>
        <p className="text-[11px] text-muted-foreground -mt-2">
          Preview the branded form, then share it on WhatsApp. Print, have the landlord fill it in, then register them here.
        </p>
        <LandlordRegistrationForm
          registeredByRole="agent"
          onSuccess={onSuccess}
          onClose={() => onOpenChange(false)}
          toastFn={(opts) => {
            if (opts.variant === 'destructive') {
              toast.error(opts.title, { description: opts.description });
            } else {
              toast.success(opts.title, { description: opts.description });
            }
          }}
          minimal={minimal}
        />
      </DialogContent>

      {/* Branded PDF preview — confirm before sharing */}
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="sm:max-w-2xl max-h-[92vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Eye className="h-5 w-5 text-primary" />
              Preview registration form
            </DialogTitle>
            <DialogDescription>
              Confirm the branded form looks correct, then share or download it.
            </DialogDescription>
          </DialogHeader>

          <div className="flex-1 min-h-0 rounded-lg border bg-muted/30 overflow-hidden">
            {previewUrl ? (
              <iframe
                title="Landlord registration form preview"
                src={`${previewUrl}#toolbar=0&navpanes=0&view=FitH`}
                className="w-full h-[60vh]"
              />
            ) : (
              <div className="flex items-center justify-center h-[60vh] text-sm text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading preview…
              </div>
            )}
          </div>

          <div className="flex flex-col sm:flex-row gap-2 pt-1">
            <Button
              type="button"
              onClick={handleShareForm}
              disabled={sharing || !previewBlob}
              className="flex-1 h-11 gap-2 touch-manipulation select-none"
            >
              {sharing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Share2 className="h-4 w-4" />}
              {sharing ? 'Sharing…' : 'Share on WhatsApp'}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={handleDownloadForm}
              disabled={!previewUrl}
              className="h-11 gap-2 touch-manipulation select-none"
            >
              <Download className="h-4 w-4" /> Download
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </Dialog>
  );
}
