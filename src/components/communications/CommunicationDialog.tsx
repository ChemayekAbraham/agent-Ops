import { AlertTriangle, ClipboardCheck, Info, Megaphone, ArrowUpRight, Check } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { communicationTypes, type Communication } from '@/lib/crmCommunications';

export const communicationIcons = { announcement: Megaphone, information: Info, important: AlertTriangle, action: ClipboardCheck };
interface Props {
  communication: Communication | null; open: boolean; onClose: () => void;
  onAcknowledge?: () => void; onNavigate?: () => void; pending?: boolean; error?: string | null; preview?: boolean;
}
export function CommunicationDialog({ communication, open, onClose, onAcknowledge, onNavigate, pending, error, preview }: Props) {
  if (!communication) return null;
  const Icon = communicationIcons[communication.communication_type] ?? Info;
  const type = communicationTypes[communication.communication_type] ?? communicationTypes.information;
  return <Dialog open={open} onOpenChange={(next) => { if (!next && !pending) onClose(); }}>
    <DialogContent stable overlayClassName="backdrop-blur-none data-[state=open]:animate-none data-[state=closed]:animate-none" className="w-[calc(100%-2rem)] rounded-lg sm:rounded-lg" data-communication-dialog="true">
      <DialogHeader className="text-left pr-10">
        <div className="flex items-center gap-2 text-sm text-muted-foreground"><Icon aria-hidden="true" className={`h-5 w-5 shrink-0 ${communication.communication_type === 'important' ? 'text-destructive' : 'text-primary'}`} />{type.label}{preview && <span>· Preview</span>}</div>
        <DialogTitle className="pt-3 leading-snug tracking-normal break-words text-xl">{communication.title}</DialogTitle>
      </DialogHeader>
      <DialogDescription className="whitespace-pre-wrap break-words text-base leading-relaxed text-foreground">{communication.body}</DialogDescription>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <DialogFooter className="flex-row flex-wrap justify-end">
        <Button variant="outline" onClick={onClose} disabled={pending}>Close</Button>
        {!preview && !communication.acknowledged_at && onAcknowledge && <Button onClick={onAcknowledge} disabled={pending}><Check className="h-4 w-4 mr-2" />{pending ? 'Saving…' : 'Acknowledge'}</Button>}
        {communication.link_path && <Button variant={communication.communication_type === 'action' ? 'default' : 'secondary'} onClick={preview ? onClose : onNavigate} disabled={pending}><ArrowUpRight className="h-4 w-4 mr-2" />{communication.communication_type === 'information' ? 'View details' : 'Open'}</Button>}
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
