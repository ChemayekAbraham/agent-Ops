import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Play } from 'lucide-react';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useIsMobile } from '@/hooks/use-mobile';
import { formatUGX } from '@/lib/creditFeeCalculations';
import { claimForRequisition } from '../api';
import TutorialPlayerDialog, { formatDuration, type TutorialPlayerVideo } from './TutorialPlayerDialog';

interface ClaimVideo extends TutorialPlayerVideo { my_max_position_seconds: number }
interface Claim { claim_id: string; claim_code: string; total_amount: number; requisition_amount: number | null; videos: ClaimVideo[] }

interface Props { requisitionId: string; open: boolean; onOpenChange: (open: boolean) => void }

export default function TutorialClaimSheet({ requisitionId, open, onOpenChange }: Props) {
  const isMobile = useIsMobile();
  const [claim, setClaim] = useState<Claim | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState<ClaimVideo | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { setClaim((await claimForRequisition(requisitionId)) as Claim | null); }
    catch (e) { setError(e instanceof Error ? e.message : 'Unable to load tutorial videos.'); }
    finally { setLoading(false); }
  }, [requisitionId]);

  useEffect(() => { if (open) void load(); }, [open, load]);

  const videos = claim?.videos ?? [];
  const total = Number(claim?.total_amount ?? 0);
  const reqAmount = claim?.requisition_amount == null ? null : Number(claim.requisition_amount);

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side={isMobile ? 'bottom' : 'right'} className={isMobile ? 'max-h-[88vh] overflow-y-auto' : 'w-full sm:max-w-lg overflow-y-auto'}>
          <SheetHeader className="text-left">
            <SheetTitle>Tutorial videos</SheetTitle>
            <SheetDescription>
              {claim ? `${claim.claim_code} • ${videos.length} video${videos.length === 1 ? '' : 's'} • ${formatUGX(total)}` : 'Videos linked to this requisition'}
            </SheetDescription>
          </SheetHeader>

          <div className="mt-4 space-y-3">
            {loading && <p role="status" className="text-sm text-muted-foreground">Loading…</p>}
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            {!loading && !error && !claim && (
              <p className="py-6 text-center text-sm text-muted-foreground">No tutorial videos are linked to this requisition.</p>
            )}
            {claim && reqAmount != null && reqAmount !== total && (
              <div className="flex gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm text-foreground">
                <AlertTriangle className="h-4 w-4 shrink-0 text-warning mt-0.5" />
                <span>Requisition amount {formatUGX(reqAmount)} differs from the claim total {formatUGX(total)}.</span>
              </div>
            )}
            {videos.map((v) => {
              const d = Number(v.duration_seconds) || 0;
              const pct = d ? Math.min(100, Math.round((Number(v.my_max_position_seconds) / d) * 100)) : 0;
              return (
                <div key={v.id ?? (v as any).video_id} className="flex items-center gap-3 rounded-md border border-border p-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium break-words">{v.video_code} • {v.title}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <span>{formatDuration(d)}</span>
                      <Badge variant={pct >= 100 ? 'default' : 'secondary'}>You watched {pct}%</Badge>
                    </div>
                  </div>
                  <Button size="sm" onClick={() => setPlaying({ ...v, id: (v as any).video_id ?? v.id })}>
                    <Play className="mr-1 h-4 w-4" />Play
                  </Button>
                </div>
              );
            })}
          </div>
        </SheetContent>
      </Sheet>
      <TutorialPlayerDialog
        video={playing}
        context="approval"
        requisitionId={requisitionId}
        open={!!playing}
        onOpenChange={(o) => { if (!o) { setPlaying(null); void load(); } }}
      />
    </>
  );
}
