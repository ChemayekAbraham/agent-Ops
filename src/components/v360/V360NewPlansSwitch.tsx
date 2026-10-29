import { useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useV360SetNewPlansEnabled, useV360Settings } from '@/hooks/useV360Plan';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

const CAN_CHANGE = new Set(['cfo', 'coo', 'super_admin']);

/**
 * CFO / COO control for v360_settings.new_plans_enabled.
 * Reads the row and calls v360_set_new_plans_enabled only after a confirm.
 * This screen does not turn the switch on by itself.
 */
export function V360NewPlansSwitch() {
  const { enabledRoles, rolesResolved } = useAuth();
  const canChange = rolesResolved && enabledRoles.some((role) => CAN_CHANGE.has(role));
  const settings = useV360Settings(canChange);
  const setEnabled = useV360SetNewPlansEnabled();
  const [pending, setPending] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!canChange) return null;

  const enabled = settings.data?.new_plans_enabled === true;
  const stateLabel = settings.isLoading ? '…' : settings.isError ? 'Unknown' : enabled ? 'ON' : 'OFF';

  const confirm = async () => {
    if (pending == null) return;
    setError(null);
    try {
      await setEnabled.mutateAsync(pending);
      setPending(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not change the switch.');
    }
  };

  return (
    <section
      className="rounded-xl border border-border bg-card p-4"
      data-testid="v360-new-plans-switch"
      data-state={enabled ? 'on' : 'off'}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-semibold text-foreground">360-day pricing for new Rent Plans</p>
          <p className="text-xs text-muted-foreground">
            {settings.isError
              ? 'The switch could not be read. New Rent Plans stay on current pricing until it loads. Existing Rent Plans are not repriced.'
              : settings.isLoading
              ? 'Reading the switch…'
              : enabled
              ? 'New Rent Plans are stamped with 360-day pricing. Existing Rent Plans keep the terms they already have.'
              : 'OFF. New Rent Plans keep current pricing. Existing Rent Plans are not repriced. This switch does not post ledger entries.'}
          </p>
          {settings.data?.updated_at && (
            <p className="text-[11px] text-muted-foreground">
              Last change {new Date(settings.data.updated_at).toLocaleString('en-GB', { timeZone: 'Africa/Kampala' })} EAT
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          <span
            className={`rounded-md px-2 py-1 text-xs font-bold tracking-wide ${enabled ? 'bg-primary/15 text-primary' : 'bg-muted text-foreground'}`}
            data-testid="v360-switch-state"
          >
            {stateLabel}
          </span>
          <Switch
            checked={enabled}
            disabled={settings.isLoading || settings.isError || setEnabled.isPending}
            onCheckedChange={(next) => { setError(null); setPending(next); }}
            aria-label="360-day pricing for new Rent Plans"
          />
        </div>
      </div>
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}

      <AlertDialog open={pending != null} onOpenChange={(open) => { if (!open && !setEnabled.isPending) setPending(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pending ? 'Turn on 360-day pricing for new Rent Plans?' : 'Turn off 360-day pricing for new Rent Plans?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pending
                ? 'Only Rent Plans created after this change are stamped 360-day. Existing Rent Plans keep their current terms. This does not move money.'
                : 'Rent Plans created after this change stay on current pricing. Plans already stamped 360-day keep those terms. Legacy plans stay unchanged.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={setEnabled.isPending}>Cancel</AlertDialogCancel>
            <Button type="button" disabled={setEnabled.isPending} onClick={confirm}>
              {setEnabled.isPending ? 'Saving…' : pending ? 'Turn on' : 'Turn off'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
