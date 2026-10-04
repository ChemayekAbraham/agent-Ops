import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { Loader2, Shield } from 'lucide-react';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  agreementText: string;
  onAccept: () => Promise<boolean>;
  viewOnly?: boolean;
  acceptLabel?: string;
}

/**
 * Reusable scrollable agreement modal with explicit "I have read & agree" checkbox.
 * Used for lender vouch agreement, borrower disclosure, lending agent agreement, etc.
 */
export default function VouchAgreementModal({
  isOpen,
  onClose,
  title,
  subtitle,
  agreementText,
  onAccept,
  viewOnly = false,
  acceptLabel = 'I Agree',
}: Props) {
  const [agreed, setAgreed] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const handleAccept = async () => {
    if (!agreed) return;
    setSubmitting(true);
    try {
      const ok = await onAccept();
      if (ok) {
        setAgreed(false);
        onClose();
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col p-0 gap-0">
        <DialogHeader className="p-5 pb-3 border-b">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Shield className="h-4 w-4 text-primary" />
            {title}
          </DialogTitle>
          {subtitle && <DialogDescription className="text-xs">{subtitle}</DialogDescription>}
        </DialogHeader>

        <ScrollArea className="flex-1 px-5 py-4">
          <pre className="whitespace-pre-wrap text-xs leading-relaxed font-sans text-foreground">
            {agreementText}
          </pre>
        </ScrollArea>

        <DialogFooter className="p-4 pt-3 border-t flex-col sm:flex-col gap-3 items-stretch">
          {!viewOnly && (
            <label className="flex items-start gap-2.5 text-xs cursor-pointer p-2 rounded-md hover:bg-muted/40">
              <Checkbox
                checked={agreed}
                onCheckedChange={(c) => setAgreed(c === true)}
                className="mt-0.5"
              />
              <span className="leading-relaxed">
                I have read, understood, and accept the terms above. I confirm I am authorised to accept on my behalf.
              </span>
            </label>
          )}
          <div className="flex gap-2 justify-end">
            <Button variant="outline" size="sm" onClick={onClose}>
              {viewOnly ? 'Close' : 'Cancel'}
            </Button>
            {!viewOnly && (
              <Button size="sm" onClick={handleAccept} disabled={!agreed || submitting}>
                {submitting && <Loader2 className="h-3 w-3 mr-1.5 animate-spin" />}
                {acceptLabel}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
