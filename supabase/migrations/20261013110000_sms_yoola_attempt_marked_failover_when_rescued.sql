-- 2026-10-13 (doc 220): a Yoola attempt that a later provider rescued is a
-- 'failover', not a 'failed' SMS.
--
-- attemptYoolaPrimary and ~24 inline senders write one sms_delivery_log row per
-- provider attempt, so a Yoola 402/422/5xx stays status='failed' even when Africa's
-- Talking delivered the same message seconds later. Doc 219 fixed the CTO report's
-- counting; this fixes the rows themselves for every other reader (exceptions
-- manager, OTP log, failover alerts).
--
-- Done in the database rather than in 24 edge functions: one trigger covers every
-- sender, including ones added later. Only single-provider Yoola rows are touched,
-- only when a later row for the SAME number and SAME source succeeds within 10
-- minutes (stricter than the report's any-source rule: 94% of rescued attempts
-- match on source). error / provider_response are kept untouched. Never blocks an
-- insert.

CREATE OR REPLACE FUNCTION public.sms_mark_rescued_yoola_attempts()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  BEGIN
    UPDATE public.sms_delivery_log f
    SET status = 'failover'
    WHERE f.status = 'failed'
      AND f.provider = 'yoola'
      AND f.id <> NEW.id
      AND f.created_at BETWEEN NEW.created_at - interval '10 minutes' AND NEW.created_at + interval '1 minute'
      AND f.source IS NOT DISTINCT FROM NEW.source
      AND right(regexp_replace(COALESCE(f.recipient_phone, ''), '\D', '', 'g'), 9)
        = right(regexp_replace(COALESCE(NEW.recipient_phone, ''), '\D', '', 'g'), 9);
  EXCEPTION WHEN OTHERS THEN
    NULL; -- bookkeeping must never block a send
  END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sms_mark_rescued_yoola_ins ON public.sms_delivery_log;
CREATE TRIGGER trg_sms_mark_rescued_yoola_ins
  AFTER INSERT ON public.sms_delivery_log
  FOR EACH ROW WHEN (NEW.status IN ('sent', 'accepted', 'delivered'))
  EXECUTE FUNCTION public.sms_mark_rescued_yoola_attempts();

DROP TRIGGER IF EXISTS trg_sms_mark_rescued_yoola_upd ON public.sms_delivery_log;
CREATE TRIGGER trg_sms_mark_rescued_yoola_upd
  AFTER UPDATE OF status ON public.sms_delivery_log
  FOR EACH ROW WHEN (NEW.status IN ('sent', 'accepted', 'delivered') AND OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.sms_mark_rescued_yoola_attempts();

-- Backfill the report window (30 days) with the same rule.
UPDATE public.sms_delivery_log f
SET status = 'failover'
WHERE f.status = 'failed' AND f.provider = 'yoola'
  AND f.created_at > now() - interval '30 days'
  AND EXISTS (
    SELECT 1 FROM public.sms_delivery_log s
    WHERE s.status IN ('sent', 'accepted', 'delivered')
      AND s.source IS NOT DISTINCT FROM f.source
      AND s.created_at BETWEEN f.created_at - interval '1 minute' AND f.created_at + interval '10 minutes'
      AND right(regexp_replace(COALESCE(s.recipient_phone, ''), '\D', '', 'g'), 9)
        = right(regexp_replace(COALESCE(f.recipient_phone, ''), '\D', '', 'g'), 9)
  );

-- Report: rows already marked failover are recovered too (doc 219 helper + counter).
CREATE OR REPLACE FUNCTION public.sms_row_is_recovered(p_status text, p_phone text, p_at timestamptz)
RETURNS boolean
LANGUAGE sql STABLE
SET search_path TO 'public'
AS $$
  SELECT p_status = 'failover' OR (p_status = 'failed' AND EXISTS (
    SELECT 1 FROM public.sms_delivery_log s
    WHERE s.status IN ('sent', 'accepted', 'delivered')
      AND s.created_at BETWEEN p_at - interval '1 minute' AND p_at + interval '10 minutes'
      AND right(regexp_replace(COALESCE(s.recipient_phone, ''), '\D', '', 'g'), 9)
        = right(regexp_replace(COALESCE(p_phone, ''), '\D', '', 'g'), 9)
  ));
$$;

DO $patch$
DECLARE
  v_def text;
  v_new text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p WHERE p.proname = 'get_cto_daily_report' AND p.pronamespace = 'public'::regnamespace;
  IF v_def IS NULL THEN RAISE EXCEPTION 'get_cto_daily_report not found'; END IF;
  v_new := replace(v_def,
    'WHERE r.status = ''failed'' AND r.created_at >= v_30d',
    'WHERE r.status IN (''failed'', ''failover'') AND r.created_at >= v_30d');
  IF v_new = v_def THEN RAISE EXCEPTION 'get_cto_daily_report: failover counter anchor missing'; END IF;
  EXECUTE v_new;
END
$patch$;
