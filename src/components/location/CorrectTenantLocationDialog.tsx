/**
 * Location-only correction dialog.
 *
 * Shows the tenant's old typed address as read-only context and requires a fresh
 * pick from the approved Uganda dataset (the shared UgLocationPicker). Saving
 * touches nothing but the location fields — status, agent, rent and payments are
 * never part of the request.
 */
import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Loader2, MapPin, Phone, Check } from 'lucide-react';
import { toast } from 'sonner';
import UgLocationPicker from '@/components/location/UgLocationPicker';
import { ugLocationLabel, type UgLocationSelection } from '@/hooks/useUgLocations';
import { useCorrectTenantLocation } from '@/hooks/useTenantLocationCorrections';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tenant: {
    id: string;
    name: string | null;
    phone?: string | null;
    /** Old typed address, shown read-only so the agent knows what to match. */
    legacyLabel?: string;
    districtHint?: string | null;
  } | null;
  onCorrected?: (tenantId: string) => void;
  /** When true the dialog cannot be closed until a location is saved. */
  forced?: boolean;
}

export function CorrectTenantLocationDialog({ open, onOpenChange, tenant, onCorrected, forced }: Props) {
  const [selection, setSelection] = useState<UgLocationSelection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const correct = useCorrectTenantLocation();

  useEffect(() => {
    if (open) {
      setSelection(null);
      setError(null);
    }
  }, [open, tenant?.id]);

  const save = async () => {
    if (!tenant) return;
    if (!selection) {
      setError('Choose the tenant’s village from the approved list');
      return;
    }
    try {
      const res = await correct.mutateAsync({ tenantId: tenant.id, villageId: selection.villageId });
      toast.success('Location corrected', { description: res?.full_path ?? ugLocationLabel(selection) });
      onCorrected?.(tenant.id);
      onOpenChange(false);
    } catch (e: any) {
      const msg = e?.message || 'Could not save the location. Please try again.';
      setError(msg);
      toast.error('Location not saved', { description: msg });
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => (correct.isPending || (forced && !v) ? null : onOpenChange(v))}>
      <DialogContent
        className={`w-[calc(100vw-1.5rem)] sm:max-w-lg max-h-[90vh] overflow-y-auto rounded-2xl ${forced ? '[&>button.absolute]:hidden' : ''}`}
        onEscapeKeyDown={(e) => forced && e.preventDefault()}
        onPointerDownOutside={(e) => forced && e.preventDefault()}
        onInteractOutside={(e) => forced && e.preventDefault()}
      >
        <DialogHeader className="text-left">
          <DialogTitle className="flex items-center gap-2 text-base sm:text-lg">
            <MapPin className="h-4 w-4 text-primary shrink-0" />
            <span className="truncate">{tenant?.name || 'Tenant'}</span>
          </DialogTitle>
          <DialogDescription className="text-xs sm:text-sm">
            Only the location is updated. Nothing else about this tenant changes.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {tenant?.phone && (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Phone className="h-3.5 w-3.5" /> {tenant.phone}
            </p>
          )}

          <div className="rounded-xl border bg-muted/40 p-3">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Currently on record
            </p>
            <p className="mt-1 text-sm font-medium break-words">
              {tenant?.legacyLabel || 'No location on record'}
            </p>
          </div>

          <UgLocationPicker
            value={selection}
            onChange={(sel) => {
              setSelection(sel);
              setError(null);
            }}
            label="Correct location"
            required
            error={error}
            districtName={tenant?.districtHint ?? null}
          />

          {selection && (
            <div className="rounded-xl border border-primary/30 bg-primary/5 p-3">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-primary">Will be saved as</p>
              <p className="mt-1 text-sm font-medium break-words">{ugLocationLabel(selection)}</p>
            </div>
          )}
        </div>

        <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 pt-2">
          {!forced && (
            <Button
              variant="outline"
              className="w-full sm:w-auto"
              onClick={() => onOpenChange(false)}
              disabled={correct.isPending}
            >
              Cancel
            </Button>
          )}
          <Button className="w-full sm:w-auto gap-1.5" onClick={save} disabled={!selection || correct.isPending}>
            {correct.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            Save location
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default CorrectTenantLocationDialog;
