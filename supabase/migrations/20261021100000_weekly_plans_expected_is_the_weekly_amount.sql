-- A weekly tenant's expected amount is what they owe that day, not a seventh of it.
--
-- eligible_rents computed due_today_amount as LEAST(pin_today, daily_repayment).
-- For a daily plan that is a no-op — the pin is already one day's amount, and on
-- 2026-10-20/21 not one of 1,759 daily lines exceeded the daily rate. For a
-- weekly plan it is destructive: the pin correctly bills a full week on the due
-- day, and the cap squashed it back to a single day.
--
-- `daily_repayment` is just total_repayment / duration_days — the daily
-- equivalent of a plan that is actually paid weekly. Zeliida Nanyondo's plan is
-- 3,345,000 over 30 days, so 111,500 a day and 780,500 a week. The pin bills her
-- 780,500 on her due day, which is exactly what she owes; the view was calling
-- it 111,500.
--
-- Across the 11 weekly lines on the two days in question the cap turned
-- 2,664,331 of real expectation into 380,621. On 2026-10-21 that was the entire
-- gap between the pinned bill (20,477,611) and the view (18,317,603).
--
-- The effect is not a "spike" on due days, which is how this was first read. A
-- weekly tenant genuinely owes nothing on six days and a week's rent on the
-- seventh, and the agent cannot collect from them in between. JAMES KATONGOLE
-- reading 12% rather than 44% on his due day is the honest figure: his real ask
-- that day is 1,851,168 and he had collected 224,466.
--
-- Posting is unaffected — the gate counts tenants reached, not shillings
-- (20261020100000). This corrects the money figures: expected_daily, the raw
-- percentages, the capacity strip's "of UGX X", and the Agent Ops reports.
DO $mig$
DECLARE
  v_def text;
  v_old text;
BEGIN
  v_def := pg_get_viewdef('public.v_agent_daily_eligibility'::regclass, true);

  v_old := 'LEAST(COALESCE(pd.pin_today, 0::numeric), COALESCE(lr.daily_repayment, 0::numeric))';
  IF position(v_old in v_def) = 0 THEN
    RAISE EXCEPTION 'v_agent_daily_eligibility: pin_today cap not found in the shape this migration expects';
  END IF;
  v_def := replace(v_def, v_old, 'COALESCE(pd.pin_today, 0::numeric)');

  v_old := 'LEAST(COALESCE(pd.pin_yesterday, 0::numeric), COALESCE(lr.daily_repayment, 0::numeric))';
  IF position(v_old in v_def) = 0 THEN
    RAISE EXCEPTION 'v_agent_daily_eligibility: pin_yesterday cap not found in the shape this migration expects';
  END IF;
  v_def := replace(v_def, v_old, 'COALESCE(pd.pin_yesterday, 0::numeric)');

  EXECUTE format('CREATE OR REPLACE VIEW public.v_agent_daily_eligibility AS %s', v_def);
  -- CREATE OR REPLACE VIEW does not carry reloptions forward; without this the
  -- view silently loses security_invoker (see 20261019110000).
  EXECUTE 'ALTER VIEW public.v_agent_daily_eligibility SET (security_invoker = on)';
END
$mig$;
