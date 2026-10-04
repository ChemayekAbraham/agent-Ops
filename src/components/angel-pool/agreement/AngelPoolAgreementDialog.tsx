import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ANGEL_POOL_AGREEMENT_TEXT, ANGEL_POOL_AGREEMENT_VERSION } from './AngelPoolAgreementContent';
import { Badge } from '@/components/ui/badge';
import { Loader2, FileText } from 'lucide-react';

interface Props {
  open: boolean;
  onAccept: () => void;
  onClose: () => void;
  isLoading: boolean;
}

export function AngelPoolAgreementDialog({ open, onAccept, onClose, isLoading }: Props) {
  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-lg max-h-[90vh] flex flex-col p-0 gap-0">
        <DialogHeader className="px-5 pt-5 pb-3 border-b border-border/50">
          <div className="flex items-center gap-2">
            <div className="p-2 rounded-xl bg-primary/10">
              <FileText className="h-4 w-4 text-primary" />
            </div>
            <div>
              <DialogTitle className="text-base font-black">Angel Pool Agreement</DialogTitle>
              <DialogDescription className="text-[11px] mt-0.5">
                Please read and accept to continue
              </DialogDescription>
            </div>
          </div>
          <Badge variant="secondary" className="text-[10px] w-fit mt-1">{ANGEL_POOL_AGREEMENT_VERSION}</Badge>
        </DialogHeader>

        <ScrollArea className="flex-1 min-h-0 px-5 py-4" style={{ maxHeight: '50vh' }}>
          <pre className="whitespace-pre-wrap text-xs font-mono leading-relaxed text-foreground/85">
            {ANGEL_POOL_AGREEMENT_TEXT}
          </pre>
        </ScrollArea>

        <div className="px-5 py-4 border-t border-border/50">
          <Button onClick={onAccept} disabled={isLoading} className="w-full h-11 text-sm font-bold rounded-xl">
            {isLoading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
            I Agree — Accept & Sign
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
