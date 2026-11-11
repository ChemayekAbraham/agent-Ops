-- Rollback for 20261115090000_co_support_phase1.sql.
-- Puts back the exact live bodies of the four changed objects and removes every
-- co-support object. Refuses while any co-supported plan has live funding:
-- unwinding real money needs its own plan first.
SET client_encoding = 'UTF8';
SET lock_timeout = '5s';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.partner_self_funding_lines
              WHERE co_support_id IS NOT NULL AND status <> 'cancelled') THEN
    RAISE EXCEPTION 'ROLLBACK_REFUSED: co-supported plans have live funding lines';
  END IF;
END $$;

-- 1. Original bodies
CREATE OR REPLACE FUNCTION public.psm_disburse_landlord_float(p_commitment_id uuid, p_topup_id uuid DEFAULT NULL::uuid, p_rent_request_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$@@DISBURSE_ORIG@@$function$;

CREATE OR REPLACE FUNCTION public.psm_activate_line_on_disbursement()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$@@ACTIVATE_ORIG@@$function$;

CREATE OR REPLACE FUNCTION public.funder_pending_hold(p_user_id uuid)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN (
  SELECT COALESCE(SUM(f.amount), 0)::numeric
  FROM public.funder_pending_portfolios f
  WHERE f.funder_id = p_user_id
    AND f.status = 'pending'
    AND NOT EXISTS (
      SELECT 1 FROM public.general_ledger g
       WHERE g.ledger_scope = 'wallet'
         AND g.direction = 'cash_out'
         AND g.category IN ('partner_funding','supporter_rent_fund','portfolio_topup')
         AND (
              g.idempotency_key = 'portfolio-funding-' || f.portfolio_id::text
           OR (g.source_table = 'investor_portfolios' AND g.source_id = f.portfolio_id)
           OR (f.commitment_id IS NOT NULL
               AND g.source_table = 'partner_self_funding_lines'
               AND g.source_id IN (
                    SELECT l.id FROM public.partner_self_funding_lines l
                     WHERE l.commitment_id = f.commitment_id))
         )
    ));
END;
$function$;

CREATE OR REPLACE FUNCTION public.psm_release_self_funding_line(p_line_id uuid, p_reason text DEFAULT 'Self-support funding cancelled — plan released back to ready to fund'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$@@RELEASE_ORIG@@$function$;

CREATE OR REPLACE FUNCTION public.psm_release_plan_on_line_cancel()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$@@TRIGGER_ORIG@@$function$;

@@VIEW_ORIG@@

COMMENT ON VIEW public.v_partner_self_fundable_plans IS
  'Rent Plans a partner may fund. Plans with no assigned agent are excluded.';

-- 2. Co-support functions
DROP FUNCTION IF EXISTS public.co_support_create(uuid);
DROP FUNCTION IF EXISTS public.co_support_preview(text);
DROP FUNCTION IF EXISTS public.co_support_accept(text);
DROP FUNCTION IF EXISTS public.co_support_decline(text);
DROP FUNCTION IF EXISTS public.co_support_cancel(uuid);
DROP FUNCTION IF EXISTS public.co_support_reinvite(uuid, boolean);
DROP FUNCTION IF EXISTS public.co_support_fund_alone(uuid);
DROP FUNCTION IF EXISTS public.co_support_my_invites();
DROP FUNCTION IF EXISTS public.co_support_integrity_check();
DROP FUNCTION IF EXISTS public.co_support_staff_cancel(uuid, text);
DROP FUNCTION IF EXISTS public._co_support_disburse_landlord_float(uuid);
DROP FUNCTION IF EXISTS public._co_support_open_half(uuid, uuid, numeric, numeric, text);
DROP FUNCTION IF EXISTS public._co_support_lead_checks(uuid, uuid);
DROP FUNCTION IF EXISTS public._co_support_require_partner(uuid);
DROP FUNCTION IF EXISTS public._co_support_lock(uuid, uuid, uuid);
DROP FUNCTION IF EXISTS public._co_support_invite_json(uuid, uuid);
DROP FUNCTION IF EXISTS public._co_support_plan_problem(uuid, uuid);
DROP FUNCTION IF EXISTS public._co_support_expire_stale(uuid);
DROP FUNCTION IF EXISTS public._co_support_new_code();
DROP FUNCTION IF EXISTS public._co_support_fmt(numeric);
DROP FUNCTION IF EXISTS public._co_support_status(text, timestamptz, timestamptz);
DROP FUNCTION IF EXISTS public._co_support_first_name(uuid);
DROP FUNCTION IF EXISTS public._co_support_split(numeric);

-- 3. Funding lines back to one line per plan
DROP TRIGGER IF EXISTS trg_psfl_no_mixed_funding ON public.partner_self_funding_lines;
DROP FUNCTION IF EXISTS public._psfl_no_mixed_funding();
DROP INDEX IF EXISTS public.ux_psfl_active_plan_co_support;
DROP INDEX IF EXISTS public.idx_psfl_co_support;
DROP INDEX IF EXISTS public.ux_psfl_active_plan;
CREATE UNIQUE INDEX ux_psfl_active_plan ON public.partner_self_funding_lines USING btree (rent_request_id) WHERE (status <> 'cancelled'::text);
ALTER TABLE public.partner_self_funding_lines DROP COLUMN IF EXISTS co_support_id;

-- 4. The invites table (history included)
DROP TABLE IF EXISTS public.co_support_invites;
