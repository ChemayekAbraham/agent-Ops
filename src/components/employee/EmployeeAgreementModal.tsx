import { forwardRef, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Checkbox } from '@/components/ui/checkbox';
import { FileText, Loader2 } from 'lucide-react';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onAccept: () => Promise<boolean>;
  viewOnly?: boolean;
}

const EmployeeAgreementModal = forwardRef<HTMLDivElement, Props>(({ isOpen, onClose, onAccept, viewOnly = false }, ref) => {
  const [agreed, setAgreed] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const handleAccept = async () => {
    setSubmitting(true);
    const ok = await onAccept();
    setSubmitting(false);
    if (ok) onClose();
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent ref={ref} className="max-w-lg max-h-[90vh] flex flex-col p-0">
        <DialogHeader className="px-5 pt-5 pb-3 border-b">
          <DialogTitle className="flex items-center gap-2 text-lg">
            <FileText className="h-5 w-5 text-primary" />
            Welile Employment Contract
          </DialogTitle>
        </DialogHeader>

        <ScrollArea className="flex-1 px-5 py-4 max-h-[55vh]">
          <div className="prose prose-sm dark:prose-invert max-w-none space-y-4 text-sm">
            <h3 className="text-base font-bold">STANDARD EMPLOYMENT CONTRACT</h3>
            <p className="text-muted-foreground text-xs">Version 1.0 • Welile Technologies Limited</p>

            <h4>1. PARTIES</h4>
            <p>This Employment Contract ("Contract") is entered into between <strong>Welile Technologies Limited</strong> ("the Company") and the Employee named on the digital acceptance record ("the Employee").</p>

            <h4>2. APPOINTMENT &amp; DUTIES</h4>
            <p>The Employee is appointed to the position indicated in their staff profile. The Employee shall perform duties as assigned by their line manager and the Company's executive leadership, including but not limited to:</p>
            <ul>
              <li>Executing tasks related to their assigned role and department</li>
              <li>Adhering to all company policies, procedures, and codes of conduct</li>
              <li>Maintaining confidentiality of company information and client data</li>
              <li>Reporting to their designated supervisor</li>
            </ul>

            <h4>3. PROBATION PERIOD</h4>
            <p>The Employee shall serve a probation period of <strong>three (3) months</strong> from the date of commencement. During this period, either party may terminate with one (1) week's written notice.</p>

            <h4>4. CONFIDENTIALITY</h4>
            <p>The Employee agrees to maintain strict confidentiality regarding all proprietary information, trade secrets, client data, financial records, and internal business operations of Welile Technologies Limited, both during and after employment.</p>

            <h4>5. INTELLECTUAL PROPERTY</h4>
            <p>All work product, inventions, and intellectual property created during employment shall be the sole property of Welile Technologies Limited.</p>

            <h4>6. CODE OF CONDUCT</h4>
            <p>The Employee shall:</p>
            <ul>
              <li>Act with integrity and professionalism at all times</li>
              <li>Treat colleagues, clients, and partners with respect</li>
              <li>Avoid conflicts of interest</li>
              <li>Comply with all applicable laws and regulations</li>
              <li>Protect company assets and resources</li>
            </ul>

            <h4>7. DATA PROTECTION</h4>
            <p>The Employee acknowledges that the Company processes personal data in accordance with applicable data protection laws. The Employee consents to the processing of their personal data for employment purposes.</p>

            <h4>8. TERMINATION</h4>
            <p>After the probation period, either party may terminate employment with <strong>one (1) month's</strong> written notice. The Company reserves the right to terminate immediately for gross misconduct.</p>

            <h4>9. NON-COMPETE</h4>
            <p>For a period of <strong>six (6) months</strong> after termination, the Employee shall not engage in any business that directly competes with Welile Technologies Limited within the same market.</p>

            <h4>10. DISPUTE RESOLUTION</h4>
            <p>Any disputes arising from this Contract shall first be resolved through internal mediation. If unresolved, disputes shall be referred to arbitration in accordance with the laws of the Republic of Uganda.</p>

            <h4>11. AUDIT &amp; MONITORING</h4>
            <p>All actions performed by the Employee within company systems are logged and auditable. The Employee consents to monitoring of work-related activities on company platforms.</p>

            <h4>12. ACCEPTANCE</h4>
            <p>By digitally accepting this Contract, the Employee confirms that they have read, understood, and agree to be bound by all terms and conditions herein.</p>
          </div>
        </ScrollArea>

        {!viewOnly && (
          <DialogFooter className="px-5 pb-5 pt-3 border-t space-y-3">
            <label className="flex items-start gap-2 cursor-pointer">
              <Checkbox checked={agreed} onCheckedChange={(v) => setAgreed(!!v)} className="mt-0.5" />
              <span className="text-xs text-muted-foreground leading-snug">
                I have read and agree to all terms and conditions of this Employment Contract.
              </span>
            </label>
            <Button onClick={handleAccept} disabled={!agreed || submitting} className="w-full gap-2">
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
              Accept &amp; Sign Contract
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
});

EmployeeAgreementModal.displayName = 'EmployeeAgreementModal';
export { EmployeeAgreementModal };
export default EmployeeAgreementModal;
