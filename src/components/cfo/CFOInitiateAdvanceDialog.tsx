import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Loader2, ShieldAlert, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { UserSearchPicker } from '@/components/cfo/UserSearchPicker';
import {
  formatUGX,
  calculateAccessFeeSimple,
  calculateRegistrationFee,
  installmentCount,
  frequencyLabel,
  REPAYMENT_FREQUENCIES,
  type RepaymentFrequency,
} from '@/lib/agentAdvanceCalculations';
import { disburseAgentAdvanceRequest } from '@/lib/disburseAgentAdvance';
import { DuplicateAccountAlert, useAgentDuplicateMap } from '@/components/ops/DuplicateAccountAlert';
import { CfoApprovalGate } from '@/components/cfo/CfoApprovalGate';

/**
 * Fat-finger guardrails. These are ADVISORY: the CFO may issue outside them, but only
 * by ticking the override and writing down why — which is then recorded on the request
 * and in audit_logs. The database enforces the same rule from the other side
 * (`aaa_guard_advance_gate_override`): the override flag is rejected outright unless
 * the caller actually holds cfo/ceo/super_admin/admin.
 */
const MIN_PRINCIPAL = 50_000;
const MAX_PRINCIPAL = 3_000_000;
const STEP = 1_000;
const MIN_REASON = 15;
const MIN_OVERRIDE_REASON = 10;

interface GateSnapshot {
  gates: string[];
  labels: string[];
  blocked: boolean;
}

const RATE_OPTIONS = [
  { label: '33% / month (standard)', value: '33' },
  { label: '28% / month', value: '28' },
  { label: '25% / month', value: '25' },
  { label: 'Custom rate…', value: 'custom' },
];
const CYCLE_OPTIONS = ['7', '14', '30', '60', '90'];

interface Props {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSuccess?: () => void;
}

export function CFOInitiateAdvanceDialog({ open, onOpenChange, onSuccess }: Props) {
  const { user } = useAuth();
  const [agent, setAgent] = useState<{ id: string; full_name: string; phone: string } | null>(null);
  const [amount, setAmount] = useState('');
  const [cycleDays, setCycleDays] = useState('30');
  const [ratePreset, setRatePreset] = useState('33');
  const [customRate, setCustomRate] = useState('33');
  const [frequency, setFrequency] = useState<RepaymentFrequency>('daily');
  const [recoverySource, setRecoverySource] = useState<'wallet_daily' | 'roi'>('wallet_daily');
  const [roiPercent, setRoiPercent] = useState('20');
  const [reason, setReason] = useState('');
  const [confirmAmount, setConfirmAmount] = useState('');
  const [ackRisk, setAckRisk] = useState(false);
  const [overrideGates, setOverrideGates] = useState(false);
  const [overrideReason, setOverrideReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const reset = () => {
    setAgent(null); setAmount(''); setCycleDays('30');
    setRatePreset('33'); setCustomRate('33'); setFrequency('daily');
    setReason(''); setConfirmAmount(''); setAckRisk(false);
    setOverrideGates(false); setOverrideReason('');
  };

  useEffect(() => { if (!open) reset(); }, [open]);

  const { data: duplicateMap = {} } = useAgentDuplicateMap(agent ? [agent.id] : []);

  const principal = Number(String(amount).replace(/[^0-9]/g, '')) || 0;
  const days = Number(cycleDays);
  const ratePct = ratePreset === 'custom' ? Number(customRate) : Number(ratePreset);
  const rateValid = Number.isFinite(ratePct) && ratePct >= 0 && ratePct <= 100;
  const monthlyRate = rateValid ? ratePct / 100 : 0;
  // Simple pro-rata, matching what cfo_create_advance writes and what disbursement
  // recomputes. The compound `calculateAccessFee` would show the operator a figure the
  // database then silently replaces on any cycle other than 30 days.
  const accessFee = principal > 0 ? calculateAccessFeeSimple(principal, days, monthlyRate) : 0;
  const registrationFee = principal > 0 ? calculateRegistrationFee(principal) : 0;
  const totalPayable = principal + accessFee + registrationFee;
  const installments = installmentCount(days, frequency);
  const installment = principal > 0 ? Math.ceil(totalPayable / installments) : 0;

  // Every gate the database would raise, asked BEFORE the form is filled in rather
  // than discovered at submit. Same function the RPC records on the audit row.
  const [checking, setChecking] = useState(false);
  const [gateSnapshot, setGateSnapshot] = useState<GateSnapshot | null>(null);
  const [limit, setLimit] = useState<number | null>(null);

  useEffect(() => {
    if (!agent) { setGateSnapshot(null); setLimit(null); return; }
    let active = true;
    const t = setTimeout(() => {
      (async () => {
        setChecking(true);
        try {
          const [{ data: gates, error: gateErr }, { data: limitRows }] = await Promise.all([
            supabase.rpc('agent_advance_blocking_gates' as any, {
              p_agent_id: agent.id,
              p_principal: principal > 0 ? principal : null,
              p_monthly_rate: rateValid ? monthlyRate : null,
            } as any),
            supabase.rpc('get_agent_advance_limits' as any, {
              _search: agent.phone || agent.full_name, _limit: 25, _offset: 0,
            } as any),
          ]);
          if (!active) return;
          if (gateErr) throw gateErr;
          const g = (gates as any) || {};
          setGateSnapshot({
            gates: Array.isArray(g.gates) ? g.gates : [],
            labels: Array.isArray(g.labels) ? g.labels : [],
            blocked: !!g.blocked,
          });
          const row = (limitRows as any[] | null)?.find((r) => r.agent_id === agent.id);
          setLimit(row ? Number(row.total_limit || 0) : null);
        } catch (e: any) {
          if (!active) return;
          setGateSnapshot({
            gates: ['check_failed'],
            labels: [e.message || 'Eligibility check failed — treat as blocked.'],
            blocked: true,
          });
        }
        if (active) setChecking(false);
      })();
    }, 250);
    return () => { active = false; clearTimeout(t); };
  }, [agent, principal, monthlyRate, rateValid]);

  const overLimit = limit !== null && principal > limit;

  /** Shape errors are never overridable — the request would be nonsense. */
  const amountErrors = useMemo(() => {
    const errs: string[] = [];
    if (principal <= 0) errs.push('Enter an amount.');
    return errs;
  }, [principal]);

  /** Policy bounds — overridable by the CFO with a written reason. */
  const amountWarnings = useMemo(() => {
    if (principal <= 0) return [];
    const warns: string[] = [];
    if (principal < MIN_PRINCIPAL) warns.push(`Below the ${formatUGX(MIN_PRINCIPAL)} standard minimum.`);
    if (principal > MAX_PRINCIPAL) warns.push(`Above the ${formatUGX(MAX_PRINCIPAL)} standard maximum for staff-initiated advances.`);
    if (principal % STEP !== 0) warns.push(`Not a multiple of ${formatUGX(STEP)}.`);
    return warns;
  }, [principal]);

  /** Everything the CFO is being asked to knowingly step over. */
  const overrideItems = useMemo(() => {
    const items = [...(gateSnapshot?.labels ?? []), ...amountWarnings];
    if (overLimit) items.push(`Above the agent's computed limit of ${formatUGX(limit || 0)}.`);
    return items;
  }, [gateSnapshot, amountWarnings, overLimit, limit]);

  const needsOverride = overrideItems.length > 0;
  const overrideReasonOk = overrideReason.trim().length >= MIN_OVERRIDE_REASON;

  const roiPercentNum = Number(roiPercent);
  const recoveryValid =
    recoverySource !== 'roi' ||
    (Number.isFinite(roiPercentNum) && roiPercentNum > 0 && roiPercentNum <= 100);

  const canSubmit =
    !!agent &&
    !checking &&
    amountErrors.length === 0 &&
    rateValid &&
    recoveryValid &&
    reason.trim().length >= MIN_REASON &&
    ackRisk &&
    (!needsOverride || (overrideGates && overrideReasonOk)) &&
    confirmAmount.replace(/[^0-9]/g, '') === String(principal) &&
    !submitting;

  const handleSubmit = async () => {
    if (!canSubmit || !agent || !user?.id) return;
    setSubmitting(true);
    const usedOverride = needsOverride && overrideGates;
    try {
      // 1. Create the originating request through the privileged RPC. It authorises the
      //    caller, stamps the override (with the gates it bypassed) and writes audit_logs
      //    in one transaction — the frontend can no longer set any of that on its own.
      const { data: created, error: reqErr } = await supabase.rpc('cfo_create_advance' as any, {
        p_agent_id: agent.id,
        p_principal: principal,
        p_cycle_days: days,
        p_monthly_rate: monthlyRate,
        p_repayment_frequency: frequency,
        p_reason: reason.trim(),
        p_override: usedOverride,
        p_override_reason: usedOverride ? overrideReason.trim() : null,
      } as any);
      if (reqErr) throw reqErr;
      const req = (created as any)?.request;
      if (!req?.id) throw new Error('Advance request was not created');

      // 2. Disburse through the single shared disbursement path.
      await disburseAgentAdvanceRequest({
        req,
        actorId: user.id,
        principal,
        cycleDays: days,
        monthlyRate,
        repaymentFrequency: frequency,
        notes: `CFO-initiated advance · ${reason.trim()}`,
        recoverySource,
        roiRecoveryPercent: recoverySource === 'roi' ? roiPercentNum : 0,
      });

      // cfo_create_advance already wrote the audit row (including the bypassed gates);
      // this only adds the client-side context the RPC cannot see.
      await supabase.from('audit_logs').insert({
        user_id: user.id,
        action_type: 'cfo_initiated_advance_disbursed',
        table_name: 'agent_advance_requests',
        record_id: req.id,
        metadata: {
          agent_id: agent.id,
          agent_name: agent.full_name,
          principal,
          recovery_source: recoverySource,
          roi_recovery_percent: recoverySource === 'roi' ? roiPercentNum : 0,
          over_limit: overLimit,
          computed_limit: limit,
          gate_override: usedOverride,
        },
      });

      toast.success(
        usedOverride
          ? `Advance of ${formatUGX(principal)} issued to ${agent.full_name} — eligibility gates overridden and logged`
          : `Advance of ${formatUGX(principal)} issued to ${agent.full_name}`,
      );
      onSuccess?.();
      onOpenChange(false);
    } catch (e: any) {
      toast.error(e.message || 'Advance issuance failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!submitting) onOpenChange(o); }}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlert className="h-5 w-5 text-amber-600" /> CFO-initiated advance
          </DialogTitle>
          <DialogDescription>
            One agent at a time. Bulk issuance is not available by design.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <UserSearchPicker
            label="Agent"
            placeholder="Search agent by name or phone..."
            selectedUser={agent}
            onSelect={(u) => setAgent(u as any)}
          />

          {agent && checking && (
            <p className="text-xs text-muted-foreground inline-flex items-center gap-1.5">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Running eligibility checks...
            </p>
          )}

          {agent && !checking && needsOverride && (
            <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 space-y-1">
              <p className="text-xs font-semibold text-amber-700 dark:text-amber-500">
                {overrideItems.length} condition{overrideItems.length === 1 ? '' : 's'} would normally block this issuance
              </p>
              {overrideItems.map((b) => (
                <p key={b} className="text-xs text-amber-700 dark:text-amber-500 flex gap-1.5">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" /> {b}
                </p>
              ))}
              <p className="text-[11px] text-muted-foreground pt-1">
                The CFO may still issue. Tick the override below and record why — it is stored on
                the request and in the audit log.
              </p>
            </div>
          )}

          {agent && !checking && !needsOverride && (
            <p className="text-xs font-medium text-emerald-600 inline-flex items-center gap-1.5">
              <CheckCircle2 className="h-3.5 w-3.5" /> Eligible
              {limit !== null && <> · computed limit {formatUGX(limit)}</>}
            </p>
          )}

          {agent && <DuplicateAccountAlert dups={duplicateMap[agent.id]} />}

          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <Label>Amount (UGX)</Label>
              <Input
                inputMode="numeric"
                placeholder={`${MIN_PRINCIPAL.toLocaleString()} – ${MAX_PRINCIPAL.toLocaleString()}`}
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, ''))}
                className="mt-1"
              />
              {amount !== '' && amountErrors.map((e) => (
                <p key={e} className="text-[11px] text-destructive mt-1">{e}</p>
              ))}
              {amount !== '' && amountWarnings.map((w) => (
                <p key={w} className="text-[11px] text-amber-600 mt-1">{w}</p>
              ))}
              {overLimit && (
                <p className="text-[11px] text-amber-600 mt-1">
                  Above the agent's computed limit of {formatUGX(limit || 0)}.
                </p>
              )}
            </div>
            <div>
              <Label>Cycle (days)</Label>
              <Select value={cycleDays} onValueChange={setCycleDays}>
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CYCLE_OPTIONS.map((d) => <SelectItem key={d} value={d}>{d} days</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Access fee rate</Label>
              <Select value={ratePreset} onValueChange={setRatePreset}>
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {RATE_OPTIONS.map((r) => <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            {ratePreset === 'custom' && (
              <div>
                <Label>Custom rate (% / month)</Label>
                <Input
                  inputMode="decimal"
                  value={customRate}
                  onChange={(e) => setCustomRate(e.target.value.replace(/[^0-9.]/g, ''))}
                  placeholder="e.g. 18.5"
                  className="mt-1"
                />
                {!rateValid && <p className="text-[11px] text-destructive mt-1">Enter a rate between 0 and 100.</p>}
              </div>
            )}
            <div className={ratePreset === 'custom' ? '' : 'col-span-2'}>
              <Label>Repayment frequency</Label>
              <Select value={frequency} onValueChange={(v) => setFrequency(v as RepaymentFrequency)}>
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {REPAYMENT_FREQUENCIES.map((f) => (
                    <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className={recoverySource === 'roi' ? '' : 'col-span-2'}>
              <Label>Recovery source</Label>
              <Select value={recoverySource} onValueChange={(v) => setRecoverySource(v as 'wallet_daily' | 'roi')}>
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="wallet_daily">Daily wallet sweep (standard)</SelectItem>
                  <SelectItem value="roi">From customer ROI (percentage)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {recoverySource === 'roi' && (
              <div>
                <Label>Recovery % of each ROI</Label>
                <Input
                  inputMode="decimal"
                  value={roiPercent}
                  onChange={(e) => setRoiPercent(e.target.value.replace(/[^0-9.]/g, ''))}
                  placeholder="e.g. 20"
                  className="mt-1"
                />
                {!recoveryValid && <p className="text-[11px] text-destructive mt-1">Enter a percentage between 0 and 100.</p>}
              </div>
            )}
            {recoverySource === 'roi' && (
              <p className="col-span-2 text-[11px] text-muted-foreground">
                No daily wallet deductions. Each time ROI is paid, {roiPercent || 0}% of that ROI is applied to the
                outstanding balance and the rest stays in the customer's wallet.
              </p>
            )}
          </div>

          {principal > 0 && amountErrors.length === 0 && (
            <div className="rounded-xl border bg-muted/30 p-3 text-xs space-y-1">
              <div className="flex justify-between"><span className="text-muted-foreground">Principal</span><span className="font-semibold">{formatUGX(principal)}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Access fee</span><span className="font-semibold">{formatUGX(accessFee)}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Registration fee</span><span className="font-semibold">{formatUGX(registrationFee)}</span></div>
              <div className="flex justify-between border-t pt-1"><span className="text-muted-foreground">Total repayable</span><span className="font-bold">{formatUGX(totalPayable)}</span></div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">{frequencyLabel(frequency)} deduction</span>
                <span className="font-semibold">{formatUGX(installment)} × {installments}</span>
              </div>
            </div>
          )}

          <div>
            <Label>Reason (min {MIN_REASON} characters)</Label>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value.slice(0, 500))}
              placeholder="Why is the CFO issuing this advance directly?"
              className="mt-1 text-sm"
              rows={3}
            />
            <p className="text-[10px] text-muted-foreground mt-1">{reason.trim().length}/{MIN_REASON}</p>
          </div>

          {needsOverride && (
            <div className="rounded-xl border border-amber-500/40 p-3 space-y-2">
              <label className="flex items-start gap-2 text-xs">
                <Checkbox checked={overrideGates} onCheckedChange={(c) => setOverrideGates(!!c)} className="mt-0.5" />
                <span>
                  I am knowingly overriding {overrideItems.length} eligibility condition
                  {overrideItems.length === 1 ? '' : 's'} on my authority as CFO.
                </span>
              </label>
              {overrideGates && (
                <div>
                  <Label>Override justification (min {MIN_OVERRIDE_REASON} characters)</Label>
                  <Textarea
                    value={overrideReason}
                    onChange={(e) => setOverrideReason(e.target.value.slice(0, 500))}
                    placeholder="Why are the eligibility gates being bypassed for this agent?"
                    className="mt-1 text-sm"
                    rows={2}
                  />
                  <p className="text-[10px] text-muted-foreground mt-1">
                    {overrideReason.trim().length}/{MIN_OVERRIDE_REASON} · recorded against your name on the request
                  </p>
                </div>
              )}
            </div>
          )}

          <div>
            <Label>Re-type the amount to confirm</Label>
            <Input
              inputMode="numeric"
              value={confirmAmount}
              onChange={(e) => setConfirmAmount(e.target.value.replace(/[^0-9]/g, ''))}
              placeholder="Exact amount in figures"
              className="mt-1"
            />
          </div>

          <label className="flex items-start gap-2 text-xs">
            <Checkbox checked={ackRisk} onCheckedChange={(c) => setAckRisk(!!c)} className="mt-0.5" />
            <span>
              I confirm this disbursement is intentional, credits the agent's wallet immediately
              and starts daily deductions. It cannot be undone from this screen.
            </span>
          </label>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>Cancel</Button>
          <CfoApprovalGate>
            <Button onClick={handleSubmit} disabled={!canSubmit}>
              {submitting && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
              Issue {principal > 0 ? formatUGX(principal) : 'advance'}
            </Button>
          </CfoApprovalGate>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default CFOInitiateAdvanceDialog;
