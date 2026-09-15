import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FileText, ArrowRight, Clock, CheckCircle, TrendingUp } from 'lucide-react';
import { usePromissoryOpsReport } from '@/hooks/usePromissoryOpsReport';
import { formatUGX } from '@/lib/rentCalculations';

/**
 * Prominent overview entry point for the Promissory Notes workspace.
 * Surfaces live queue stats so Partner Ops can see workload at a glance.
 */
export function PromissoryNotesOverviewCard({ onOpen }: { onOpen: () => void }) {
  const { report, isLoading } = usePromissoryOpsReport();
  const { kpis, notes } = report;

  const pendingNotes = notes.filter((n) => n.status === 'pending').length;
  const approvedNotes = kpis.approved_notes ?? notes.filter((n) => n.status === 'approved').length;

  return (
    <Card
      className="border-primary/30 bg-primary/5 cursor-pointer hover:bg-primary/10 transition-colors"
      onClick={onOpen}
      role="button"
      aria-label="Open Promissory Notes"
    >
      <CardContent className="p-4 sm:p-5 space-y-3">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-primary/10 shrink-0">
            <FileText className="h-6 w-6 text-primary" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <p className="text-base font-bold">Promissory Notes</p>
              {!isLoading && (
                <Badge variant="secondary" className="text-xs">
                  {kpis.notes_count.toLocaleString()} total
                </Badge>
              )}
              {pendingNotes > 0 && (
                <Badge variant="destructive" className="text-xs">
                  {pendingNotes.toLocaleString()} pending
                </Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              Review partner commitments, approve notes &amp; track collections
            </p>
          </div>
          <Button size="sm" className="gap-1.5 shrink-0" onClick={(e) => { e.stopPropagation(); onOpen(); }}>
            Open <ArrowRight className="h-4 w-4" />
          </Button>
        </div>

        <div className="grid grid-cols-3 gap-2">
          <div className="rounded-lg border bg-background/60 p-2.5">
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <Clock className="h-3.5 w-3.5" />
              <span className="text-[10px] font-medium uppercase tracking-wide">Awaiting review</span>
            </div>
            <p className="text-sm font-bold mt-1">{isLoading ? '…' : pendingNotes.toLocaleString()}</p>
          </div>
          <div className="rounded-lg border bg-background/60 p-2.5">
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <CheckCircle className="h-3.5 w-3.5" />
              <span className="text-[10px] font-medium uppercase tracking-wide">Approved</span>
            </div>
            <p className="text-sm font-bold mt-1">{isLoading ? '…' : approvedNotes.toLocaleString()}</p>
          </div>
          <div className="rounded-lg border bg-background/60 p-2.5">
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <TrendingUp className="h-3.5 w-3.5" />
              <span className="text-[10px] font-medium uppercase tracking-wide">Promised</span>
            </div>
            <p className="text-sm font-bold mt-1 truncate">{isLoading ? '…' : formatUGX(kpis.promised_total)}</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
