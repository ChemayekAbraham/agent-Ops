import { supabase } from '@/integrations/supabase/client';
import {
  calculateAccessFee,
  calculateRegistrationFee,
  installmentCount,
  type RepaymentFrequency,
} from '@/lib/agentAdvanceCalculations';

/**
 * Merge an approved TOP-UP request into the agent's existing advance.
 * The top-up inherits the parent advance's rate + repayment frequency and
 * extends the schedule by `extend_days`; the DB re-validates eligibility
 * (≥30% repaid, not behind, ≤90% of current principal).
 */
export async function applyAdvanceTopupForRequest(req: any, amount?: number, extendDays?: number) {
  const topupAmount = Number(amount ?? req.principal);
  const days = Number(extendDays ?? req.extend_days);
  if (!Number.isFinite(topupAmount) || topupAmount <= 0) throw new Error('Top-up amount must be greater than zero');
  if (!Number.isFinite(days) || days <= 0) throw new Error('Top-up requires the number of days to extend by');
  if (!req.parent_advance_id) throw new Error('Top-up request is missing the advance it tops up');

  // All six arguments are passed explicitly. A four-argument call used to be
  // ambiguous between two overloads (SQLSTATE 42725) because the six-argument
  // signature defaults its last two parameters; the four-argument overload was
  // dropped on 2026-09-26 because it also posted no ledger entry. Sending the
  // full argument list keeps resolution unambiguous if a shorter overload is
  // ever reintroduced.
  //
  // `p_override_eligibility: false` preserves the previous behaviour of this
  // path exactly: the database re-validates eligibility, and no reason is
  // required because nothing is being overridden.
  const { data, error } = await supabase.rpc('apply_advance_topup' as any, {
    p_advance_id: req.parent_advance_id,
    p_amount: topupAmount,
    p_extend_days: days,
    p_request_id: req.id,
    p_reason: null,
    p_override_eligibility: false,
  } as any);
  if (error) throw error;
  return data as any;
}

/**
 * Disburse an agent advance to the agent's wallet.
 *
 * All money-moving steps run inside ONE atomic database transaction
 * (`disburse_agent_advance_request`): the request is stamped `cfo_paid`, the
 * `agent_advances` row is created (linked via `request_id`) and the wallet +
 * platform ledger legs are posted. Previously these were three separate
 * client calls, so a failure after step 1 left a request marked paid with no
 * advance row and no wallet credit (agent could not withdraw).
 *
 * The SMS notification is still fired client-side, fire-and-forget.
 */
export async function disburseAgentAdvanceRequest(opts: {
  req: any;
  actorId: string;
  principal?: number;
  cycleDays?: number;
  monthlyRate?: number;
  repaymentFrequency?: RepaymentFrequency;
  notes?: string | null;
  /** 'wallet_daily' (default daily wallet sweep) or 'roi' (recover a % of each ROI payout). */
  recoverySource?: 'wallet_daily' | 'roi';
  /** Percentage of each ROI payout to recover (only used when recoverySource === 'roi'). */
  roiRecoveryPercent?: number;
}) {
  const { req } = opts;
  const isTopup = (req.request_kind ?? 'new') === 'topup';
  const principal = Number(opts.principal ?? req.principal);
  const cycleDays = isTopup ? Number(req.extend_days ?? req.cycle_days) : Number(opts.cycleDays ?? req.cycle_days);
  const monthlyRate = isTopup ? Number(req.monthly_rate) : Number(opts.monthlyRate ?? req.monthly_rate);
  const repaymentFrequency: RepaymentFrequency =
    (opts.repaymentFrequency ?? req.repayment_frequency ?? 'daily') as RepaymentFrequency;
  if (!Number.isFinite(principal) || principal <= 0) throw new Error('Principal must be greater than zero');
  // A request carrying an audited CFO gate override is exempt from the UGX 10,000
  // floor — the same exemption `disburse_agent_advance_request` applies server-side.
  if (principal < 10000 && !req?.gate_override) {
    throw new Error('Principal must be at least UGX 10,000 — advances below this are not permitted.');
  }
  if (!Number.isFinite(cycleDays) || cycleDays <= 0) throw new Error('Cycle days must be greater than zero');

  const registrationFee = isTopup ? 0 : calculateRegistrationFee(principal);
  const accessFee = calculateAccessFee(principal, cycleDays, monthlyRate);
  const totalPayable = principal + accessFee + registrationFee;
  const installments = installmentCount(cycleDays, repaymentFrequency);
  let installment = Math.ceil(totalPayable / installments);
  let daily = installment;

  if (isTopup) {
    // Top-ups merge into the parent advance (its own atomic RPC).
    const merged = await applyAdvanceTopupForRequest(req, principal, cycleDays);
    installment = Number(merged?.new_installment ?? installment);
    daily = installment;
  } else {
    const { data, error } = await supabase.rpc('disburse_agent_advance_request' as any, {
      p_request_id: req.id,
      p_principal: principal,
      p_cycle_days: cycleDays,
      p_monthly_rate: monthlyRate,
      p_repayment_frequency: repaymentFrequency,
      p_notes: opts.notes ?? null,
      p_recovery_source: opts.recoverySource ?? 'wallet_daily',
      p_roi_recovery_percent: opts.recoverySource === 'roi' ? Number(opts.roiRecoveryPercent ?? 0) : 0,
    } as any);
    if (error) throw error;
    const res = data as any;
    if (res) {
      installment = Number(res.installment ?? installment);
      daily = installment;
    }
  }

  // Registration fee is NOT debited from the wallet at disbursement — it is baked
  // into `total_payable` and recovered through the repayment schedule.

  // Notify the agent by SMS (fire-and-forget).
  supabase.functions.invoke('notify-agent-advance-disbursed', {
    body: { agent_id: req.agent_id, amount: principal, request_id: req.id },
  }).catch((e) => console.error('advance disbursement SMS failed', e));

  return {
    principal, cycleDays, monthlyRate, accessFee, registrationFee,
    totalPayable, daily, installment, installments, repaymentFrequency,
  };
}