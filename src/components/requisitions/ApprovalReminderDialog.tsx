import type { ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';

/**
 * The reminder pop-up: what is waiting, and two buttons only — open the queue, or "Later". It takes no decision and
 * moves no money; approving, declining and paying happen in the queue.
 */
export function ApprovalReminderDialog({
  icon, title, description, snoozeCount, children, openLabel, working, onOpen, onLater,
}: {
  icon: ReactNode;
  title: string;
  description: ReactNode;
  snoozeCount: number;
  children?: ReactNode;
  openLabel: string;
  working: boolean;
  onOpen: () => void;
  onLater: () => void;
}) {
  return (
    <Dialog open onOpenChange={() => { /* closed only by its buttons */ }}>
      <DialogContent
        className="max-h-[90vh] overflow-y-auto sm:max-w-lg [&>button]:hidden"
        onEscapeKeyDown={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">{icon} {title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {snoozeCount > 0 && (
            <Badge variant="outline" className="border-amber-500/30 bg-amber-500/10 text-amber-700">
              Deferred {snoozeCount} {snoozeCount === 1 ? 'time' : 'times'}
            </Badge>
          )}
          {children}
          <div className="space-y-1 pt-1">
            <div className="flex flex-wrap gap-2">
              <Button onClick={onOpen} disabled={working}>{openLabel}</Button>
              <Button variant="outline" onClick={onLater} disabled={working}>
                {working && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Later
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">The next reminder appears in 4 hours if it is still pending.</p>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
