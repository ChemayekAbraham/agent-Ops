/**
 * Tenant details modal for the Calling Center.
 *
 * Presentation only. Pressing "Call" here runs the *existing* dialer path
 * (`dialer.dial(row)`) unchanged — reveal, ringing, statuses, comments and
 * follow-ups all keep behaving exactly as before. This modal simply puts the
 * tenant's relevant detail in front of the officer before the line opens, so
 * the queue list itself can stay lean.
 */
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Loader2, Phone } from 'lucide-react';
import type { CcCallingHub, CcRow } from '@/hooks/useCcCallingHub';
import { TenantCallContextPanel } from './TenantCallContextPanel';

const titleCase = (v?: string | null) => (v ? String(v).replace(/_/g, ' ') : null);

export function TenantCallDetailsDialog({
  hub,
  row,
  open,
  starting,
  canCall,
  wipBlocked,
  onCall,
  onClose,
}: {
  hub: CcCallingHub;
  row: CcRow | null;
  open: boolean;
  starting: boolean;
  canCall: boolean;
  wipBlocked: boolean;
  onCall: (row: CcRow) => void;
  onClose: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[92vh] w-[calc(100vw-1.5rem)] max-w-lg flex-col gap-0 overflow-hidden p-0">
        {row && (
          <>
            <DialogHeader className="space-y-1 border-b bg-muted/30 p-4 text-left">
              <DialogTitle className="truncate text-sm font-bold sm:text-base">{row.name}</DialogTitle>
              <DialogDescription className="flex flex-wrap items-center gap-1.5 text-[11px]">
                {row.district && (
                  <Badge variant="outline" className="text-[10px]">
                    {row.district}
                  </Badge>
                )}
                {row.state && (
                  <Badge variant="outline" className="text-[10px]">
                    {titleCase(row.state)}
                  </Badge>
                )}
                <span className="text-muted-foreground">
                  {row.attempts_made} attempt{row.attempts_made === 1 ? '' : 's'} so far
                </span>
              </DialogDescription>
            </DialogHeader>

            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              <TenantCallContextPanel
                hub={hub}
                subjectId={row.subject_id}
                fallbackName={row.name}
                district={row.district}
                linkedAgent={row.linked_agent}
                phone={null}
                row={row}
              />
            </div>

            <div className="flex items-center gap-2 border-t bg-background p-3">
              <Button type="button" variant="outline" className="h-11 text-xs font-semibold" onClick={onClose}>
                Close
              </Button>
              <Button
                type="button"
                className="h-11 flex-1 text-xs font-semibold"
                disabled={!canCall || starting || wipBlocked}
                onClick={() => onCall(row)}
              >
                {starting ? (
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                ) : (
                  <Phone className="mr-1.5 h-4 w-4" />
                )}
                Call {row.name.split(/\s+/)[0]}
              </Button>
            </div>
            {wipBlocked && (
              <p className="border-t border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] font-semibold text-amber-700">
                You are at the open-attempt limit. Record the outcome of your open calls first.
              </p>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
