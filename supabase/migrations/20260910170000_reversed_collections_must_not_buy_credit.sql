-- Reversed collections were buying borrowing capacity.
--
-- `recalculate_credit_limit` sizes an agent's limit at 6% of their LIFETIME
-- collections (60% on the non-agent branch), summed straight from
-- `agent_collections` with no reversal filter. It fires on every collection.
--
-- So during the 2026-09-10 inverted collection incident it fired ten times, on
-- ten collections that never happened. Katongole James's limit climbed in ten
-- steps between 07:29:39 and 07:37:30 EAT:
--
--   792,853.52 -> 1,146,695.60   = +353,842.08, exactly 6% of the 5,897,368
--
-- Reversing the ledger that morning did not touch it. The limit stayed.
--
-- The distortion is worse on lifetime figures than on any daily tile: 47% of
-- Katongole's apparent collection record was phantom - 12,478,260 shown
-- against 6,580,892 real.
--
-- THE FIX is one predicate in each branch. Because the function recomputes the
-- whole limit from scratch and upserts it, correcting the affected agents is
-- then just a matter of calling it - no manual arithmetic, no hand-set values.
--
-- APPLIED 2026-09-10 15:00:05 EAT, and every figure landed on its prediction:
--
--   Agent                 Before        After         Delta        Predicted
--   Katongole James    1,164,695.60    810,853.52  -353,842.08   -353,842.08
--   Akampurira Onesmus 1,220,216.00  1,202,216.00   -18,000.00    -18,000.00
--   Saka Homi Melvin     984,130.70    978,510.62    -5,620.08     -5,620.08
--                                                   -377,462.16
--
-- All three are recorded in credit_limit_change_log.

CREATE OR REPLACE FUNCTION public.recalculate_credit_limit(p_user_id uuid)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_rating_bonus NUMERIC := 0;
  v_receipt_bonus NUMERIC := 0;
  v_rent_history_bonus NUMERIC := 0;
  v_landlord_rent_bonus NUMERIC := 0;
  v_houses_listed_bonus NUMERIC := 0;
  v_partners_bonus NUMERIC := 0;
  v_agent_allocations_bonus NUMERIC := 0;
  v_subagents_bonus NUMERIC := 0;
  v_avg_rating NUMERIC;
  v_receipt_count INT;
  v_completed_requests INT;
  v_total_rent_collected NUMERIC;
  v_houses_count INT;
  v_partners_count INT;
  v_repayments_count INT;
  v_agent_allocations_total NUMERIC := 0;
  v_registered_subagents INT := 0;
  v_active_subagents INT := 0;
  v_collections_total NUMERIC := 0;
  v_rent_requests INT := 0;
  v_promissory_count INT := 0;
  v_total NUMERIC;
BEGIN
  IF public.has_role(p_user_id, 'agent') THEN
    -- Driver 1 (biggest): sub-agents, weighted heavily towards ACTIVE ones.
    SELECT COUNT(*) INTO v_registered_subagents
    FROM public.agent_subagents s
    WHERE s.parent_agent_id = p_user_id
      AND s.sub_agent_id IS NOT NULL
      AND (s.status IN ('active','verified') OR s.accepted_at IS NOT NULL)
      AND s.sub_agent_id IN (SELECT q.agent_id FROM public.agent_ops_qualifying_agent_ids() q);

    SELECT COUNT(*) INTO v_active_subagents
    FROM public.agent_subagents s
    JOIN public.v_agent_daily_eligibility e ON e.agent_id = s.sub_agent_id
    WHERE s.parent_agent_id = p_user_id
      AND s.sub_agent_id IS NOT NULL
      AND (s.status IN ('active','verified') OR s.accepted_at IS NOT NULL)
      AND e.active_count > 0
      AND s.sub_agent_id IN (SELECT q.agent_id FROM public.agent_ops_qualifying_agent_ids() q);

    v_subagents_bonus := LEAST(
      (v_active_subagents * 30000) + (v_registered_subagents * 9000),
      3000000
    );

    -- Driver 2: rent collected (6% of lifetime collections).
    -- Reversed collections are excluded: money that was taken back must not
    -- buy borrowing capacity. The 2026-09-10 inverted collection incident put
    -- 353,842.08 of limit on one agent this way before this was fixed.
    SELECT COALESCE(SUM(amount), 0) INTO v_collections_total
    FROM public.agent_collections WHERE agent_id = p_user_id AND reversed_at IS NULL;
    v_agent_allocations_bonus := LEAST(v_collections_total * 0.06, 2400000);

    -- Driver 3: rent requests raised for tenants.
    SELECT COUNT(*) INTO v_rent_requests
    FROM public.rent_requests rr
    WHERE rr.agent_id = p_user_id
      AND rr.tenant_id IS NOT NULL
      AND rr.agent_id <> rr.tenant_id;
    v_rent_history_bonus := LEAST(v_rent_requests * 9000, 1500000);

    -- Driver 4: activated promissory notes.
    SELECT COUNT(*) INTO v_promissory_count
    FROM public.promissory_notes pn
    WHERE pn.agent_id = p_user_id
      AND (pn.status IN ('activated','approved') OR pn.approved_at IS NOT NULL);
    v_partners_bonus := LEAST(v_promissory_count * 9000, 600000);

    -- Retired for agents.
    v_houses_listed_bonus := 0;
    v_rating_bonus := 0;
    v_receipt_bonus := 0;
    v_landlord_rent_bonus := 0;

  ELSE
    -- Non-agent users: every ingredient cut to 30% of its previous weight.
    SELECT AVG(rating) INTO v_avg_rating FROM public.tenant_ratings WHERE tenant_id = p_user_id;
    IF v_avg_rating IS NOT NULL AND v_avg_rating > 3 THEN
      v_rating_bonus := ROUND((v_avg_rating - 3) * 150000);
    END IF;

    SELECT COUNT(*) INTO v_receipt_count FROM public.user_receipts WHERE user_id = p_user_id AND verified = true;
    v_receipt_bonus := v_receipt_count * 15000;

    SELECT COUNT(*) INTO v_completed_requests FROM public.rent_requests
      WHERE tenant_id = p_user_id AND status IN ('completed','repaid','disbursed','funded');
    v_rent_history_bonus := v_completed_requests * 60000;

    SELECT COALESCE(SUM(COALESCE(desired_rent_from_welile, monthly_rent, 0)), 0) INTO v_total_rent_collected
      FROM public.landlords WHERE registered_by = p_user_id AND tenant_id IS NOT NULL;
    v_landlord_rent_bonus := LEAST(v_total_rent_collected * 0.6, 3000000);

    SELECT COUNT(*) INTO v_houses_count FROM public.house_listings WHERE agent_id = p_user_id;
    v_houses_listed_bonus := LEAST(v_houses_count * 15000, 1500000);

    SELECT COUNT(*) INTO v_partners_count FROM public.investor_portfolios
      WHERE agent_id = p_user_id AND status IN ('active','completed');
    v_partners_bonus := LEAST(v_partners_count * 60000, 1500000);

    SELECT COUNT(*) INTO v_repayments_count FROM public.general_ledger
      WHERE user_id = p_user_id AND category = 'rent_repayment' AND direction = 'credit';
    v_rent_history_bonus := v_rent_history_bonus + LEAST(v_repayments_count * 6000, 1500000);

    -- Reversed collections excluded here too. The weighting is 60%, so the
    -- distortion would be ten times worse than on the agent branch.
    SELECT COALESCE(SUM(amount), 0) INTO v_agent_allocations_total
      FROM public.agent_collections WHERE agent_id = p_user_id AND reversed_at IS NULL;
    v_agent_allocations_bonus := LEAST(v_agent_allocations_total * 0.6, 9000000);

    v_subagents_bonus := 0;
  END IF;

  v_total := LEAST(
    20000 + v_rating_bonus + v_receipt_bonus + v_rent_history_bonus
          + v_landlord_rent_bonus + v_houses_listed_bonus + v_partners_bonus
          + v_agent_allocations_bonus + v_subagents_bonus,
    9000000
  );

  INSERT INTO public.credit_access_limits (
    user_id, base_limit, bonus_from_ratings, bonus_from_receipts,
    bonus_from_rent_history, bonus_from_landlord_rent,
    bonus_from_houses_listed, bonus_from_partners_onboarded,
    bonus_from_agent_allocations, bonus_from_subagents
  ) VALUES (
    p_user_id, 20000, v_rating_bonus, v_receipt_bonus,
    v_rent_history_bonus, v_landlord_rent_bonus,
    v_houses_listed_bonus, v_partners_bonus,
    v_agent_allocations_bonus, v_subagents_bonus
  )
  ON CONFLICT (user_id) DO UPDATE SET
    base_limit = 20000,
    bonus_from_ratings = v_rating_bonus,
    bonus_from_receipts = v_receipt_bonus,
    bonus_from_rent_history = v_rent_history_bonus,
    bonus_from_landlord_rent = v_landlord_rent_bonus,
    bonus_from_houses_listed = v_houses_listed_bonus,
    bonus_from_partners_onboarded = v_partners_bonus,
    bonus_from_agent_allocations = v_agent_allocations_bonus,
    bonus_from_subagents = v_subagents_bonus,
    updated_at = now();

  RETURN v_total;
END;
$function$;

-- Re-run for every agent holding a reversed collection. Idempotent: the
-- function recomputes from current data, so running it again is a no-op once
-- the limits are right.
SELECT public.recalculate_credit_limit(c.agent_id)
FROM (SELECT DISTINCT agent_id FROM public.agent_collections WHERE reversed_at IS NOT NULL) c
WHERE c.agent_id IS NOT NULL;

-- Post-condition: no agent's collection bonus may exceed 6% of their GENUINE
-- lifetime collections (allowing a shilling of rounding, and the 2.4M cap).
DO $verify$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(format('%s: bonus %s vs genuine-max %s', p.full_name, l.bonus_from_agent_allocations, x.cap), '; ')
    INTO v_bad
  FROM public.credit_access_limits l
  JOIN profiles p ON p.id = l.user_id
  CROSS JOIN LATERAL (
    SELECT LEAST(COALESCE((SELECT SUM(amount) FROM public.agent_collections
                            WHERE agent_id = l.user_id AND reversed_at IS NULL), 0) * 0.06, 2400000) AS cap
  ) x
  WHERE l.user_id IN (SELECT DISTINCT agent_id FROM public.agent_collections WHERE reversed_at IS NOT NULL)
    AND l.bonus_from_agent_allocations > x.cap + 1;

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'credit limits still priced on reversed collections: %', v_bad;
  END IF;
END
$verify$;

-- STILL OPEN - commission reporting.
--
-- `agent_reverse_tenant_allocation` already posts a commission reversal
-- correctly: agent_commission_earned, direction cash_out, wallet scope. The
-- fault is in the READERS. Every commission aggregation filters
--
--     direction IN ('cash_in','credit')
--
-- so it sums gross commission credited and silently ignores every reversal in
-- the same category. They should net:
--
--     sum(CASE WHEN direction IN ('cash_in','credit') THEN amount ELSE -amount END)
--
-- over the commission categories, with cash_out/debit admitted to the filter.
-- Four places in get_agent_ops_overview alone (commission_curr,
-- commission_prev, the trend `comm` CTE, the top-performers `commissions` CTE),
-- plus the other commission reports.
--
-- Separately, the 589,736.80 commission clawback posted during the incident
-- cleanup on 2026-09-10 was filed under `system_balance_correction`, not a
-- commission category, so netting alone will not catch that one row. It cannot
-- simply be re-categorised: a posted ledger row is immutable, and editing one
-- to fix a report is the wrong instinct. The accounting-correct remedy is a
-- compensating pair that nets to zero on the wallet - cash_in under
-- system_balance_correction, cash_out under agent_commission_earned - which
-- needs an explicit decision before it is posted.
--
-- Until both are done, today's fleet commission figure reads 3,353,758.80
-- against a true 2,764,022.
