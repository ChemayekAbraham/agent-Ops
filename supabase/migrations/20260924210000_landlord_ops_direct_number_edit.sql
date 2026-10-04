-- Landlord Ops may edit a verified landlord's number directly (Josh,
-- 2026-09-24) — but every such edit is treated as a serious event.
--
-- Before: lock_verified_landlord_numbers() (doc 120) reverted EVERY direct
-- change to phone / mobile_money_number on a verified landlord and opened a
-- 4-stage change request (service centre → tenant ops → agent ops →
-- landlord ops). Nobody could edit directly.
--
-- After:
--   * An actor holding an ENABLED landlord_ops role edits directly. The new
--     number is applied AND, when it is the payout number, moved into
--     verified_mobile_money_number — enforce_landlord_payout_eligibility pays
--     only that column, so editing mobile_money_number alone would silently
--     keep paying the old number.
--   * Everyone else is unchanged: reverted + change request.
--   * Hard stop for everyone: the new number may not already belong to a
--     DIFFERENT landlord (same rule enforce_unique_landlord_phone applies on
--     INSERT). That is exactly the doc-128 failure — Kalule Brian's landlord
--     was being re-numbered onto another verified landlord's number on a
--     record shared with a different tenant. Raises, so the UI shows why.
--   * Every landlord-ops direct edit writes landlord_number_audit
--     ('landlord_ops_direct_edit') AND a row in the new review queue
--     landlord_number_direct_edits with risk flags (shared across tenants,
--     open landlord payouts, recent repeat edits) for CTO/CEO/COO review.
--
-- Trigger order note: trg_aa_landlord_verification_gate runs BEFORE this
-- trg_ab_* trigger, so changing NEW.verified_mobile_money_number here is not
-- re-checked by the gate; guard_landlord_sensitive_columns does not touch the
-- verified_mobile_money_* columns.

-- 1. Review queue ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.landlord_number_direct_edits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  landlord_id uuid NOT NULL REFERENCES public.landlords(id),
  field text NOT NULL,
  old_value text,
  new_value text,
  payout_number_changed boolean NOT NULL DEFAULT false,
  actor uuid,
  risk_flags text[] NOT NULL DEFAULT '{}',
  tenants_on_record integer NOT NULL DEFAULT 0,
  open_payouts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by uuid,
  reviewed_at timestamptz,
  review_outcome text CHECK (review_outcome IN ('confirmed_legitimate', 'suspicious', 'reverted')),
  review_note text
);
CREATE INDEX IF NOT EXISTS landlord_number_direct_edits_unreviewed_idx
  ON public.landlord_number_direct_edits (created_at DESC) WHERE reviewed_at IS NULL;

ALTER TABLE public.landlord_number_direct_edits ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Executives and landlord ops read direct number edits" ON public.landlord_number_direct_edits;
CREATE POLICY "Executives and landlord ops read direct number edits"
  ON public.landlord_number_direct_edits FOR SELECT TO authenticated
  USING (public._has_enabled_role(auth.uid(), ARRAY['cto', 'ceo', 'coo', 'cfo', 'super_admin', 'landlord_ops']));
-- No INSERT/UPDATE/DELETE policies: rows are written only by the trigger and
-- reviewed only through review_landlord_number_direct_edit().

-- 2. Lock trigger: landlord ops bypass + duplicate-number hard stop ----------
CREATE OR REPLACE FUNCTION public.lock_verified_landlord_numbers()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_field text;
  v_old text;
  v_new text;
  v_req uuid;
  v_is_lops boolean;
  v_dup_name text;
  v_is_payout boolean;
  v_flags text[];
  v_tenants int;
  v_open int;
  v_recent int;
BEGIN
  -- Only the final Landlord Ops approval in review_landlord_number_change()
  -- sets this flag.
  IF COALESCE(current_setting('landlord_numbers.change_authorized', true), '') = 'true' THEN
    RETURN NEW;
  END IF;
  -- Before verification the number isn't approved yet; verification itself
  -- is the chain that approves it.
  IF NOT (COALESCE(OLD.verified, false) OR OLD.verified_mobile_money_number IS NOT NULL) THEN
    RETURN NEW;
  END IF;

  v_is_lops := v_actor IS NOT NULL AND public._has_enabled_role(v_actor, ARRAY['landlord_ops']);

  FOREACH v_field IN ARRAY ARRAY['phone', 'mobile_money_number'] LOOP
    IF v_field = 'phone' THEN
      v_old := OLD.phone; v_new := NEW.phone;
      NEW.phone := OLD.phone;
    ELSE
      v_old := OLD.mobile_money_number; v_new := NEW.mobile_money_number;
      NEW.mobile_money_number := OLD.mobile_money_number;
    END IF;

    CONTINUE WHEN v_new IS NOT DISTINCT FROM v_old;
    -- formatting-only difference (0772… vs +256772…): keep the stored value
    CONTINUE WHEN public.landlord_number_norm(v_new) = public.landlord_number_norm(v_old)
                  AND public.landlord_number_norm(v_new) <> '';

    -- Hard stop (everyone): a number already registered to another landlord.
    IF length(public.landlord_number_norm(v_new)) >= 9 THEN
      SELECT l.name INTO v_dup_name
        FROM public.landlords l
       WHERE l.id <> OLD.id
         AND public.landlord_number_norm(v_new) IN (
               public.landlord_number_norm(l.phone),
               public.landlord_number_norm(l.mobile_money_number),
               public.landlord_number_norm(l.verified_mobile_money_number))
       LIMIT 1;
      IF FOUND THEN
        INSERT INTO public.landlord_number_audit
          (landlord_id, field, event, old_value, new_value, actor, comment)
        VALUES (OLD.id, v_field, 'direct_edit_blocked_duplicate', v_old, v_new, v_actor,
          'Blocked: number already belongs to another landlord (' || COALESCE(v_dup_name, '?') || ')');
        RAISE EXCEPTION 'This number is already registered to another landlord (%). If this tenant''s landlord is that person, attach the rent plan to that landlord instead of changing this landlord''s number.',
          COALESCE(v_dup_name, 'unknown') USING ERRCODE = '23505';
      END IF;
    END IF;

    -- Landlord Ops: apply directly, flag for review.
    IF v_is_lops AND length(regexp_replace(COALESCE(v_new, ''), '\D', '', 'g')) BETWEEN 9 AND 15 THEN
      IF v_field = 'phone' THEN NEW.phone := v_new; ELSE NEW.mobile_money_number := v_new; END IF;

      -- Payout number = mobile_money_number, falling back to phone when no
      -- MoMo number is on file (same resolution as review_landlord_number_change).
      v_is_payout := v_field = 'mobile_money_number'
                     OR (v_field = 'phone' AND NULLIF(btrim(COALESCE(NEW.mobile_money_number, '')), '') IS NULL);
      v_is_payout := v_is_payout AND OLD.verification_status = 'verified';
      IF v_is_payout THEN
        NEW.verified_mobile_money_number := v_new;
        NEW.verified_mobile_money_set_at := now();
        NEW.verified_mobile_money_source := 'landlord_ops_direct_edit';
      END IF;

      SELECT count(DISTINCT r.tenant_id) INTO v_tenants
        FROM public.rent_requests r WHERE r.landlord_id = OLD.id;
      SELECT count(*) INTO v_open
        FROM public.landlord_payouts lp
       WHERE lp.landlord_id = OLD.id
         AND lp.status IN ('otp_verified', 'pending_merchant_payout', 'pending_finops_disbursement', 'disbursing');
      SELECT count(*) INTO v_recent
        FROM public.landlord_number_direct_edits e
       WHERE e.landlord_id = OLD.id AND e.created_at > now() - interval '30 days';

      v_flags := ARRAY[]::text[];
      IF v_tenants > 1 THEN v_flags := array_append(v_flags, 'shared_across_tenants'); END IF;
      IF v_open > 0 THEN v_flags := array_append(v_flags, 'open_landlord_payouts'); END IF;
      IF v_recent > 0 THEN v_flags := array_append(v_flags, 'repeat_edit_30d'); END IF;
      IF v_is_payout THEN v_flags := array_append(v_flags, 'payout_number_changed'); END IF;

      INSERT INTO public.landlord_number_direct_edits
        (landlord_id, field, old_value, new_value, payout_number_changed, actor, risk_flags, tenants_on_record, open_payouts)
      VALUES (OLD.id, v_field, v_old, v_new, v_is_payout, v_actor, v_flags, v_tenants, v_open);

      INSERT INTO public.landlord_number_audit
        (landlord_id, field, event, old_value, new_value, actor, comment)
      VALUES (OLD.id, v_field, 'landlord_ops_direct_edit', v_old, v_new, v_actor,
        'Applied directly by Landlord Ops' ||
        CASE WHEN v_is_payout THEN '; approved payout number moved to the new number' ELSE '' END ||
        CASE WHEN cardinality(v_flags) > 0 THEN '; risk: ' || array_to_string(v_flags, ', ') ELSE '' END);
      CONTINUE;
    END IF;

    -- Everyone else (and invalid values): unchanged doc-120 behaviour.
    v_req := NULL;
    IF length(regexp_replace(COALESCE(v_new, ''), '\D', '', 'g')) BETWEEN 9 AND 15 THEN
      v_req := public._create_landlord_number_change_request(
        OLD.id, v_field, v_old, v_new, v_actor, 'direct_edit_blocked', NULL);
    END IF;

    INSERT INTO public.landlord_number_audit
      (landlord_id, request_id, field, event, old_value, new_value, actor, comment)
    VALUES (OLD.id, v_req, v_field, 'direct_edit_blocked', v_old, v_new, v_actor,
      CASE WHEN v_req IS NULL
        THEN 'Blocked: verified landlord number cannot be cleared or set to an invalid value'
        ELSE 'Blocked: verified landlord number is locked; change request created at service centre stage' END);
  END LOOP;

  RETURN NEW;
END;
$function$;

-- 3. Review action (executives) ---------------------------------------------
CREATE OR REPLACE FUNCTION public.review_landlord_number_direct_edit(
  p_edit_id uuid, p_outcome text, p_note text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_actor uuid := auth.uid();
  e public.landlord_number_direct_edits;
BEGIN
  IF v_actor IS NULL OR NOT public._has_enabled_role(v_actor, ARRAY['cto', 'ceo', 'coo', 'super_admin']) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;
  IF p_outcome NOT IN ('confirmed_legitimate', 'suspicious', 'reverted') THEN
    RAISE EXCEPTION 'Outcome must be confirmed_legitimate, suspicious or reverted';
  END IF;
  IF length(btrim(COALESCE(p_note, ''))) < 10 THEN
    RAISE EXCEPTION 'Record what you checked (at least 10 characters)';
  END IF;

  SELECT * INTO e FROM public.landlord_number_direct_edits WHERE id = p_edit_id FOR UPDATE;
  IF e.id IS NULL THEN RAISE EXCEPTION 'Direct edit not found'; END IF;
  IF e.actor = v_actor THEN
    RAISE EXCEPTION 'You cannot review a number change you made yourself' USING ERRCODE = '42501';
  END IF;

  UPDATE public.landlord_number_direct_edits
     SET reviewed_by = v_actor, reviewed_at = now(), review_outcome = p_outcome, review_note = btrim(p_note)
   WHERE id = e.id;

  INSERT INTO public.landlord_number_audit (landlord_id, field, event, old_value, new_value, actor, comment)
  VALUES (e.landlord_id, e.field, 'direct_edit_reviewed', e.old_value, e.new_value, v_actor,
          p_outcome || ': ' || btrim(p_note));

  RETURN jsonb_build_object('ok', true, 'id', e.id, 'outcome', p_outcome);
END;
$$;

REVOKE ALL ON FUNCTION public.review_landlord_number_direct_edit(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.review_landlord_number_direct_edit(uuid, text, text) TO authenticated;
GRANT SELECT ON public.landlord_number_direct_edits TO authenticated;

-- 4. Re-baseline the watched lock function in the same change ---------------
UPDATE public.critical_function_baselines
SET expected_sha256 = encode(sha256(convert_to(pg_get_functiondef('public.lock_verified_landlord_numbers()'::regprocedure), 'UTF8')), 'hex'),
    baselined_at = now(),
    baselined_by = '20260924210000_landlord_ops_direct_number_edit.sql',
    note = 'Deliberate change 2026-09-24 (Josh): Landlord Ops may edit verified numbers directly (applied + payout number moved + flagged into landlord_number_direct_edits); duplicate-number hard stop for everyone; others unchanged (change request chain).'
WHERE function_signature = 'lock_verified_landlord_numbers()';
