import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { checkTreasuryGuard } from "../_shared/treasuryGuard.ts";
import { attemptYoolaPrimary } from "../_shared/yoolaPrimary.ts";

const fmtUGX = (n: number) => `UGX ${Math.round(Number(n) || 0).toLocaleString('en-US')}`;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const DEFAULT_MONTHLY_RATE = 0.33;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, serviceKey);

    // Treasury guard: cron deductions must respect maintenance freeze
    const guardBlock = await checkTreasuryGuard(supabase, "any");
    if (guardBlock) return guardBlock;

    const { data: advances, error: fetchError } = await supabase
      .from('agent_advances')
      .select('*')
      .in('status', ['active', 'overdue'])
      // Paused advances are under dispute/investigation — Agent Ops or the CFO
      // has explicitly stopped collection until it is resolved.
      .eq('deduction_paused', false)
      // ROI-recovery advances are never swept or reminded here — they are
      // repaid exclusively via apply_roi_advance_recovery. NULL-safe so legacy
      // rows without a recovery_source keep their daily behaviour.
      .or('recovery_source.is.null,recovery_source.neq.roi');

    if (fetchError) throw fetchError;
    if (!advances || advances.length === 0) {
      return new Response(JSON.stringify({ message: 'No active advances to process' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const results = [];
    const skipped = [];
    const today = new Date().toISOString().split('T')[0];
    // Same-day skip: never deduct on the calendar day the advance was issued
    // (Africa/Kampala). Day 0 belongs entirely to the agent — daily schedule
    // starts the next day at the scheduled sweep time.
    const todayEAT = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Africa/Kampala',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());

    // Build a phone/name map once so we can notify agents without an extra
    // query per advance.
    const agentIds = Array.from(new Set(advances.map((a) => a.agent_id).filter(Boolean)));
    const phoneMap = new Map<string, { phone: string | null; name: string | null }>();
    if (agentIds.length) {
      const { data: profs } = await supabase
        .from('profiles')
        .select('id, phone, full_name')
        .in('id', agentIds);
      for (const p of profs || []) {
        phoneMap.set(p.id, { phone: p.phone, name: p.full_name });
      }
    }
    const notifyAgent = async (agentId: string, message: string, source: string) => {
      const info = phoneMap.get(agentId);
      if (!info?.phone) return;
      try {
        await attemptYoolaPrimary(info.phone, message, {
          source,
          recipientUserId: agentId,
          recipientName: info.name ?? undefined,
        });
      } catch (_e) { /* SMS failure never blocks deductions */ }
    };

    const periodDaysFor = (freq: string | null | undefined): number => {
      const f = String(freq || 'daily').toLowerCase().replace(/[\s_-]/g, '');
      switch (f) {
        case 'weekly': return 7;
        case 'biweekly':
        case 'fortnightly': return 14;
        case 'monthly': return 30;
        default: return 1;
      }
    };
    const freqLabel = (freq: string | null | undefined): string => {
      switch (periodDaysFor(freq)) {
        case 7: return 'weekly';
        case 14: return 'bi-weekly';
        case 30: return 'monthly';
        default: return 'daily';
      }
    };

    for (const advance of advances) {
      // Defence in depth: never touch an ROI advance, even if the query filter
      // above is ever relaxed. No deduction, no arrears, no missed-payment SMS.
      if (String(advance.recovery_source || '').toLowerCase() === 'roi') {
        skipped.push(advance.id);
        continue;
      }
      const issuedAtEAT = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Africa/Kampala',
        year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(new Date(advance.issued_at));
      if (issuedAtEAT === todayEAT) {
        // Grace-day skip. Also log a "prepaid"-style ledger row so the daily
        // job's idempotency guard treats today as already handled.
        await supabase.from('agent_advance_ledger').insert({
          advance_id: advance.id,
          date: today,
          opening_balance: Number(advance.outstanding_balance),
          interest_accrued: 0,
          amount_deducted: 0,
          closing_balance: Number(advance.outstanding_balance),
          deduction_status: 'none',
        });
        skipped.push(advance.id);
        continue;
      }
      const { data: existingEntry } = await supabase
        .from('agent_advance_ledger')
        .select('id')
        .eq('advance_id', advance.id)
        .eq('date', today)
        .maybeSingle();

      if (existingEntry) {
        skipped.push(advance.id);
        continue;
      }

      // Voluntary prepayment: if the agent has paid ahead, mark today prepaid
      // (skip cron deduction) and decrement the remaining counter.
      if (Number(advance.prepaid_installments_remaining || 0) > 0) {
        await supabase.from('agent_advance_ledger').insert({
          advance_id: advance.id,
          date: today,
          opening_balance: Number(advance.outstanding_balance),
          interest_accrued: 0,
          amount_deducted: 0,
          closing_balance: Number(advance.outstanding_balance),
          deduction_status: 'prepaid',
        });
        await supabase.from('agent_advances').update({
          prepaid_installments_remaining: Math.max(0, Number(advance.prepaid_installments_remaining) - 1),
        }).eq('id', advance.id);
        await notifyAgent(
          advance.agent_id,
          `WELILE: Today's advance installment was skipped because you paid ahead. Outstanding ${fmtUGX(advance.outstanding_balance)}.`,
          'advance_prepaid_skip',
        );
        skipped.push(advance.id);
        continue;
      }

      // Repayment-frequency gate: weekly / bi-weekly / monthly advances are only
      // swept on their due day. Daily advances are due every day.
      // The due-day anchor is the LAST successful deduction (falling back to the
      // issue date). Anchoring on the last collection — instead of a modulo of
      // days-since-issue — keeps the schedule self-correcting when a cron run is
      // missed or when the terms/frequency are edited mid-advance.
      const advPeriodDays = periodDaysFor(advance.repayment_frequency);
      const advFreqLabel = freqLabel(advance.repayment_frequency);
      const issuedMs = new Date(issuedAtEAT + 'T00:00:00Z').getTime();
      const todayMs = new Date(todayEAT + 'T00:00:00Z').getTime();
      const daysSinceIssue = Math.max(1, Math.floor((todayMs - issuedMs) / 86400000));

      let daysSinceAnchor = daysSinceIssue;
      if (advPeriodDays > 1) {
        const { data: lastPaid } = await supabase
          .from('agent_advance_ledger')
          .select('date')
          .eq('advance_id', advance.id)
          .gt('amount_deducted', 0)
          .order('date', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (lastPaid?.date) {
          const lastMs = new Date(String(lastPaid.date) + 'T00:00:00Z').getTime();
          daysSinceAnchor = Math.max(0, Math.floor((todayMs - lastMs) / 86400000));
        }
      }

      if (advPeriodDays > 1 && daysSinceAnchor < advPeriodDays) {
        await supabase.from('agent_advance_ledger').insert({
          advance_id: advance.id,
          date: today,
          opening_balance: Number(advance.outstanding_balance),
          interest_accrued: 0,
          amount_deducted: 0,
          closing_balance: Number(advance.outstanding_balance),
          deduction_status: 'not_due',
        });
        skipped.push(advance.id);
        continue;
      }
      // Amount due per repayment period.
      const periodsInCycle = Math.max(
        1,
        Math.ceil((Number(advance.cycle_days) || 30) / advPeriodDays),
      );
      const totalPayableSchedule =
        Number(advance.principal) + Number(advance.access_fee || 0);
      const scheduledInstallment = Math.max(
        0,
        Number(advance.installment_amount) > 0
          ? Number(advance.installment_amount)
          : Math.ceil(totalPayableSchedule / periodsInCycle),
      );

      // Ahead-of-schedule check: if the agent has already paid down more than
      // the cumulative expected-to-date, skip today's deduction. They still
      // appear on the daily report with status "ahead" (idempotency row).
      {
        const totalPayableAhead = totalPayableSchedule;
        const periodsElapsed = Math.max(
          1,
          Math.min(periodsInCycle, Math.floor(daysSinceIssue / advPeriodDays)),
        );
        const expectedToDate = Math.min(
          totalPayableAhead,
          scheduledInstallment * periodsElapsed,
        );
        const paidToDate = Math.max(
          0,
          totalPayableAhead - Number(advance.outstanding_balance || 0),
        );
        if (paidToDate >= expectedToDate && Number(advance.outstanding_balance || 0) > 0) {
          await supabase.from('agent_advance_ledger').insert({
            advance_id: advance.id,
            date: today,
            opening_balance: Number(advance.outstanding_balance),
            interest_accrued: 0,
            amount_deducted: 0,
            closing_balance: Number(advance.outstanding_balance),
            deduction_status: 'ahead',
          });
          await notifyAgent(
            advance.agent_id,
            `WELILE: You are ahead on your ${advFreqLabel} advance repayment — no deduction today. Outstanding ${fmtUGX(advance.outstanding_balance)}.`,
            'advance_ahead_skip',
          );
          skipped.push(advance.id);
          continue;
        }
      }

      const advanceMonthlyRate = Number(advance.monthly_rate) || Number(advance.daily_rate) || DEFAULT_MONTHLY_RATE;
      const dailyInterestRate = Math.pow(1 + advanceMonthlyRate, 1 / 30) - 1;

      const openingBalance = Number(advance.outstanding_balance);
      const isOverdue = new Date() > new Date(advance.expires_at);

      // POLICY: the outstanding balance is FIXED at principal + access_fee for the
      // whole scheduled period (cycle_days). Missed installments do NOT grow the
      // outstanding — they are simply carried forward as arrears and recovered later.
      // Only once the scheduled period has fully elapsed and the advance is still
      // not settled does a daily penalty start accruing on the remaining balance.
      const interestAccrued = isOverdue
        ? Math.round(openingBalance * dailyInterestRate)
        : 0;
      const balanceAfterInterest = openingBalance + interestAccrued;

      // STRICT: read withdrawable-only figure (Wallet Withdrawable Strict Rule).
      // Never read wallets.balance — that aggregate includes float/commission
      // custody money that must NEVER be touched for advance recovery.
      // Peer wallet_transfer credits are shielded from advance sweep.
      // `get_agent_sweepable_withdrawable` returns strict withdrawable minus any
      // untouched peer-to-peer transfer inflows since the oldest active advance.
      const { data: availRaw, error: availErr } = await supabase
        .rpc('get_agent_sweepable_withdrawable', { p_user_id: advance.agent_id });
      if (availErr) console.error(`[process-agent-advance-deductions] sweepable_withdrawable error for agent ${advance.agent_id}:`, availErr);
      const withdrawableSnapshot = Math.max(0, Number(availRaw ?? 0));

      // emit repayment_attempted
      await supabase.from('system_events').insert({
        event_type: 'repayment_attempted',
        payload: {
          source: 'cron_advance_deduction',
          advance_id: advance.id,
          user_id: advance.agent_id,
          outstanding_after_interest: balanceAfterInterest,
          withdrawable_snapshot: withdrawableSnapshot,
        },
      }).then(() => {}, () => {});

      // Cap each sweep at the scheduled installment for the advance's repayment
      // frequency, plus any accrued arrears. Never scoop the agent's whole
      // withdrawable — the schedule is `principal + access_fee` spread over
      // cycle_days at the selected frequency.
      const scheduledDailyCap = scheduledInstallment;
      const arrearsCap = Math.max(0, Number(advance.arrears_balance || 0));
      const dailyCap = Math.max(0, scheduledDailyCap + arrearsCap);

      const maxDeduction = Math.min(
        withdrawableSnapshot,
        balanceAfterInterest,
        dailyCap > 0 ? dailyCap : balanceAfterInterest,
      );
      const amountDeducted = Math.max(0, maxDeduction);
      const closingBalance = balanceAfterInterest - amountDeducted;

      let deductionStatus: string;
      if (amountDeducted >= balanceAfterInterest) deductionStatus = 'full';
      else if (amountDeducted > 0) deductionStatus = 'partial';
      else deductionStatus = 'none';

      // The DB guard (zz_guard_agent_advance_double_charge) locks the advance and
      // rejects this row when another recovery path already collected the same
      // installment (stale opening balance) or when the same-day cap is reached.
      // A rejection MUST abort before the wallet is debited, otherwise the agent
      // pays twice for one installment.
      const { error: ledgerRowErr } = await supabase.from('agent_advance_ledger').insert({
        advance_id: advance.id,
        date: today,
        opening_balance: openingBalance,
        interest_accrued: interestAccrued,
        amount_deducted: amountDeducted,
        closing_balance: closingBalance,
        deduction_status: deductionStatus,
      });

      if (ledgerRowErr) {
        console.error(
          `[process-agent-advance-deductions] ledger row rejected for advance ${advance.id} — no wallet debit:`,
          ledgerRowErr.message,
        );
        await supabase.from('system_events').insert({
          event_type: 'repayment_skipped_insufficient_balance',
          payload: {
            source: 'cron_advance_deduction',
            reason: 'ledger_guard_rejected',
            guard_error: ledgerRowErr.message,
            advance_id: advance.id,
            user_id: advance.agent_id,
            attempted_amount: amountDeducted,
          },
        }).then(() => {}, () => {});
        skipped.push(advance.id);
        continue;
      }

      const newStatus = closingBalance <= 0 ? 'completed' : (isOverdue ? 'overdue' : 'active');
      const advAccessFee = Number(advance.access_fee || 0);
      const totalPayable = Number(advance.principal) + advAccessFee;
      const totalDeducted = totalPayable - Math.max(0, closingBalance);
      const feeCollectionRatio = totalPayable > 0 ? Math.min(1, totalDeducted / totalPayable) : 0;
      const newFeeCollected = Math.round(advAccessFee * feeCollectionRatio);
      const feeStatus = newFeeCollected >= advAccessFee ? 'settled' : newFeeCollected > 0 ? 'partial' : 'unpaid';

      // Arrears accrual: track missed scheduled daily repayments so the credit-time
      // recovery trigger can claw them back from the agent's NEXT earning before it
      // becomes withdrawable. Meeting/exceeding today's installment pays arrears down;
      // missing it grows arrears. Arrears can never exceed what is still owed.
      const scheduledDaily = scheduledInstallment;
      const currentArrears = Number(advance.arrears_balance || 0);
      let newArrears: number;
      if (amountDeducted >= scheduledDaily) {
        newArrears = Math.max(0, currentArrears - (amountDeducted - scheduledDaily));
      } else {
        newArrears = currentArrears + (scheduledDaily - amountDeducted);
      }
      newArrears = Math.min(newArrears, Math.max(0, closingBalance));

      await supabase.from('agent_advances').update({
        outstanding_balance: Math.max(0, closingBalance),
        status: newStatus,
        access_fee_collected: newFeeCollected,
        access_fee_status: feeStatus,
        arrears_balance: newArrears,
      }).eq('id', advance.id);

      if (amountDeducted <= 0) {
        // Skipped — no withdrawable to recover from. Float is intentionally untouched.
        await supabase.from('system_events').insert({
          event_type: 'repayment_skipped_insufficient_balance',
          payload: {
            source: 'cron_advance_deduction',
            advance_id: advance.id,
            user_id: advance.agent_id,
            withdrawable_snapshot: withdrawableSnapshot,
            outstanding_after_interest: balanceAfterInterest,
          },
        }).then(() => {}, () => {});
        // Notify the agent that today's installment could not be collected and
        // will be recovered automatically from their next earnings.
        await notifyAgent(
          advance.agent_id,
          `WELILE: Your ${advFreqLabel} advance repayment could not be collected today (low wallet balance). Outstanding ${fmtUGX(closingBalance)}. It will be auto-recovered from your next earnings. Top up to avoid arrears.`,
          'advance_deduction_missed',
        );
      } else {
        // Deduct from wallet via balanced RPC with EXPLICIT Wallet Routing v2 tags.
        // wallet leg → recipient_type='user' forces withdrawable bucket;
        // platform leg → recipient_type='operational_wallet'.
        const repaymentMeta = {
          source: 'cron_advance_deduction',
          advance_id: advance.id,
          withdrawable_snapshot: withdrawableSnapshot,
          bucket_intent: 'advance_balance_recovery',
        };
        const { error: rpcErr } = await supabase.rpc('create_ledger_transaction', {
          entries: [
            {
              user_id: advance.agent_id,
              ledger_scope: 'wallet',
              direction: 'cash_out',
              amount: amountDeducted,
              category: 'agent_repayment',
              recipient_type: 'user',
              source_table: 'agent_advances',
              source_id: advance.id,
              description: interestAccrued > 0
                ? `Advance ${advFreqLabel} deduction - Overdue penalty: ${interestAccrued}`
                : `Advance ${advFreqLabel} deduction`,
              currency: 'UGX',
              transaction_date: today,
              metadata: repaymentMeta,
            },
          {
            user_id: advance.agent_id,
            ledger_scope: 'platform',
            direction: 'cash_in',
            amount: amountDeducted,
            category: 'agent_repayment',
            recipient_type: 'operational_wallet',
            source_table: 'agent_advances',
            source_id: advance.id,
            description: `Advance repayment received from agent`,
            currency: 'UGX',
            transaction_date: today,
            metadata: repaymentMeta,
          },
          ],
        });
        if (rpcErr) {
          console.error(`[process-agent-advance-deductions] RPC error for advance ${advance.id}:`, rpcErr);
          await supabase.from('system_events').insert({
            event_type: 'repayment_failed',
            payload: { ...repaymentMeta, user_id: advance.agent_id, error: String(rpcErr.message ?? rpcErr) },
          }).then(() => {}, () => {});
        } else {
          await supabase.from('system_events').insert({
            event_type: 'repayment_successful',
            payload: { ...repaymentMeta, user_id: advance.agent_id, amount: amountDeducted },
          }).then(() => {}, () => {});
          // Notify the agent where the money went (also visible in transactions).
          await notifyAgent(
            advance.agent_id,
            `WELILE: ${fmtUGX(amountDeducted)} was deducted from your wallet today towards your ${advFreqLabel} advance installment. Remaining balance ${fmtUGX(closingBalance)}. See your transactions for details.`,
            'advance_deduction_success',
          );
        }
      }

      results.push({
        advance_id: advance.id,
        agent_id: advance.agent_id,
        interest: interestAccrued,
        deducted: amountDeducted,
        closing: closingBalance,
        status: newStatus,
      });
    }

    return new Response(JSON.stringify({ processed: results.length, skipped: skipped.length, results }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
