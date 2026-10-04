import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Building2, UserPlus, Download, Loader2, MessageCircle } from 'lucide-react';
import { toast } from 'sonner';
import { downloadBlob } from '@/lib/whatsappShare';
import {
  generateLandlordRegistrationFormPdf,
  shareLandlordRegistrationFormPdf,
} from '@/lib/landlordRegistrationFormPdf';
import {
  generateTenantRegistrationFormPdf,
  shareTenantRegistrationFormPdf,
} from '@/lib/tenantRegistrationFormPdf';

export type RegFormKind = 'landlord' | 'tenant';

interface RegFormActionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  form: RegFormKind | null;
}

const CONFIG: Record<RegFormKind, {
  title: string;
  icon: typeof Building2;
  filename: string;
  generate: () => Promise<Blob>;
  share: (blob: Blob) => Promise<'shared' | 'deeplink' | 'cancelled'>;
}> = {
  landlord: {
    title: 'Landlord Registration Form',
    icon: Building2,
    filename: 'Welile-Landlord-Registration-Form.pdf',
    generate: () => generateLandlordRegistrationFormPdf(),
    share: (blob) => shareLandlordRegistrationFormPdf(blob),
  },
  tenant: {
    title: 'Tenant Registration Form',
    icon: UserPlus,
    filename: 'Welile-Tenant-Registration-Form.pdf',
    generate: () => generateTenantRegistrationFormPdf(),
    share: (blob) => shareTenantRegistrationFormPdf(blob),
  },
};

/**
 * Lightweight action sheet for the printable registration forms. Gives agents
 * an explicit choice to Download the PDF or Share it on WhatsApp, instead of
 * jumping straight to the share sheet.
 */
export default function RegFormActionDialog({ open, onOpenChange, form }: RegFormActionDialogProps) {
  const [downloading, setDownloading] = useState(false);
  const [sharing, setSharing] = useState(false);

  if (!form) return null;
  const cfg = CONFIG[form];
  const Icon = cfg.icon;

  const handleDownload = async () => {
    setDownloading(true);
    try {
      toast.info('Preparing form…');
      const blob = await cfg.generate();
      downloadBlob(blob, cfg.filename);
      toast.success('Form downloaded');
    } catch {
      toast.error('Could not generate form');
    } finally {
      setDownloading(false);
    }
  };

  const handleShare = async () => {
    setSharing(true);
    try {
      toast.info('Preparing form…');
      const blob = await cfg.generate();
      const result = await cfg.share(blob);
      if (result === 'deeplink') {
        toast.success('Form downloaded — attach it in WhatsApp');
      }
    } catch {
      toast.error('Could not share form');
    } finally {
      setSharing(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon className="h-5 w-5 text-primary" />
            {cfg.title}
          </DialogTitle>
          <DialogDescription>
            Download the printable PDF to your device, or share it directly on WhatsApp.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 pt-2">
          <Button onClick={handleDownload} disabled={downloading} className="w-full gap-2">
            {downloading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            Download PDF
          </Button>
          <Button
            onClick={handleShare}
            disabled={sharing}
            variant="outline"
            className="w-full gap-2"
          >
            {sharing ? <Loader2 className="h-4 w-4 animate-spin" /> : <MessageCircle className="h-4 w-4" />}
            Share on WhatsApp
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}