import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ShieldAlert } from 'lucide-react';

interface IssueAdvanceSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
  preselectedAgentId?: string;
}

/**
 * Staff-initiated advance issuance is permanently disabled.
 * Advances can only originate from an agent-submitted request that flows
 * through the standard approval pipeline. This prevents accidental /
 * fat-finger disbursements (e.g. the July 2026 1 UGX test-taps incident).
 */
export default function IssueAdvanceSheet({ open, onOpenChange }: IssueAdvanceSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <ShieldAlert className="h-5 w-5 text-amber-600" />
            Staff-initiated advances are disabled
          </SheetTitle>
          <SheetDescription>
            Only agents can initiate an advance request.
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-4 mt-6">
          <Card className="border-amber-500/30 bg-amber-500/5">
            <CardContent className="p-4 space-y-2 text-sm">
              <p>
                To protect against accidental or fat-finger disbursements,
                staff (including CFO / Manager) can no longer directly issue
                or top-up an agent advance from this panel.
              </p>
              <p>
                Agents must submit an advance request from their own app.
                Requests then flow through the standard approval pipeline
                (Ops → CFO) where they can be reviewed, edited and approved.
              </p>
            </CardContent>
          </Card>

          <Button className="w-full" variant="secondary" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
