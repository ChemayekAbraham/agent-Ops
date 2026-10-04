-- ─────────────────────────────────────────────────────────────────────────────
-- Phase 3: 7-day booking window on promissory-note tenant reservations,
-- exclusive claim fence, 4-day-out warning, auto-release, CFO tracking.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.promissory_note_plan_intents
  ADD COLUMN IF NOT EXISTS reserved_until timestamptz,
  ADD COLUMN IF NOT EXISTS warned_at timestamptz,
  ADD COLUMN IF NOT EXISTS release_reason text;

-- Column initialisation for the new window (7 days from the moment of booking).
UPDATE public.promissory_note_plan_intents
   SET reserved_until = created_at + interval '7 days'
 WHERE reserved_until IS NULL;

ALTER TABLE public.promissory_note_plan_intents
  ALTER COLUMN reserved_until SET DEFAULT (now() + interval '7 days');
ALTER TABLE public.promissory_note_plan_intents
  ALTER COLUMN reserved_until SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pnpi_live_window
  ON public.promissory_note_plan_intents(reserved_until)
  WHERE status = 'reserved';

-- ── 1. Booking is part of the partner-reservation fence ──────────────────────
CREATE OR REPLACE FUNCTION public.psm_plan_partner_reserved_stage(p_rent_request_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM public.rent_requests rr
       WHERE rr.id = p_rent_request_id AND rr.self_funding_partner_id IS NOT NULL
    ) THEN 'partner_funded'
    WHEN EXISTS (
      SELECT 1
        FROM public.partner_self_funding_lines l
        JOIN public.partner_self_commitments c ON c.id = l.commitment_id
       WHERE l.rent_request_id = p_rent_request_id
         AND c.status IN ('pending_ops_approval','active')
    ) THEN 'partner_committed'
    WHEN EXISTS (
      SELECT 1 FROM public.promissory_note_plan_intents i
       WHERE i.rent_request_id = p_rent_request_id
         AND i.status = 'reserved'
         AND i.reserved_until > now()
    ) THEN 'promissory_booked'
    WHEN EXISTS (
      SELECT 1 FROM public.partner_self_plan_claims pc
       WHERE pc.rent_request_id = p_rent_request_id
         AND pc.status IN ('held','confirmed')
         AND (pc.status = 'confirmed' OR pc.expires_at > now())
    ) THEN 'partner_held'
    ELSE NULL
  END;
$$;

-- ── 2. Exclusive booking: no other partner can claim a booked plan ───────────
CREATE OR REPLACE FUNCTION public.psm_plan_booked_for_other(p_rent_request_id uuid, p_partner uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.promissory_note_plan_intents i
      JOIN public.promissory_notes n ON n.id = i.note_id
     WHERE i.rent_request_id = p_rent_request_id
       AND i.status = 'reserved'
       AND i.reserved_until > now()
       AND (n.partner_user_id IS NULL OR n.partner_user_id IS DISTINCT FROM p_partner)
  );
$$;

REVOKE ALL ON FUNCTION public.psm_plan_booked_for_other(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.psm_plan_booked_for_other(uuid, uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.partner_self_claim_plans(
  p_rent_request_ids uuid[],
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_expires timestamptz := now() + interval '10 minutes';
  v_claimed jsonb;
  v_lost jsonb;
BEGIN
  IF v_uid IS NULL OR NOT public.psm_is_partner(v_uid) THEN
    RAISE EXCEPTION 'Not authorised for self-managed funding' USING ERRCODE = '42501';
  END IF;
  IF p_rent_request_ids IS NULL OR array_length(p_rent_request_ids,1) IS NULL THEN
    RAISE EXCEPTION 'No plans supplied';
  END IF;

  UPDATE public.partner_self_plan_claims
     SET status='expired', closed_at=now(), updated_at=now()
   WHERE status='held' AND expires_at <= now();

  INSERT INTO public.partner_self_plan_claims (rent_request_id, partner_id, amount, expires_at, idempotency_key)
  SELECT p.rent_request_id, v_uid, p.funding_amount, v_expires, p_idempotency_key
  FROM public.v_partner_self_fundable_plans p
  WHERE p.rent_request_id = ANY(p_rent_request_ids)
    AND p.held_by IS NULL
    AND NOT public.psm_plan_booked_for_other(p.rent_request_id, v_uid)
  ON CONFLICT (rent_request_id) WHERE status IN ('held','confirmed') DO NOTHING;

  UPDATE public.partner_self_plan_claims
     SET expires_at = v_expires, updated_at = now()
   WHERE partner_id = v_uid AND status = 'held' AND rent_request_id = ANY(p_rent_request_ids);

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'rent_request_id', c.rent_request_id,
           'amount', c.amount,
           'expires_at', c.expires_at)), '[]'::jsonb)
  INTO v_claimed
  FROM public.partner_self_plan_claims c
  WHERE c.partner_id = v_uid AND c.status IN ('held','confirmed')
    AND c.rent_request_id = ANY(p_rent_request_ids);

  SELECT COALESCE(jsonb_agg(x), '[]'::jsonb) INTO v_lost
  FROM unnest(p_rent_request_ids) AS x
  WHERE NOT EXISTS (
    SELECT 1 FROM public.partner_self_plan_claims c
    WHERE c.rent_request_id = x AND c.partner_id = v_uid AND c.status IN ('held','confirmed'));

  PERFORM public.psm_audit(v_uid, v_uid, 'plans_claimed', 'partner_self_plan_claims', NULL,
    jsonb_build_object('claimed', v_claimed, 'lost', v_lost, 'idempotency_key', p_idempotency_key));

  RETURN jsonb_build_object(
    'claimed', v_claimed,
    'lost_to_other_partners', v_lost,
    'hold_expires_at', v_expires,
    'available_balance', public.get_user_available_balance(v_uid)
  );
END;
$$;

-- Hard guard: a commitment can never be built over another partner's booking.
CREATE OR REPLACE FUNCTION public.psm_assert_no_foreign_booking(p_partner uuid, p_rent_request_ids uuid[])
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_n integer;
BEGIN
  SELECT count(*) INTO v_n
  FROM unnest(COALESCE(p_rent_request_ids, ARRAY[]::uuid[])) AS x
  WHERE public.psm_plan_booked_for_other(x, p_partner);

  IF v_n > 0 THEN
    RAISE EXCEPTION 'PLAN_BOOKED_BY_OTHER_PARTNER: % of the selected plans are booked on another partner''s promissory note. Refresh and reselect.', v_n
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.psm_assert_no_foreign_booking(uuid, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.psm_assert_no_foreign_booking(uuid, uuid[]) TO authenticated, service_role;

-- ── 3. Warning + release queue ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.promissory_note_release_notices (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  note_id uuid NOT NULL UNIQUE REFERENCES public.promissory_notes(id) ON DELETE CASCADE,
  partner_name text NOT NULL,
  phone text,
  email text,
  amount numeric(14,2) NOT NULL DEFAULT 0,
  booked_count integer NOT NULL DEFAULT 0,
  booked_amount numeric(14,2) NOT NULL DEFAULT 0,
  release_at timestamptz NOT NULL,
  days_left integer NOT NULL DEFAULT 4,
  tenants jsonb NOT NULL DEFAULT '[]'::jsonb,
  sms_status text NOT NULL DEFAULT 'pending',
  email_status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pnrn_sms_status_check CHECK (sms_status IN ('pending','sent','failed','skipped')),
  CONSTRAINT pnrn_email_status_check CHECK (email_status IN ('pending','sent','failed','skipped'))
);

CREATE INDEX IF NOT EXISTS idx_pnrn_pending
  ON public.promissory_note_release_notices(created_at)
  WHERE sms_status = 'pending' OR email_status = 'pending';

GRANT SELECT ON public.promissory_note_release_notices TO authenticated;
GRANT ALL ON public.promissory_note_release_notices TO service_role;

ALTER TABLE public.promissory_note_release_notices ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Agents view own release notices"
  ON public.promissory_note_release_notices FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.promissory_notes n
      WHERE n.id = note_id AND n.agent_id = (SELECT auth.uid())
    )
  );

CREATE POLICY "Ops view release notices"
  ON public.promissory_note_release_notices FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = (SELECT auth.uid())
        AND ur.role = ANY (ARRAY['operations','cfo','coo','super_admin','manager','partner_ops']::app_role[])
    )
  );

CREATE TRIGGER trg_pnrn_updated_at
  BEFORE UPDATE ON public.promissory_note_release_notices
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Queue the 4-days-out warning (set-based, one statement per side, no N+1).
CREATE OR REPLACE FUNCTION public.psm_queue_promissory_release_warnings()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_queued integer := 0;
BEGIN
  WITH due AS (
    SELECT i.note_id,
           min(i.reserved_until) AS release_at,
           count(*)::int          AS booked_count,
           COALESCE(sum(i.amount),0) AS booked_amount,
           COALESCE(jsonb_agg(jsonb_build_object(
             'tenant_name', COALESCE(v.tenant_full_name,'Tenant'),
             'tenant_location', COALESCE(v.tenant_location, v.request_city, ''),
             'principal', i.amount
           ) ORDER BY i.amount DESC), '[]'::jsonb) AS tenants
      FROM public.promissory_note_plan_intents i
      JOIN public.promissory_notes n ON n.id = i.note_id
      LEFT JOIN public.v_partner_self_fundable_plans v ON v.rent_request_id = i.rent_request_id
     WHERE i.status = 'reserved'
       AND i.warned_at IS NULL
       AND i.reserved_until > now()
       AND i.reserved_until <= now() + interval '4 days'
       AND n.approved_at IS NULL
     GROUP BY i.note_id
  ), ins AS (
    INSERT INTO public.promissory_note_release_notices (
      note_id, partner_name, phone, email, amount,
      booked_count, booked_amount, release_at, days_left, tenants
    )
    SELECT d.note_id, n.partner_name,
           COALESCE(NULLIF(btrim(n.whatsapp_number),''), NULLIF(btrim(n.phone_number),'')),
           NULLIF(btrim(n.email),''),
           n.amount, d.booked_count, d.booked_amount, d.release_at,
           GREATEST(0, CEIL(EXTRACT(EPOCH FROM (d.release_at - now())) / 86400))::int,
           d.tenants
      FROM due d
      JOIN public.promissory_notes n ON n.id = d.note_id
    ON CONFLICT (note_id) DO NOTHING
    RETURNING note_id
  ), stamp AS (
    UPDATE public.promissory_note_plan_intents i
       SET warned_at = now(), updated_at = now()
     WHERE i.status = 'reserved'
       AND i.warned_at IS NULL
       AND i.note_id IN (SELECT note_id FROM due)
    RETURNING 1
  )
  SELECT count(*)::int INTO v_queued FROM ins;

  RETURN jsonb_build_object('queued', COALESCE(v_queued,0), 'ran_at', now());
END;
$$;

REVOKE ALL ON FUNCTION public.psm_queue_promissory_release_warnings() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.psm_queue_promissory_release_warnings() TO service_role;

-- Auto-release expired bookings back to the company funding queue.
CREATE OR REPLACE FUNCTION public.psm_release_expired_promissory_intents()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_released integer := 0; v_amount numeric := 0;
BEGIN
  WITH expired AS (
    UPDATE public.promissory_note_plan_intents i
       SET status = 'released',
           released_at = now(),
           release_reason = 'hold_expired_7_days',
           updated_at = now()
     WHERE i.status = 'reserved'
       AND i.reserved_until <= now()
       AND EXISTS (SELECT 1 FROM public.promissory_notes n WHERE n.id = i.note_id AND n.approved_at IS NULL)
    RETURNING i.note_id, i.rent_request_id, i.amount, i.agent_id
  ), ev AS (
    INSERT INTO public.system_events (event_type, user_id, description, metadata)
    SELECT 'rent_request_created', e.agent_id,
           'Promissory booking expired: plan released back to company funding queue',
           jsonb_build_object('note_id', e.note_id, 'rent_request_id', e.rent_request_id,
                              'amount', e.amount, 'reason', 'hold_expired_7_days')
      FROM expired e
    RETURNING 1
  )
  SELECT count(*)::int, COALESCE(sum(amount),0) INTO v_released, v_amount FROM expired;

  RETURN jsonb_build_object('released', COALESCE(v_released,0), 'released_amount', COALESCE(v_amount,0), 'ran_at', now());
END;
$$;

REVOKE ALL ON FUNCTION public.psm_release_expired_promissory_intents() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.psm_release_expired_promissory_intents() TO service_role;

-- ── 4. CFO tracking (no money moves at booking; this is the memo register) ───
CREATE OR REPLACE VIEW public.v_cfo_promissory_bookings AS
SELECT i.id AS intent_id,
       i.note_id,
       n.partner_name,
       n.partner_user_id,
       n.amount           AS note_amount,
       n.approved_at      AS note_approved_at,
       i.agent_id,
       ap.full_name       AS agent_name,
       i.rent_request_id,
       i.amount           AS booked_amount,
       i.status,
       i.created_at       AS booked_at,
       i.reserved_until,
       i.warned_at,
       i.released_at,
       i.release_reason,
       i.commitment_id,
       GREATEST(0, CEIL(EXTRACT(EPOCH FROM (i.reserved_until - now())) / 86400))::int AS days_left,
       (i.status = 'reserved' AND i.reserved_until > now())  AS is_live,
       (i.status = 'reserved' AND i.reserved_until <= now()) AS is_lapsed,
       rr.rent_amount,
       rr.status          AS rent_request_status,
       rr.funded_at,
       rr.self_funding_partner_id,
       tp.full_name       AS tenant_name
  FROM public.promissory_note_plan_intents i
  JOIN public.promissory_notes n ON n.id = i.note_id
  LEFT JOIN public.profiles ap ON ap.id = i.agent_id
  LEFT JOIN public.rent_requests rr ON rr.id = i.rent_request_id
  LEFT JOIN public.profiles tp ON tp.id = rr.tenant_id;

GRANT SELECT ON public.v_cfo_promissory_bookings TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.cfo_promissory_bookings_report(
  p_limit integer DEFAULT 100,
  p_offset integer DEFAULT 0,
  p_filter text DEFAULT 'live'
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_rows jsonb;
  v_total integer;
  v_kpi jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF NOT (public.is_ops_role(v_uid) OR public.has_role(v_uid,'cfo') OR public.has_role(v_uid,'coo')
          OR public.has_role(v_uid,'ceo') OR public.has_role(v_uid,'super_admin')
          OR public.has_role(v_uid,'manager')) THEN
    RAISE EXCEPTION 'Not authorised' USING ERRCODE = '42501';
  END IF;

  SELECT jsonb_build_object(
           'live_count', COUNT(*) FILTER (WHERE is_live),
           'live_amount', COALESCE(SUM(booked_amount) FILTER (WHERE is_live), 0),
           'warned_count', COUNT(*) FILTER (WHERE is_live AND warned_at IS NOT NULL),
           'lapsed_count', COUNT(*) FILTER (WHERE is_lapsed),
           'released_count', COUNT(*) FILTER (WHERE status = 'released'),
           'released_amount', COALESCE(SUM(booked_amount) FILTER (WHERE status = 'released'), 0),
           'funded_count', COUNT(*) FILTER (WHERE status = 'funded'),
           'funded_amount', COALESCE(SUM(booked_amount) FILTER (WHERE status = 'funded'), 0)
         )
  INTO v_kpi
  FROM public.v_cfo_promissory_bookings;

  WITH filtered AS (
    SELECT b.*
      FROM public.v_cfo_promissory_bookings b
     WHERE CASE COALESCE(p_filter,'live')
             WHEN 'live'     THEN b.is_live
             WHEN 'lapsed'   THEN b.is_lapsed
             WHEN 'released' THEN b.status = 'released'
             WHEN 'funded'   THEN b.status = 'funded'
             ELSE true
           END
  ), page AS (
    SELECT f.*, COUNT(*) OVER () AS total_count
      FROM filtered f
     ORDER BY f.reserved_until ASC, f.booked_amount DESC
     LIMIT GREATEST(1, LEAST(COALESCE(p_limit,100), 500))
    OFFSET GREATEST(0, COALESCE(p_offset,0))
  )
  SELECT COALESCE(jsonb_agg(to_jsonb(p) - 'total_count'), '[]'::jsonb),
         COALESCE(MAX(p.total_count), 0)
  INTO v_rows, v_total
  FROM page p;

  RETURN jsonb_build_object('kpi', v_kpi, 'rows', v_rows, 'total', v_total, 'filter', COALESCE(p_filter,'live'));
END;
$$;

REVOKE ALL ON FUNCTION public.cfo_promissory_bookings_report(integer, integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cfo_promissory_bookings_report(integer, integer, text) TO authenticated, service_role;

-- ── 5. SQL-only crons (release + warning queue) ──────────────────────────────
SELECT cron.unschedule('psm-release-expired-promissory-bookings')
 WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'psm-release-expired-promissory-bookings');
SELECT cron.schedule(
  'psm-release-expired-promissory-bookings',
  '10 3 * * *',
  $$SELECT public.psm_release_expired_promissory_intents();$$
);

SELECT cron.unschedule('psm-queue-promissory-release-warnings')
 WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'psm-queue-promissory-release-warnings');
SELECT cron.schedule(
  'psm-queue-promissory-release-warnings',
  '5 6 * * *',
  $$SELECT public.psm_queue_promissory_release_warnings();$$
);