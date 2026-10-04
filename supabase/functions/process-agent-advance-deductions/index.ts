import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { checkTreasuryGuard } from "../_shared/treasuryGuard.ts";
import { attemptYoolaPrimary } from "../_shared/yoolaPrimary.ts";
import { sendSMS } from "../_shared/sendSmsMultiProvider.ts";

const fmtUGX = (n: number) => `UGX ${Math.round(Number(n) || 0).toLocaleString('en-US')}`;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const DEFAULT_MONTHLY_RATE = 0.33;

// Statuses that mean "this advance was already fully resolved for today by
// an earlier run" -- grace day / not-due / ahead-of-schedule / prepaid never
// get retried later the same day, even now that the cron runs every 6 hours.
const TERMINAL_TODAY_STATUSES = new Set(['not_due', 'ahead', 'prepaid']);

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
        const yoolaOk = await attemptYoolaPrimary(info.phone, message, {
          source,
          recipientUserId: agentId,
          recipientName: info.name ?? undefined,
        });
        // attemptYoolaPrimary's own contract: on `false` (rejection, e.g. a
        // provider-side rate limit under this cron's serial fan-out) the
        // caller must fall through to another provider — this loop used to
        // just swallow that failure, silently dropping the notification.
        if (!yoolaOk) {
          await sendSMS(info.phone, message, {
            admin: supabase,
            source,
            recipient_user_id: agentId,
            recipient_name: info.name ?? undefined,
            idempotencyKey: `${source}-${agentId}-${todayEAT}`,
          });
        }
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

      // Fetch every ledger row already written for this advance TODAY. With
      // the cron now running every 6 hours, more than one row per day is
      // expected — the retry logic below decides what (if anything) is left
      // to do based on all of them, instead of the old "any row → skip".
      const { data: todayRowsRaw } = await supabase
        .from('agent_advance_ledger')
        .select('deduction_status, amount_deducted')
        .eq('advance_id', advance.id)
        .eq('date', today);
      const todayRows = todayRowsRaw || [];
      const hasTodayRow = todayRows.length > 0;
      const hasTerminalToday = todayRows.some((r) => TERMINAL_TODAY_STATUSES.has(String(r.deduction_status)));

      const issuedAtEAT = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Africa/Kampala',
        year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(new Date(advance.issued_at));
      if (issuedAtEAT === todayEAT) {
        // Grace-day skip, for the whole day regardless of how many times the
        // cron runs. Only write the marker once.
        if (!hasTodayRow) {
          await supabase.from('agent_advance_ledger').insert({
            advance_id: advance.id,
            date: today,
            opening_balance: Number(advance.outstanding_balance),
            interest_accrued: 0,
            amount_deducted: 0,
            closing_balance: Number(advance.outstanding_balance),
            deduction_status: 'none',
          });
        }
        skipped.push(advance.id);
        continue;
      }

      // An earlier run today already determined this advance is not_due /
      // ahead / prepaid for the whole day — nothing changes by re-checking.
      if (hasTerminalToday) {
        skipped.push(advance.id);
        continue;
      }

      // Voluntary prepayment: if the agent has paid ahead, mark today prepaid
      // (skip cron deduction) and decrement the remaining counter. Only the
      // first run of the day does this — hasTerminalToday above already
      // covers every later run once the marker exists.
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

      // Only evaluate the due-day gate on the FIRST attempt of the day. On a
      // same-day retry, `hasTodayRow` is already true and — since the
      // terminal-status check above didn't fire — the only way that's
      // possible is that an earlier run TODAY already found this advance due
      // and started collecting (a 'partial'/'none'/'full' row). Re-running
      // this gate on retry would be wrong: the anchor query below matches on
      // "last row with amount_deducted > 0", which would now match TODAY's
      // own partial collection and misread a same-day top-up attempt as
      // "not due for another full period".
      if (!hasTodayRow) {
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
          if (!hasTodayRow) {
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
          }
          skipped.push(advance.id);
          continue;
        }
      }

      // ── Retry-aware collection ─────────────────────────────────────────
      // "Room" is what's left of today's cap (scheduled installment +
      // arrears) after whatever earlier runs today already collected. A
      // fresh day has alreadyToday = 0, so this reduces to the original
      // single-run behaviour; a same-day retry (agent topped up between
      // cron runs) only ever takes the remainder.
      const alreadyToday = todayRows.reduce((sum, r) => sum + Number(r.amount_deducted || 0), 0);
      const arrearsBefore = Math.max(0, Number(advance.arrears_balance || 0));
      // NOTE: this must be "was there an earlier real attempt today", not
      // "did an earlier attempt collect money" — a $0 (insufficient-balance)
      // attempt still counts as an attempt. Using `alreadyToday <= 0` here
      // would stay true across every retry of a day where nothing gets
      // collected, re-adding the day's arrears shortfall on each 6-hourly
      // retry instead of once. `hasTodayRow` reflects the pre-this-run state
      // and — since the terminal/grace/prepaid checks above already
      // `continue`d for their own cases — is only true here because an
      // earlier run today made a real (partial/none/full) collection attempt.
      const isFirstAttemptToday = !hasTodayRow;
      // `advance.arrears_balance` (arrearsBefore) already has any earlier
      // run TODAY's provisional adjustment baked in (see the arrears update
      // below). Using it directly as the cap's arrears term would let each
      // retry inflate the cap by today's own not-yet-final shortfall. Back
      // out that adjustment first so the cap only ever reflects arrears
      // carried in from PRIOR days — reversing the exact delta the update
      // formula applied on the prior run(s): (scheduledInstallment - alreadyToday).
      const arrearsBaseline = isFirstAttemptToday
        ? arrearsBefore
        : Math.max(0, arrearsBefore - scheduledInstallment + alreadyToday);
      const cap = scheduledInstallment + arrearsBaseline;
      const room = Math.max(0, cap - alreadyToday);
      if (room <= 0) {
        // Already fully collected for today's cap by an earlier run today.
        skipped.push(advance.id);
        continue;
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
      // Interest only accrues on the FIRST attempt of the day — outstanding_balance
      // already carries any interest posted by an earlier run today, so recomputing
      // it on a same-day retry would double-count.
      const interestAccrued = (isFirstAttemptToday && isOverdue)
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
          already_collected_today: alreadyToday,
        },
      }).then(() => {}, () => {});

      // Cap this attempt at whatever room remains of today's cap. Never scoop
      // the agent's whole withdrawable — the schedule is `principal +
      // access_fee` spread over cycle_days at the selected frequency.
      const maxDeduction = Math.min(withdrawableSnapshot, balanceAfterInterest, room);
      const amountDeducted = Math.max(0, maxDeduction);
      const closingBalance = balanceAfterInterest - amountDeducted;
      const totalTodayAfter = alreadyToday + amountDeducted;

      let deductionStatus: string;
      if (totalTodayAfter >= cap || closingBalance <= 0) deductionStatus = 'full';
      else if (amountDeducted > 0) deductionStatus = 'partial';
      else deductionStatus = 'none';

      const newStatus = closingBalance <= 0 ? 'completed' : (isOverdue ? 'overdue' : 'active');
      const advAccessFee = Number(advance.access_fee || 0);
      const totalPayable = Number(advance.principal) + advAccessFee;
      const totalDeducted = totalPayable - Math.max(0, closingBalance);
      const feeCollectionRatio = totalPayable > 0 ? Math.min(1, totalDeducted / totalPayable) : 0;
      const newFeeCollected = Math.round(advAccessFee * feeCollectionRatio);
      const feeStatus = newFeeCollected >= advAccessFee ? 'settled' : newFeeCollected > 0 ? 'partial' : 'unpaid';

      // Arrears accrual: track missed scheduled repayments so the credit-time
      // recovery trigger can claw them back from the agent's NEXT earning before it
      // becomes withdrawable.
      //
      // Reverse-and-reapply so a same-day retry never double counts: on the
      // first attempt of the day this is exactly the original single-run
      // formula (arrears_before + (installment - deducted)); a later retry
      // only nets its OWN amountDeducted off of what the first attempt
      // already added, because that first attempt's effect is already baked
      // into `advance.arrears_balance` as read at the top of this loop.
      const currentArrears = arrearsBefore;
      const arrearsAdjustmentTarget = isFirstAttemptToday ? scheduledInstallment : 0;
      let newArrears = currentArrears + (arrearsAdjustmentTarget - amountDeducted);
      newArrears = Math.max(0, Math.min(newArrears, Math.max(0, closingBalance)));

      const penaltyMeta = {
        source: 'cron_advance_penalty_accrual',
        advance_id: advance.id,
        days_overdue: Math.max(
          0,
          Math.floor((Date.now() - new Date(advance.expires_at).getTime()) / 86400000),
        ),
        daily_rate: dailyInterestRate,
        monthly_rate: advanceMonthlyRate,
        opening_balance: openingBalance,
        outstanding_after_interest: balanceAfterInterest,
        accrual_date: today,
      };
      const repaymentMeta = {
        source: 'cron_advance_deduction',
        advance_id: advance.id,
        withdrawable_snapshot: withdrawableSnapshot,
        bucket_intent: 'advance_balance_recovery',
      };

      // ── ONE TRANSACTION ───────────────────────────────────────────────────
      // Daybook row, advance balance, penalty legs and repayment legs commit or
      // roll back together. Previously these were four separate PostgREST calls
      // with the balance update second, so a failed ledger post still left the
      // balance reduced — 10,862,683.34 of collection diverged from the ledger
      // that way. `record_advance_deduction_atomic` carries no exception
      // handler, so any failure (double-charge guard, solvency check, mapped
      // balance) discards the whole unit.
      //
      // Every amount, category, recipient_type, bucket and idempotency key is
      // unchanged — the RPC posts exactly what this loop used to post. All
      // selection and arithmetic stays here.
      //
      // Penalty interest remains LEDGER-VISIBLE:
      //   wallet leg   → cash_in  `agent_advance_credit`, wallet_bucket
      //                  'advance_credit' — set explicitly so the
      //                  recipient_type stamp cannot route it to
      //                  'withdrawable'. An accrual must never add to or
      //                  subtract from spendable cash.
      //   platform leg → cash_out `interest_expense`.
      // Idempotent per advance per day, and only computed on the first attempt
      // of the day, so it posts once regardless of cron cadence.
      const { error: postErr } = await supabase.rpc('record_advance_deduction_atomic', {
        p_advance_id: advance.id,
        p_agent_id: advance.agent_id,
        p_date: today,
        p_opening_balance: openingBalance,
        p_interest_accrued: interestAccrued,
        p_amount_deducted: amountDeducted,
        p_closing_balance: closingBalance,
        p_deduction_status: deductionStatus,
        p_new_status: newStatus,
        p_new_fee_collected: newFeeCollected,
        p_fee_status: feeStatus,
        p_new_arrears: newArrears,
        p_penalty_description: interestAccrued > 0
          ? `Overdue advance penalty interest (${(dailyInterestRate * 100).toFixed(4)}%/day on ${fmtUGX(openingBalance)})`
          : null,
        p_penalty_meta: penaltyMeta,
        p_repayment_description: interestAccrued > 0
          ? `Advance ${advFreqLabel} deduction - Overdue penalty: ${interestAccrued}`
          : `Advance ${advFreqLabel} deduction`,
        p_repayment_meta: repaymentMeta,
      });

      if (postErr) {
        const msg = String(postErr.message ?? postErr);
        // The double-charge guard rejecting this row is an expected outcome,
        // not a fault: another recovery path already took today's installment.
        // Nothing was written, so the advance is simply skipped, exactly as it
        // was when the daybook insert was a separate call.
        const guardRejected = msg.includes('ADVANCE_LEDGER_STALE_OPENING')
          || msg.includes('ADVANCE_LEDGER_OVER_COLLECTION')
          || msg.includes('ADVANCE_LEDGER_DAILY_CAP');
        console.error(
          `[process-agent-advance-deductions] atomic post ${guardRejected ? 'rejected by guard' : 'failed'} for advance ${advance.id} — nothing written:`,
          msg,
        );
        await supabase.from('system_events').insert({
          event_type: guardRejected ? 'repayment_skipped_insufficient_balance' : 'repayment_failed',
          payload: {
            ...repaymentMeta,
            user_id: advance.agent_id,
            reason: guardRejected ? 'ledger_guard_rejected' : 'atomic_post_failed',
            guard_error: msg,
            error: msg,
            attempted_amount: amountDeducted,
            rolled_back: true,
          },
        }).then(() => {}, () => {});
        skipped.push(advance.id);
        continue;
      }

      if (interestAccrued > 0) {
        await supabase.from('system_events').insert({
          event_type: 'advance_penalty_interest_accrued',
          payload: {
            ...penaltyMeta,
            user_id: advance.agent_id,
            amount: interestAccrued,
          },
        }).then(() => {}, () => {});
      }

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
        // Only notify once per day — with the cron now running every 6 hours,
        // repeating this on every retry would spam the agent with the same
        // "still can't collect" message up to 4 times a day.
        if (isFirstAttemptToday) {
          await notifyAgent(
            advance.agent_id,
            `WELILE: Your ${advFreqLabel} advance repayment could not be collected today (low wallet balance). Outstanding ${fmtUGX(closingBalance)}. We'll try again later today, then auto-recover from your next earnings. Top up to avoid arrears.`,
            'advance_deduction_missed',
          );
        }
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
