import { useState } from 'react';
import { format } from 'date-fns';
import { Loader2, Percent } from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useAuth } from '@/hooks/useAuth';
import {
  PARTNER_RETURN_POLICY_SWITCH_ROLES, partnerRateErrorText,
  usePartnerReturnPolicyDetail, useSetPartnerReturnPolicy,
} from '@/hooks/usePartnerRateApprovals';
import { formatRatePct, rateOrNull } from '@/lib/partnerReturnPolicy';

const when = (iso: string | null | undefined) => (iso ? format(new Date(iso), 'd MMM yyyy, HH:mm') : '—');

/**
 * The partner Returns switch (partner_return_policy). Shows what new partners earn now;
 * only the CEO can turn it on or off, after a confirmation that spells out the owner's rule (6 Nov).
 * The database re-checks the role and the authenticator step on every change.
 */
export function PartnerReturnPolicyCard() {
  const { enabledRoles } = useAuth();
  const canSwitch = (enabledRoles ?? []).some((r) => (PARTNER_RETURN_POLICY_SWITCH_ROLES as readonly string[]).includes(r));
  const policy = usePartnerReturnPolicyDetail();
  const setPolicy = useSetPartnerReturnPolicy();
  const [target, setTarget] = useState<boolean | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const p = policy.data;
  // A missing or unusable rate shows "—" (never a 0 or a guessed rate).
  const policyRate = formatRatePct(rateOrNull(p?.policy_rate)) ?? '—';
  const legacyRate = formatRatePct(rateOrNull(p?.legacy_rate)) ?? '—';
  /** For the "New contracts earn" line (Gemini: point the JSX at this). */
  const newContractRatePct = formatRatePct(rateOrNull(p?.new_contract_rate)) ?? '—';

  const close = () => { if (!setPolicy.isPending) { setTarget(null); setNote(''); setError(null); } };

  const confirm = async () => {
    if (target == null) return;
    setError(null);
    try {
      const next = await setPolicy.mutateAsync({ enabled: target, note });
      const nextRate = formatRatePct(rateOrNull(next.new_contract_rate));
      toast.success(next.enabled ? 'Partner Rent profit share switch is on' : 'Partner Rent profit share switch is off', {
        description: nextRate ? `New contracts now earn ${nextRate}.` : undefined,
      });
      setTarget(null); setNote('');
    } catch (e) {
      setError(partnerRateErrorText(e));
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Percent className="h-4 w-4 text-primary" /> Partner Rent profit share rate for new contracts
        </CardTitle>
        <CardDescription>
          While the switch is on, new partners earn the new-partner rate; existing partners keep their own rate, employees earn 20% and renewals keep their rate.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {policy.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading the partner Rent profit share policy…</p>
        ) : policy.isError || !p ? (
          <div role="alert" className="space-y-2">
            <p className="text-sm text-destructive">{policy.isError ? partnerRateErrorText(policy.error) : 'Policy unavailable.'}</p>
            <Button variant="outline" size="sm" onClick={() => void policy.refetch()}>Retry</Button>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Badge variant={p.enabled ? 'default' : 'secondary'}>{p.enabled ? 'On' : 'Off'}</Badge>
                <span className="text-sm">
                  New contracts earn <strong className="tabular-nums">{newContractRatePct}</strong>
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Label htmlFor="partner-returns-switch" className="text-sm">Partner Rent profit share switch</Label>
                <Switch
                  id="partner-returns-switch"
                  checked={p.enabled}
                  disabled={!canSwitch || setPolicy.isPending}
                  onCheckedChange={(checked) => { setError(null); setTarget(checked); }}
                />
              </div>
            </div>
            <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              {[
                ['Rate when on', policyRate],
                ['Legacy rate (off)', legacyRate],
                ['On since', p.enabled ? when(p.enabled_at) : '—'],
                ['Last changed', when(p.updated_at)],
              ].map(([label, value]) => (
                <div key={label} className="min-w-0">
                  <dt className="text-xs text-muted-foreground">{label}</dt>
                  <dd className="tabular-nums break-words">{value}</dd>
                </div>
              ))}
            </dl>
            {!canSwitch && (
              <p className="text-xs text-muted-foreground">Only the CEO can turn this switch on or off.</p>
            )}
          </>
        )}
      </CardContent>

      <AlertDialog open={target != null} onOpenChange={(open) => { if (!open) close(); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{target ? 'Turn the partner Rent profit share switch on?' : 'Turn the partner Rent profit share switch off?'}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              {target ? (
                <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                  <li>New partners earn the new-partner rate ({policyRate}) from the cut-off. The cut-off is set the first time the switch goes on and never moves.</li>
                  <li>Existing partners keep their own rate on new portfolios, with no cap.</li>
                  <li>Employees earn 20%.</li>
                  <li>Renewals keep their rate. Top-ups and existing portfolios keep their own rate too.</li>
                  <li>If staff type a rate different from the person&apos;s rate, the portfolio is stored at the person&apos;s rate and the typed rate waits for the CFO; an approved rate applies from the next cycle.</li>
                </ul>
              ) : (
                <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                  <li>New contracts go back to {legacyRate}.</li>
                  <li>Renewals keep their current rate.</li>
                  <li>Typed rates are no longer held for the CFO. Requests already in the queue stay there and can still be decided.</li>
                  <li>Portfolios already opened keep their stored rate. If the switch goes on again, the first cut-off still applies.</li>
                </ul>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="partner-returns-note">Note (optional)</Label>
            <Textarea id="partner-returns-note" value={note} onChange={(e) => setNote(e.target.value)} disabled={setPolicy.isPending} />
          </div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={setPolicy.isPending}>Cancel</AlertDialogCancel>
            <Button onClick={() => void confirm()} disabled={setPolicy.isPending}>
              {setPolicy.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {target ? 'Turn on' : 'Turn off'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

export default PartnerReturnPolicyCard;
