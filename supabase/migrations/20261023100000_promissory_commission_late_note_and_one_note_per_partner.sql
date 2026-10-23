-- Promissory-note commission: a note that was created AFTER the partner's money came in still earns the proxy agent the 2%, as long as it is approved,
-- and a partner can only ever have ONE approved note (first note wins). One proxy agent, one note, one partner, never paid twice.
--
-- Why: commission_resolve_earner() required n.created_at <= fund-in time. Rachel Blessing Nabutiti's portfolio (UGX 700,000) went active at
-- 11:04:03 on 19 Oct and the agent's note was created at 11:09:11 and approved the same day, so the fund-in stayed 'unattributed' and the hourly
-- reconcile retried it 91 times without ever paying.
--
-- What this migration does:
--   1. commission_resolve_earner(): a note counts whether it was created before or after the fund-in. It still must be approved
--      (approval_bonus_paid) and not reversed, and the EARLIEST note for the partner still wins (first in, first out).
--      The managed-proxy branch is unchanged.
--   2. promissory_notes approval guard (BEFORE UPDATE trigger): a note cannot be approved if the same partner already has another approved,
--      non-reversed note, or has an EARLIER note that is still pending. The first note must be approved or removed first.
--      "Same partner" = same partner_user_id, or same last-9-digits of phone/WhatsApp, or same email.
--   3. After a note is approved, the partner's unattributed fund-ins are paid at once (promissory_catch_up_partner_commission), instead of
--      waiting for the next hourly reconcile. It is the same payment function the reconcile uses, so it is idempotent.
--
-- Money safety: payment still goes through commission_pay_fund_in(), which posts one ledger group per fund-in under the idempotency key
-- 'fund_in_commission:<fund_in_key>' and locks the earner to the first paid fund-in of that partner.

-- 1. Earner resolution: late notes count.
CREATE OR REPLACE FUNCTION public.commission_resolve_earner(p_partner uuid, p_at timestamp with time zone, p_use_lock boolean DEFAULT true)
RETURNS TABLE(earner_id uuid, earner_path text, note_id uuid, assignment_id uuid, basis text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_phone text; v_email text; v_name text;
BEGIN
  IF p_use_lock THEN
    RETURN QUERY
      SELECT f.earner_id, f.earner_path, f.note_id, f.assignment_id, 'locked_to_first_paid_fund_in'::text
        FROM public.commission_fund_ins f
       WHERE f.partner_id = p_partner AND f.status = 'paid'
         AND (f.earner_path IS DISTINCT FROM 'managed_proxy'
              OR EXISTS (SELECT 1 FROM public.proxy_agent_assignments a
                          WHERE a.id = f.assignment_id
                            AND a.is_active = true
                            AND coalesce(a.approval_status, 'pending') = 'approved'
                            AND (a.expires_at IS NULL OR a.expires_at > p_at)))
       ORDER BY f.occurred_at, f.created_at
       LIMIT 1;
    IF FOUND THEN RETURN; END IF;
  END IF;

  SELECT right(regexp_replace(coalesce(p.phone,''), '\D', '', 'g'), 9),
         nullif(lower(trim(coalesce(p.email,''))), ''),
         nullif(lower(regexp_replace(trim(coalesce(p.full_name,'')), '\s+', ' ', 'g')), '')
    INTO v_phone, v_email, v_name
    FROM public.profiles p WHERE p.id = p_partner;

  RETURN QUERY
  WITH c AS (
    SELECT n.agent_id AS c_earner, 'promissory_note'::text AS c_path, n.id AS c_note, NULL::uuid AS c_asg, n.created_at AS c_est
      FROM public.promissory_notes n
     WHERE n.agent_id IS NOT NULL AND n.agent_id <> p_partner
       AND coalesce(n.approval_bonus_paid, false) = true
       -- (no "created before the fund-in" test: an approved note that arrived after the money still counts; the earliest note wins)
       AND NOT EXISTS (SELECT 1 FROM public.pso_note_reversals r WHERE r.note_id = n.id)
       AND (   n.partner_user_id = p_partner
            OR (length(v_phone) = 9 AND right(regexp_replace(coalesce(n.whatsapp_number,''), '\D', '', 'g'), 9) = v_phone)
            OR (length(v_phone) = 9 AND right(regexp_replace(coalesce(n.phone_number,''), '\D', '', 'g'), 9) = v_phone)
            OR (v_email IS NOT NULL AND lower(trim(coalesce(n.email,''))) = v_email))
    UNION ALL
    SELECT a.agent_id, 'managed_proxy'::text, NULL::uuid, a.id, a.created_at
      FROM public.proxy_agent_assignments a
     WHERE a.beneficiary_id = p_partner AND a.agent_id IS NOT NULL AND a.agent_id <> p_partner
       AND a.is_active = true AND coalesce(a.is_managed_account, false) = true
       AND coalesce(a.approval_status, 'pending') = 'approved'
       AND a.created_at <= p_at
       AND (a.expires_at IS NULL OR a.expires_at > p_at)
  ), name_c AS (
    SELECT n.agent_id AS c_earner, n.id AS c_note, n.created_at AS c_est
      FROM public.promissory_notes n
     WHERE v_name IS NOT NULL AND position(' ' IN v_name) > 0 AND length(v_name) >= 5
       AND n.agent_id IS NOT NULL AND n.agent_id <> p_partner
       AND coalesce(n.approval_bonus_paid, false) = true
       AND NOT EXISTS (SELECT 1 FROM public.pso_note_reversals r WHERE r.note_id = n.id)
       AND lower(regexp_replace(trim(coalesce(n.partner_name,'')), '\s+', ' ', 'g')) = v_name
  ), pick AS (
    SELECT c.c_earner, c.c_path, c.c_note, c.c_asg, 'earliest_relationship'::text AS b
      FROM c ORDER BY c.c_est, c.c_path LIMIT 1
  )
  SELECT * FROM pick
  UNION ALL
  SELECT nc.c_earner, 'promissory_note'::text, nc.c_note, NULL::uuid, 'unique_note_name_match'::text
    FROM name_c nc
   WHERE NOT EXISTS (SELECT 1 FROM pick)
     AND (SELECT count(*) FROM name_c) = 1;
END $function$;

-- 2. One approved note per partner, first note first.
CREATE OR REPLACE FUNCTION public.promissory_note_same_partner(p_a public.promissory_notes, p_b public.promissory_notes)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT (p_a.partner_user_id IS NOT NULL AND p_a.partner_user_id = p_b.partner_user_id)
      OR (length(right(regexp_replace(coalesce(p_a.whatsapp_number,''), '\D', '', 'g'), 9)) = 9
          AND right(regexp_replace(coalesce(p_a.whatsapp_number,''), '\D', '', 'g'), 9) IN
              (right(regexp_replace(coalesce(p_b.whatsapp_number,''), '\D', '', 'g'), 9),
               right(regexp_replace(coalesce(p_b.phone_number,''), '\D', '', 'g'), 9)))
      OR (length(right(regexp_replace(coalesce(p_a.phone_number,''), '\D', '', 'g'), 9)) = 9
          AND right(regexp_replace(coalesce(p_a.phone_number,''), '\D', '', 'g'), 9) IN
              (right(regexp_replace(coalesce(p_b.whatsapp_number,''), '\D', '', 'g'), 9),
               right(regexp_replace(coalesce(p_b.phone_number,''), '\D', '', 'g'), 9)))
      OR (nullif(lower(trim(coalesce(p_a.email,''))), '') IS NOT NULL
          AND lower(trim(coalesce(p_a.email,''))) = lower(trim(coalesce(p_b.email,''))));
$$;
REVOKE ALL ON FUNCTION public.promissory_note_same_partner(public.promissory_notes, public.promissory_notes) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.guard_one_approved_note_per_partner()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $function$
DECLARE o public.promissory_notes%ROWTYPE; v_who text;
BEGIN
  IF NOT (coalesce(NEW.approval_bonus_paid, false) = true AND coalesce(OLD.approval_bonus_paid, false) = false) THEN RETURN NEW; END IF;

  -- (a) the partner already has an approved note: the first note stays, this one cannot also be approved.
  SELECT n.* INTO o FROM public.promissory_notes n
   WHERE n.id <> NEW.id AND coalesce(n.approval_bonus_paid, false) = true
     AND NOT EXISTS (SELECT 1 FROM public.pso_note_reversals r WHERE r.note_id = n.id)
     AND public.promissory_note_same_partner(NEW, n)
   ORDER BY n.created_at LIMIT 1;
  IF FOUND THEN
    SELECT coalesce(p.full_name, 'another agent') INTO v_who FROM public.profiles p WHERE p.id = o.agent_id;
    RAISE EXCEPTION 'NOTE_ALREADY_APPROVED: % already has an approved promissory note (agent %, created %). A partner can only have one approved note, so this one cannot be approved.',
      coalesce(NEW.partner_name, 'This partner'), v_who, to_char(o.created_at AT TIME ZONE 'Africa/Kampala', 'DD Mon YYYY HH24:MI')
      USING ERRCODE = 'check_violation', HINT = 'Open the earlier note instead, or remove this duplicate note.';
  END IF;

  -- (b) first in, first out: an earlier note for the same partner that is still waiting must be dealt with first.
  SELECT n.* INTO o FROM public.promissory_notes n
   WHERE n.id <> NEW.id AND coalesce(n.approval_bonus_paid, false) = false
     AND n.created_at < NEW.created_at
     AND NOT EXISTS (SELECT 1 FROM public.pso_note_reversals r WHERE r.note_id = n.id)
     AND public.promissory_note_same_partner(NEW, n)
   ORDER BY n.created_at LIMIT 1;
  IF FOUND THEN
    SELECT coalesce(p.full_name, 'another agent') INTO v_who FROM public.profiles p WHERE p.id = o.agent_id;
    RAISE EXCEPTION 'EARLIER_NOTE_FIRST: % has an earlier promissory note still waiting (agent %, created %). Approve that one first, or remove it, then approve this one.',
      coalesce(NEW.partner_name, 'This partner'), v_who, to_char(o.created_at AT TIME ZONE 'Africa/Kampala', 'DD Mon YYYY HH24:MI')
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION public.guard_one_approved_note_per_partner() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_guard_one_approved_note_per_partner ON public.promissory_notes;
CREATE TRIGGER trg_guard_one_approved_note_per_partner
  BEFORE UPDATE OF approval_bonus_paid ON public.promissory_notes
  FOR EACH ROW EXECUTE FUNCTION public.guard_one_approved_note_per_partner();

-- 3. Pay straight away when the note is approved. Failure to pay here never blocks the approval; the hourly reconcile retries.
CREATE OR REPLACE FUNCTION public.pay_commission_after_note_approval()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $function$
DECLARE v_partner uuid;
BEGIN
  v_partner := NEW.partner_user_id;
  IF v_partner IS NULL THEN RETURN NULL; END IF;
  BEGIN
    PERFORM public.promissory_catch_up_partner_commission(v_partner);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'pay_commission_after_note_approval failed for note %: %', NEW.id, SQLERRM;
  END;
  RETURN NULL;
END $function$;
REVOKE ALL ON FUNCTION public.pay_commission_after_note_approval() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_pay_commission_after_note_approval ON public.promissory_notes;
CREATE TRIGGER trg_pay_commission_after_note_approval
  AFTER UPDATE OF approval_bonus_paid ON public.promissory_notes
  FOR EACH ROW
  WHEN (NEW.approval_bonus_paid IS TRUE AND coalesce(OLD.approval_bonus_paid, false) = false)
  EXECUTE FUNCTION public.pay_commission_after_note_approval();
