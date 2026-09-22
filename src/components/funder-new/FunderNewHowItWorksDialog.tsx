import { CheckCircle2, ClipboardCheck, Home, LineChart, Send } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';

const STEPS = [
  { icon: Home, title: 'Choose a house', text: 'Browse empty houses or houses that already have a ready tenant.' },
  { icon: ClipboardCheck, title: 'Review your support amount', text: 'Check the amount for each home and your total before anything is submitted.' },
  { icon: Send, title: 'Submit for approval', text: 'Your support plan goes to the team for the normal review step.' },
  { icon: CheckCircle2, title: 'Support becomes active', text: 'Once approved, support becomes active through the existing process.' },
  { icon: LineChart, title: 'Track it in your portfolio', text: 'Follow your supported homes and returns from your portfolio.' },
];

export function FunderNewHowItWorksDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto rounded-2xl">
        <DialogHeader>
          <DialogTitle>How support works</DialogTitle>
          <DialogDescription>Five simple steps, from picking a home to tracking returns.</DialogDescription>
        </DialogHeader>

        <ol className="space-y-3">
          {STEPS.map((step, index) => (
            <li key={step.title} className="flex gap-3 rounded-2xl border bg-primary/5 p-4">
              <span className="flex h-10 w-10 flex-none items-center justify-center rounded-full bg-primary text-primary-foreground">
                <step.icon className="h-5 w-5" />
              </span>
              <div className="min-w-0">
                <p className="text-sm font-semibold">
                  {index + 1}. {step.title}
                </p>
                <p className="mt-1 text-sm text-muted-foreground">{step.text}</p>
              </div>
            </li>
          ))}
        </ol>

        <p className="rounded-2xl border bg-muted/40 p-4 text-sm text-muted-foreground">
          Selecting and reviewing homes here is just planning. Nothing is funded until you confirm and the existing
          approval step is completed. Returns shown are estimates based on the current 15% rate.
        </p>
      </DialogContent>
    </Dialog>
  );
}

export default FunderNewHowItWorksDialog;
