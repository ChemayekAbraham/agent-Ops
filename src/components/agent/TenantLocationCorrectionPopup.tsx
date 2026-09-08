/**
 * Agent login popup — legacy tenant locations that still need matching to the
 * approved Uganda location dataset.
 *
 * Dismissible: closing it stores a timestamp per agent so the agent can carry on
 * working and come back later. It never shows when the agent has nothing left to
 * correct, and tenants registered with the approved picker never appear.
 */
import { useEffect, useMemo, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { MapPin, Phone, Loader2, ArrowRight, CheckCircle2 } from 'lucide-react';
import {
  legacyLocationLabel,
  useTenantLocationCorrections,
  useTenantLocationProgress,
  type TenantLocationCorrectionRow,
} from '@/hooks/useTenantLocationCorrections';
import CorrectTenantLocationDialog from '@/components/location/CorrectTenantLocationDialog';

const DISMISS_HOURS = 12;
const key = (agentId: string) => `welile.tenantLocationFix.dismissedAt:${agentId}`;

interface Props {
  agentId: string;
}

export function TenantLocationCorrectionPopup({ agentId }: Props) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<TenantLocationCorrectionRow | null>(null);

  const suppressed = useMemo(() => {
    try {
      const raw = localStorage.getItem(key(agentId));
      if (!raw) return false;
      return Date.now() - Number(raw) < DISMISS_HOURS * 60 * 60 * 1000;
    } catch {
      return false;
    }
  }, [agentId]);

  const progress = useTenantLocationProgress(agentId, !suppressed);
  const list = useTenantLocationCorrections({
    agentId,
    pageSize: 50,
    enabled: !suppressed && (progress.data?.unmatched ?? 0) > 0,
  });

  const unmatched = progress.data?.unmatched ?? 0;
  const total = progress.data?.total_tenants ?? 0;
  const corrected = progress.data?.matched ?? 0;
  const pct = total > 0 ? Math.round((corrected / total) * 100) : 0;

  useEffect(() => {
    if (!suppressed && unmatched > 0) setOpen(true);
  }, [suppressed, unmatched]);

  const dismiss = () => {
    try {
      localStorage.setItem(key(agentId), String(Date.now()));
    } catch {
      /* dismissal is best-effort only */
    }
    setOpen(false);
  };

  if (suppressed || unmatched === 0) return null;

  const rows = list.data?.rows ?? [];

  return (
    <>
      <Dialog open={open} onOpenChange={(v) => (v ? setOpen(true) : dismiss())}>
        <DialogContent className="w-[calc(100vw-1.5rem)] sm:max-w-2xl max-h-[88vh] flex flex-col rounded-2xl p-0 gap-0">
          <DialogHeader className="text-left p-4 sm:p-5 pb-3 border-b">
            <DialogTitle className="flex items-center gap-2 text-base sm:text-lg">
              <MapPin className="h-4 w-4 text-primary shrink-0" />
              Fix tenant locations
            </DialogTitle>
            <DialogDescription className="text-xs sm:text-sm">
              These tenants were saved before the approved location list. Pick the correct village for each one —
              nothing else about the tenant changes.
            </DialogDescription>

            <div className="mt-3 space-y-1.5">
              <div className="flex items-center justify-between text-xs font-semibold">
                <span>
                  {corrected} of {total} corrected
                </span>
                <span className="text-muted-foreground">{unmatched} left</span>
              </div>
              <Progress value={pct} className="h-2" />
            </div>
          </DialogHeader>

          <div className="flex-1 overflow-y-auto p-3 sm:p-4 space-y-2">
            {list.isLoading && (
              <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading your tenants…
              </div>
            )}

            {!list.isLoading && rows.length === 0 && (
              <div className="flex flex-col items-center gap-2 py-10 text-center">
                <CheckCircle2 className="h-6 w-6 text-emerald-600" />
                <p className="text-sm font-semibold">All caught up</p>
                <p className="text-xs text-muted-foreground">Every tenant you handle is on the approved list.</p>
              </div>
            )}

            {rows.map((row) => (
              <button
                key={row.tenant_id}
                type="button"
                onClick={() => setSelected(row)}
                className="w-full text-left rounded-xl border bg-card p-3 hover:border-primary/50 hover:bg-accent/40 transition-colors"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold truncate">{row.tenant_name || 'Unnamed tenant'}</p>
                    {row.tenant_phone && (
                      <p className="mt-0.5 flex items-center gap-1 text-[11px] text-muted-foreground">
                        <Phone className="h-3 w-3" /> {row.tenant_phone}
                      </p>
                    )}
                    <p className="mt-1 text-xs text-muted-foreground break-words">{legacyLocationLabel(row)}</p>
                  </div>
                  <span className="shrink-0 inline-flex items-center gap-1 rounded-full bg-primary/10 px-2.5 py-1 text-[11px] font-semibold text-primary">
                    Fix <ArrowRight className="h-3 w-3" />
                  </span>
                </div>
              </button>
            ))}
          </div>

          <div className="border-t p-3 sm:p-4 flex flex-col-reverse sm:flex-row sm:justify-between gap-2">
            <p className="text-[11px] text-muted-foreground sm:self-center">
              You can close this and come back to it any time.
            </p>
            <Button variant="outline" className="w-full sm:w-auto" onClick={dismiss}>
              Do this later
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <CorrectTenantLocationDialog
        open={!!selected}
        onOpenChange={(v) => !v && setSelected(null)}
        tenant={
          selected
            ? {
                id: selected.tenant_id,
                name: selected.tenant_name,
                phone: selected.tenant_phone,
                legacyLabel: legacyLocationLabel(selected),
                districtHint: null,
              }
            : null
        }
        onCorrected={() => setSelected(null)}
      />
    </>
  );
}

export default TenantLocationCorrectionPopup;
