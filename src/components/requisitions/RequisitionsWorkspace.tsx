import { useState, lazy, Suspense } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ChevronDown, ChevronUp, Archive } from 'lucide-react';
import { StaffRequisitionQueue } from './StaffRequisitionQueue';
import { DirectorRequisitionsPanel } from './DirectorRequisitionsPanel';

const ManualRequisitionQueuePanel = lazy(() => import('@/components/financial-ops/ManualRequisitionQueuePanel').then((module) => ({ default: module.ManualRequisitionQueuePanel })));
const RequisitionUsageReportsReview = lazy(() => import('./RequisitionUsageReportsReview').then((module) => ({ default: module.RequisitionUsageReportsReview })));

/**
 * The single requisitions surface for every reviewing dashboard.
 *
 * Live flow: `StaffRequisitionQueue` (My Space -> department head -> COO -> CFO).
 * Manual public-link requests use a separate COO -> CFO queue.
 * Legacy director requisitions stay available read-only for history.
 */
export function RequisitionsWorkspace({ manualStage = 'coo' }: { manualStage?: 'coo' | 'cfo' } = {}) {
  const [showLegacy, setShowLegacy] = useState(false);

  return (
    <div className="space-y-5">
      <Suspense fallback={<Card className="p-4 text-sm text-muted-foreground">Loading manual requisitions…</Card>}>
        <ManualRequisitionQueuePanel stage={manualStage} />
      </Suspense>
      <StaffRequisitionQueue />

      {manualStage === 'cfo' && (
        <Suspense fallback={<Card className="p-4 text-sm text-muted-foreground">Loading accountability reports…</Card>}>
          <RequisitionUsageReportsReview />
        </Suspense>
      )}



      <Card className="rounded-2xl p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="flex items-center gap-2 text-sm font-semibold">
              <Archive className="h-4 w-4 text-muted-foreground" /> Older director requisitions
            </p>
            <p className="text-sm text-muted-foreground">
              History only. New requests now start in My Space.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => setShowLegacy((v) => !v)}>
            {showLegacy ? <ChevronUp className="mr-1 h-4 w-4" /> : <ChevronDown className="mr-1 h-4 w-4" />}
            {showLegacy ? 'Hide history' : 'View history'}
          </Button>
        </div>
        {showLegacy && (
          <div className="mt-4 border-t pt-4">
            <DirectorRequisitionsPanel readOnly />
          </div>
        )}
      </Card>
    </div>
  );
}

export default RequisitionsWorkspace;
