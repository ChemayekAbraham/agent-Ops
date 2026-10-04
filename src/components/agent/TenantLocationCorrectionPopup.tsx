/**
 * Agent login popup — legacy tenant locations that still need matching to the
 * approved Uganda location dataset.
 *
 * Progressive gate: when the popup opens it snapshots how many tenants are
 * listed for this agent. The agent may only close it after at least 60% of that
 * batch (or all of it when 5 or fewer remain) has been successfully saved.
 * Progress is measured from the server-side unmatched count, never from clicks.
 * On the next login the requirement is recalculated from whatever remains, so
 * the agent works the backlog down progressively without losing progress.
 */
import { useEffect, useMemo, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { MapPin, Phone, Loader2, ArrowRight, CheckCircle2, Lock } from 'lucide-react';
import {
  legacyLocationLabel,
  requiredCorrections,
  useTenantLocationCorrections,
  useTenantLocationProgress,
  type TenantLocationCorrectionRow,
} from '@/hooks/useTenantLocationCorrections';
import CorrectTenantLocationDialog from '@/components/location/CorrectTenantLocationDialog';

/** Batch baseline survives reloads so an interrupted session is never reset or double-counted. */
const batchKey = (agentId: string) => `welile.tenantLocationFix.batch:${agentId}`;
/** Closed-for-this-login marker: cleared when the browser session ends (= next login shows it again). */
const closedKey = (agentId: string) => `welile.tenantLocationFix.closed:${agentId}`;

function readBatch(agentId: string): number | null {
  try {
    const raw = localStorage.getItem(batchKey(agentId));
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

interface Props {
  agentId: string;
}

export function TenantLocationCorrectionPopup({ agentId }: Props) {
  const [open, setOpen] = useState(false);
  const [closedThisLogin, setClosedThisLogin] = useState<boolean>(() => {
    try {
      return sessionStorage.getItem(closedKey(agentId)) === '1';
    } catch {
      return false;
    }
  });
  const [baseline, setBaseline] = useState<number | null>(() => readBatch(agentId));
  const [selected, setSelected] = useState<TenantLocationCorrectionRow | null>(null);

  const progress = useTenantLocationProgress(agentId, !closedThisLogin);
  const unmatched = progress.data?.unmatched ?? 0;
  const list = useTenantLocationCorrections({
    agentId,
    pageSize: 200,
    enabled: !closedThisLogin && unmatched > 0,
  });

  // Snapshot the batch the first time we know how many are listed. Kept until the gate is met.
  useEffect(() => {
    if (closedThisLogin || !progress.isSuccess) return;
    if (unmatched > 0 && baseline === null) {
      setBaseline(unmatched);
      try {
        localStorage.setItem(batchKey(agentId), String(unmatched));
      } catch {
        /* best-effort */
      }
    }
  }, [agentId, baseline, closedThisLogin, progress.isSuccess, unmatched]);

  useEffect(() => {
    if (!closedThisLogin && progress.isSuccess && unmatched > 0) setOpen(true);
  }, [closedThisLogin, progress.isSuccess, unmatched]);

  const batch = baseline ?? unmatched;
  const required = requiredCorrections(batch);
  const done = Math.max(0, Math.min(batch, batch - unmatched));
  const pct = batch > 0 ? Math.round((done / batch) * 100) : 0;
  const requiredPct = batch > 0 ? Math.round((required / batch) * 100) : 0;
  const remainingToUnlock = Math.max(0, required - done);
  const unlocked = unmatched === 0 || done >= required;

  const closeIfAllowed = () => {
    if (!unlocked) return;
    try {
      localStorage.removeItem(batchKey(agentId)); // next login starts a fresh batch from what remains
      sessionStorage.setItem(closedKey(agentId), '1');
    } catch {
      /* best-effort */
    }
    setBaseline(null);
    setClosedThisLogin(true);
    setOpen(false);
  };

  if (closedThisLogin || (progress.isSuccess && unmatched === 0 && baseline === null)) return null;

  const rows = list.data?.rows ?? [];

  return (
    <>
      <Dialog open={open} onOpenChange={(v) => (v ? setOpen(true) : closeIfAllowed())}>
        <DialogContent
          className={`w-[calc(100vw-1.5rem)] sm:max-w-2xl max-h-[88vh] flex flex-col rounded-2xl p-0 gap-0 ${
            unlocked ? '' : '[&>button:last-child]:hidden'
          }`}
          onEscapeKeyDown={(e) => {
            if (!unlocked) e.preventDefault();
          }}
          onPointerDownOutside={(e) => {
            if (!unlocked) e.preventDefault();
          }}
          onInteractOutside={(e) => {
            if (!unlocked) e.preventDefault();
          }}
        >
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
                  {done} / {batch} corrected — {pct}%
                </span>
                <span className="text-muted-foreground">{unmatched} left</span>
              </div>
              <Progress value={pct} className="h-2" />
              <p className="text-[11px] text-muted-foreground">
                {unlocked ? (
                  <span className="inline-flex items-center gap-1 text-emerald-600 font-medium">
                    <CheckCircle2 className="h-3 w-3" /> Target met — you can continue, or keep going.
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1">
                    <Lock className="h-3 w-3" /> Correct at least {required} of {batch} ({requiredPct}%) to continue —{' '}
                    {remainingToUnlock} more to go.
                  </span>
                )}
              </p>
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
              {unlocked
                ? 'Anything left will be asked for again next time you sign in.'
                : 'The remaining tenants will carry over to your next sign-in.'}
            </p>
            <Button
              variant={unlocked ? 'default' : 'outline'}
              className="w-full sm:w-auto gap-1.5"
              disabled={!unlocked}
              onClick={closeIfAllowed}
            >
              {unlocked ? (
                'Continue'
              ) : (
                <>
                  <Lock className="h-3.5 w-3.5" /> {remainingToUnlock} more to continue
                </>
              )}
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
