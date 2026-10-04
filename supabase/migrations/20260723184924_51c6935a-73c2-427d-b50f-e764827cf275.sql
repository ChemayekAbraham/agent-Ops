
-- 1. Ledger columns for bonus restriction
ALTER TABLE public.general_ledger
  ADD COLUMN IF NOT EXISTS withdrawable_after timestamptz,
  ADD COLUMN IF NOT EXISTS maturity_condition text,
  ADD COLUMN IF NOT EXISTS maturity_met boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS maturity_subject_id uuid,
  ADD COLUMN IF NOT EXISTS maturity_expired boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS matured_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_gl_maturity_pending
  ON public.general_ledger(user_id, category)
  WHERE ledger_scope='wallet' AND direction IN ('cash_in','credit')
    AND maturity_met = false AND maturity_expired = false;

CREATE INDEX IF NOT EXISTS idx_gl_maturity_subject
  ON public.general_ledger(maturity_subject_id)
  WHERE maturity_subject_id IS NOT NULL AND maturity_met = false;

-- 2. Config helper: restricted category -> maturity condition + hold window (days)
CREATE OR REPLACE FUNCTION public.bonus_restriction_config(p_category text)
RETURNS TABLE(restricted boolean, condition text, hold_days integer)
LANGUAGE sql IMMUTABLE
SET search_path = public
AS $$
  SELECT
    p_category = ANY(ARRAY[
      'referral_bonus','agent_bonus','agent_listing_bonus','agent_listing_campaign_bonus',
      'tenant_placement_bonus','landlord_verification_bonus','landlord_referral_bonus',
      'lc1_verification_bonus','lc1_referral_bonus','recruiter_override'
    ]),
    CASE p_category
      WHEN 'referral_bonus'                 THEN 'invitee_productive'
      WHEN 'agent_bonus'                    THEN 'listing_verified'
      WHEN 'agent_listing_bonus'            THEN 'listing_verified'
      WHEN 'agent_listing_campaign_bonus'   THEN 'listing_verified'
      WHEN 'tenant_placement_bonus'         THEN 'listing_verified_with_tenant'
      WHEN 'landlord_verification_bonus'    THEN 'landlord_verified'
      WHEN 'landlord_referral_bonus'        THEN 'landlord_verified'
      WHEN 'lc1_verification_bonus'         THEN 'lc1_verified'
      WHEN 'lc1_referral_bonus'             THEN 'lc1_verified'
      WHEN 'recruiter_override'             THEN 'subagent_productive'
      ELSE NULL
    END,
    3;
$$;

-- 3. BEFORE INSERT trigger stamps restricted rows
CREATE OR REPLACE FUNCTION public.trg_apply_bonus_restriction_fn()
RETURNS trigger LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  r_restr boolean;
  r_cond  text;
  r_days  integer;
BEGIN
  IF NEW.ledger_scope = 'wallet' AND NEW.direction IN ('cash_in','credit') THEN
    SELECT restricted, condition, hold_days
      INTO r_restr, r_cond, r_days
      FROM public.bonus_restriction_config(NEW.category);
    IF COALESCE(r_restr, false) THEN
      NEW.withdrawable_after  := COALESCE(NEW.withdrawable_after, COALESCE(NEW.created_at, now()) + make_interval(days => r_days));
      NEW.maturity_condition  := COALESCE(NEW.maturity_condition, r_cond);
      NEW.maturity_met        := false;
      NEW.maturity_expired    := false;
      NEW.maturity_subject_id := COALESCE(NEW.maturity_subject_id, NEW.source_id);
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_apply_bonus_restriction ON public.general_ledger;
CREATE TRIGGER trg_apply_bonus_restriction
  BEFORE INSERT ON public.general_ledger
  FOR EACH ROW EXECUTE FUNCTION public.trg_apply_bonus_restriction_fn();

-- 4. Maturity helpers
CREATE OR REPLACE FUNCTION public.mature_bonus_by_subject(p_condition text, p_subject_id uuid)
RETURNS integer LANGUAGE sql
SET search_path = public
AS $$
  WITH upd AS (
    UPDATE public.general_ledger
       SET maturity_met = true, matured_at = now()
     WHERE ledger_scope = 'wallet'
       AND direction IN ('cash_in','credit')
       AND maturity_condition = p_condition
       AND maturity_subject_id = p_subject_id
       AND maturity_met = false
       AND maturity_expired = false
       AND now() <= withdrawable_after
     RETURNING id
  )
  SELECT count(*)::int FROM upd;
$$;

-- Mature referral_bonus rows for the referrer when invitee performs a productive act
CREATE OR REPLACE FUNCTION public.mature_referral_bonuses_for_invitee(p_invitee_id uuid)
RETURNS integer LANGUAGE sql
SET search_path = public
AS $$
  WITH invitee AS (SELECT p_invitee_id AS id),
  refs AS (
    SELECT referrer_id FROM public.referrals WHERE referred_id = p_invitee_id
    UNION
    SELECT referrer_id FROM public.profiles
      WHERE id = p_invitee_id AND referrer_id IS NOT NULL
  ),
  upd AS (
    UPDATE public.general_ledger gl
       SET maturity_met = true, matured_at = now()
      FROM refs
     WHERE gl.user_id = refs.referrer_id
       AND gl.ledger_scope = 'wallet'
       AND gl.direction IN ('cash_in','credit')
       AND gl.category = 'referral_bonus'
       AND gl.maturity_met = false
       AND gl.maturity_expired = false
       AND now() <= gl.withdrawable_after
     RETURNING gl.id
  )
  SELECT count(*)::int FROM upd;
$$;

-- 5. Productivity triggers

-- a. Rent request posted by a tenant -> mature referrer bonus
CREATE OR REPLACE FUNCTION public.trg_mature_on_rent_request_fn()
RETURNS trigger LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.tenant_id IS NOT NULL THEN
    PERFORM public.mature_referral_bonuses_for_invitee(NEW.tenant_id);
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_mature_on_rent_request ON public.rent_requests;
CREATE TRIGGER trg_mature_on_rent_request
  AFTER INSERT ON public.rent_requests
  FOR EACH ROW EXECUTE FUNCTION public.trg_mature_on_rent_request_fn();

-- b. House listing verified -> mature listing bonuses + referrer of the listing agent
CREATE OR REPLACE FUNCTION public.trg_mature_on_house_verified_fn()
RETURNS trigger LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF COALESCE(NEW.verified, false) = true AND COALESCE(OLD.verified, false) = false THEN
    PERFORM public.mature_bonus_by_subject('listing_verified', NEW.id);
    IF NEW.tenant_id IS NOT NULL THEN
      PERFORM public.mature_bonus_by_subject('listing_verified_with_tenant', NEW.id);
    END IF;
    IF NEW.agent_id IS NOT NULL THEN
      PERFORM public.mature_referral_bonuses_for_invitee(NEW.agent_id);
    END IF;
  END IF;
  IF NEW.tenant_id IS NOT NULL AND OLD.tenant_id IS NULL AND COALESCE(NEW.verified, false) = true THEN
    PERFORM public.mature_bonus_by_subject('listing_verified_with_tenant', NEW.id);
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_mature_on_house_verified ON public.house_listings;
CREATE TRIGGER trg_mature_on_house_verified
  AFTER UPDATE OF verified, tenant_id ON public.house_listings
  FOR EACH ROW EXECUTE FUNCTION public.trg_mature_on_house_verified_fn();

-- c. Landlord verified -> mature landlord bonuses + referrer of registering agent
CREATE OR REPLACE FUNCTION public.trg_mature_on_landlord_verified_fn()
RETURNS trigger LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF COALESCE(NEW.verified, false) = true AND COALESCE(OLD.verified, false) = false THEN
    PERFORM public.mature_bonus_by_subject('landlord_verified', NEW.id);
    IF NEW.registered_by IS NOT NULL THEN
      PERFORM public.mature_referral_bonuses_for_invitee(NEW.registered_by);
    END IF;
    IF NEW.managed_by_agent_id IS NOT NULL THEN
      PERFORM public.mature_referral_bonuses_for_invitee(NEW.managed_by_agent_id);
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_mature_on_landlord_verified ON public.landlords;
CREATE TRIGGER trg_mature_on_landlord_verified
  AFTER UPDATE OF verified ON public.landlords
  FOR EACH ROW EXECUTE FUNCTION public.trg_mature_on_landlord_verified_fn();

-- d. LC1 verified -> mature LC1 bonuses + referrer of the registering agent
CREATE OR REPLACE FUNCTION public.trg_mature_on_lc1_verified_fn()
RETURNS trigger LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF COALESCE(NEW.verified, false) = true AND COALESCE(OLD.verified, false) = false THEN
    PERFORM public.mature_bonus_by_subject('lc1_verified', NEW.id);
    -- lc1_chairpersons.registered_by if present
    BEGIN
      PERFORM public.mature_referral_bonuses_for_invitee((row_to_json(NEW)->>'registered_by')::uuid);
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_mature_on_lc1_verified ON public.lc1_chairpersons;
CREATE TRIGGER trg_mature_on_lc1_verified
  AFTER UPDATE OF verified ON public.lc1_chairpersons
  FOR EACH ROW EXECUTE FUNCTION public.trg_mature_on_lc1_verified_fn();

-- 6. Expire past-window unmatured bonuses (called by cron + inline check)
CREATE OR REPLACE FUNCTION public.expire_stale_bonus_restrictions()
RETURNS integer LANGUAGE sql
SET search_path = public
AS $$
  WITH upd AS (
    UPDATE public.general_ledger
       SET maturity_expired = true
     WHERE ledger_scope = 'wallet'
       AND direction IN ('cash_in','credit')
       AND maturity_met = false
       AND maturity_expired = false
       AND withdrawable_after IS NOT NULL
       AND now() > withdrawable_after
     RETURNING id
  )
  SELECT count(*)::int FROM upd;
$$;

-- 7. Per-user held-restricted computation (used by wallet view + hold list RPC)
CREATE OR REPLACE FUNCTION public.get_user_restricted_held(p_user_id uuid)
RETURNS numeric LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT COALESCE(SUM(amount), 0)::numeric
    FROM public.general_ledger
   WHERE user_id = p_user_id
     AND ledger_scope = 'wallet'
     AND direction IN ('cash_in','credit')
     AND (
       (maturity_met = false AND maturity_expired = false AND now() <= COALESCE(withdrawable_after, now() + interval '3 days'))
       OR maturity_expired = true
     );
$$;

CREATE OR REPLACE FUNCTION public.get_user_wallet_holds(p_user_id uuid)
RETURNS TABLE(
  id uuid,
  created_at timestamptz,
  amount numeric,
  category text,
  condition text,
  subject_id uuid,
  releases_at timestamptz,
  matured boolean,
  expired boolean,
  status text
)
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT gl.id, gl.created_at, gl.amount, gl.category,
         gl.maturity_condition, gl.maturity_subject_id, gl.withdrawable_after,
         gl.maturity_met, gl.maturity_expired,
         CASE
           WHEN gl.maturity_expired THEN 'expired'
           WHEN gl.maturity_met     THEN 'released'
           ELSE 'pending'
         END AS status
    FROM public.general_ledger gl
   WHERE gl.user_id = p_user_id
     AND gl.ledger_scope = 'wallet'
     AND gl.direction IN ('cash_in','credit')
     AND (gl.maturity_met = false OR gl.maturity_expired = true)
   ORDER BY gl.created_at DESC;
$$;

-- 8. Rewrite v_user_wallet_strict to subtract held-restricted from withdrawable
DROP VIEW IF EXISTS public.v_user_wallet_strict CASCADE;
CREATE VIEW public.v_user_wallet_strict AS
WITH anchors AS (
  SELECT user_id, anchor_at FROM public.wallet_fresh_start_anchors
),
ledger AS (
  SELECT gl.user_id, gl.category, gl.direction, gl.amount, gl.wallet_bucket,
         gl.maturity_met, gl.maturity_expired, gl.withdrawable_after
    FROM public.general_ledger gl
    LEFT JOIN anchors a ON a.user_id = gl.user_id
   WHERE gl.ledger_scope = 'wallet'
     AND (gl.classification IS NULL OR gl.classification = 'production'
          OR (gl.classification = 'admin_correction' AND gl.category = 'system_balance_correction' AND gl.direction IN ('debit','cash_out')))
     AND (a.anchor_at IS NULL OR gl.created_at >= a.anchor_at)
),
routed_explicit AS (
  SELECT user_id, amount, wallet_bucket AS bucket,
         CASE WHEN direction IN ('cash_in','credit') THEN 1
              WHEN direction IN ('cash_out','debit') THEN -1
              ELSE 0 END AS sign,
         maturity_met, maturity_expired, withdrawable_after, direction, category
    FROM ledger
   WHERE wallet_bucket IN ('withdrawable','float','advance_credit','advance_repayment')
),
routed_category AS (
  SELECT l.user_id, l.amount, r.bucket, r.sign,
         l.maturity_met, l.maturity_expired, l.withdrawable_after, l.direction, l.category
    FROM ledger l
    CROSS JOIN LATERAL public.wallet_route_for_category(l.user_id, l.category, l.direction) r(bucket, sign)
   WHERE l.wallet_bucket IS NULL
),
routed AS (
  SELECT * FROM routed_explicit
  UNION ALL
  SELECT * FROM routed_category
),
buckets AS (
  SELECT user_id,
    SUM(CASE WHEN bucket='withdrawable' THEN sign*amount ELSE 0 END) AS withdrawable_raw,
    SUM(CASE WHEN bucket='float' THEN sign*amount ELSE 0 END) AS float_raw,
    SUM(CASE WHEN bucket IN ('advance_credit','advance_repayment') THEN sign*amount ELSE 0 END) AS advance_raw,
    -- Restricted credits still sitting in withdrawable bucket
    SUM(CASE
          WHEN bucket='withdrawable' AND direction IN ('cash_in','credit')
               AND (maturity_expired = true
                    OR (maturity_met = false AND now() <= COALESCE(withdrawable_after, now())))
          THEN amount ELSE 0 END) AS restricted_held
    FROM routed
   GROUP BY user_id
),
holds AS (
  SELECT CASE WHEN wr.proxy_partner_id IS NOT NULL AND wr.agent_id IS NOT NULL THEN wr.agent_id
              ELSE wr.user_id END AS user_id,
         COALESCE(SUM(wr.amount), 0) AS pending_holds
    FROM public.withdrawal_requests wr
   WHERE wr.status IN ('pending','requested','manager_approved','processing','approved')
     AND NOT EXISTS (SELECT 1 FROM public.general_ledger g
                      WHERE g.source_table='withdrawal_requests' AND g.source_id=wr.id
                        AND g.ledger_scope='wallet' AND g.direction IN ('cash_out','debit'))
     AND (wr.reason IS NULL OR wr.reason NOT LIKE 'Landlord float payout%')
   GROUP BY 1
),
universe AS (
  SELECT user_id FROM public.wallets_physical
  UNION SELECT user_id FROM buckets
  UNION SELECT user_id FROM holds
)
SELECT u.user_id,
  GREATEST(0, COALESCE(b.withdrawable_raw, 0) - COALESCE(b.restricted_held, 0) - COALESCE(h.pending_holds, 0)) AS withdrawable,
  GREATEST(0, COALESCE(b.float_raw, 0))  AS float_balance,
  GREATEST(0, COALESCE(b.advance_raw, 0)) AS advance_balance,
  COALESCE(h.pending_holds, 0)  AS pending_holds,
  COALESCE(b.restricted_held, 0) AS restricted_held,
  GREATEST(0, COALESCE(b.withdrawable_raw, 0) - COALESCE(b.restricted_held, 0) - COALESCE(h.pending_holds, 0))
    + GREATEST(0, COALESCE(b.float_raw, 0)) AS total_visible
FROM universe u
LEFT JOIN buckets b ON b.user_id = u.user_id
LEFT JOIN holds   h ON h.user_id = u.user_id;

GRANT SELECT ON public.v_user_wallet_strict TO authenticated, service_role;

-- 9. Extend get_user_wallet_view to expose restricted_held
CREATE OR REPLACE FUNCTION public.get_user_wallet_view(p_user_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v jsonb;
  v_restricted numeric := 0;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object(
      'user_id', NULL, 'withdrawable', 0, 'float_balance', 0,
      'advance_balance', 0, 'pending_holds', 0, 'total_visible', 0,
      'withdrawable_raw', 0, 'float_raw', 0, 'advance_raw', 0,
      'restricted_held', 0
    );
  END IF;

  -- Best-effort expire stale rows for THIS user before computing
  UPDATE public.general_ledger
     SET maturity_expired = true
   WHERE user_id = p_user_id
     AND ledger_scope = 'wallet'
     AND direction IN ('cash_in','credit')
     AND maturity_met = false
     AND maturity_expired = false
     AND withdrawable_after IS NOT NULL
     AND now() > withdrawable_after;

  SELECT to_jsonb(s) INTO v FROM public.v_user_wallet_strict s WHERE s.user_id = p_user_id;

  IF v IS NULL THEN
    RETURN jsonb_build_object(
      'user_id', p_user_id, 'withdrawable', 0, 'float_balance', 0,
      'advance_balance', 0, 'pending_holds', 0, 'total_visible', 0,
      'withdrawable_raw', 0, 'float_raw', 0, 'advance_raw', 0,
      'restricted_held', 0
    );
  END IF;

  RETURN v || jsonb_build_object('restricted_held', COALESCE((v->>'restricted_held')::numeric, 0));
END;
$$;

-- 10. Nightly expiry cron
DO $$
BEGIN
  PERFORM cron.unschedule('expire-stale-bonus-restrictions');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;
SELECT cron.schedule(
  'expire-stale-bonus-restrictions',
  '15 * * * *',
  $$SELECT public.expire_stale_bonus_restrictions();$$
);
