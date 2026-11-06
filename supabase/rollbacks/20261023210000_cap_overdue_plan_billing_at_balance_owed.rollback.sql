-- Puts back the trimmed day rows. The billing rule (pin_agent_expected_day) goes back to its previous version by re-running the function from
-- the migration that last defined it: it differs only in the "already_billed" CTE and the "- coalesce(ab.unpaid_billed, 0)" term.
INSERT INTO public.agent_expected_day_plans
  SELECT b.* FROM public.agent_expected_day_plans_backup_20261023 b
  ON CONFLICT (day, rent_request_id) DO UPDATE SET expected_ugx = EXCLUDED.expected_ugx;
-- DROP TABLE public.agent_expected_day_plans_backup_20261023;  -- keep until you are sure
