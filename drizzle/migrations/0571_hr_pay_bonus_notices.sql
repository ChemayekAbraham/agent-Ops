CREATE TABLE public.hr_pay_bonus_notices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pool_id uuid NOT NULL REFERENCES public.hr_pay_bonus_pools(id) ON DELETE CASCADE,
  recipient_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('approved','paid','cancelled')),
  actor_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz
);
CREATE INDEX hr_pay_bonus_notices_open ON public.hr_pay_bonus_notices (recipient_id) WHERE acknowledged_at IS NULL;
ALTER TABLE public.hr_pay_bonus_notices ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.hr_pay_bonus_notify()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status = 'approved' THEN
      INSERT INTO hr_pay_bonus_notices (pool_id, recipient_id, kind, actor_id) VALUES (NEW.id, NEW.prepared_by, 'approved', NEW.approved_by);
    ELSIF NEW.status = 'paid' THEN
      INSERT INTO hr_pay_bonus_notices (pool_id, recipient_id, kind, actor_id) VALUES (NEW.id, NEW.prepared_by, 'paid', NEW.paid_by);
    ELSIF NEW.status = 'cancelled' AND NEW.cancelled_by IS DISTINCT FROM NEW.prepared_by THEN
      INSERT INTO hr_pay_bonus_notices (pool_id, recipient_id, kind, actor_id) VALUES (NEW.id, NEW.prepared_by, 'cancelled', NEW.cancelled_by);
    END IF;
  END IF;
  RETURN NEW;
END $function$;
CREATE TRIGGER hr_pay_bonus_notify_trg AFTER UPDATE OF status ON public.hr_pay_bonus_pools
  FOR EACH ROW EXECUTE FUNCTION public.hr_pay_bonus_notify();
REVOKE ALL ON FUNCTION public.hr_pay_bonus_notify() FROM public, anon, authenticated;

CREATE OR REPLACE FUNCTION public.hr_pay_bonus_return(_pool_id uuid, _note text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE v_status text;
BEGIN
  IF nullif(btrim(_note),'') IS NULL THEN RAISE EXCEPTION 'Write a note saying what to change.'; END IF;
  SELECT status INTO v_status FROM hr_pay_bonus_pools WHERE id = _pool_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Bonus pool not found.'; END IF;
  IF v_status = 'submitted' THEN
    IF NOT public.hr_pay_is_approver() THEN RAISE EXCEPTION 'Only the position holding approve authority can return a pool awaiting approval.'; END IF;
  ELSIF v_status = 'approved' THEN
    IF NOT public.hr_pay_is_releaser() THEN RAISE EXCEPTION 'Only the position holding release authority can decline an approved pool.'; END IF;
  ELSE
    RAISE EXCEPTION 'This pool is % and cannot be returned.', v_status;
  END IF;
  UPDATE hr_pay_bonus_pools
     SET status = 'returned', return_note = btrim(_note), returned_by = auth.uid(), returned_at = now(),
         approved_by = NULL, approved_at = NULL, updated_at = now()
   WHERE id = _pool_id;
  INSERT INTO audit_logs (user_id, action_type, table_name, record_id, action, metadata)
  VALUES (auth.uid(), 'hr_pay_bonus_returned', 'hr_pay_bonus_pools', _pool_id::text,
          CASE WHEN v_status = 'approved' THEN 'Approved bonus pool declined at payment and returned for rework'
               ELSE 'Bonus pool returned for rework' END,
          jsonb_build_object('note', btrim(_note), 'from_status', v_status));
END $function$;

CREATE OR REPLACE FUNCTION public.hr_pay_bonus_ack(_notice_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE v_pool uuid; v_kind text;
BEGIN
  UPDATE hr_pay_bonus_notices SET acknowledged_at = now()
   WHERE id = _notice_id AND recipient_id = auth.uid() AND acknowledged_at IS NULL
  RETURNING pool_id, kind INTO v_pool, v_kind;
  IF v_pool IS NOT NULL THEN
    INSERT INTO audit_logs (user_id, action_type, table_name, record_id, action, metadata)
    VALUES (auth.uid(), 'hr_pay_bonus_notice_ack', 'hr_pay_bonus_pools', v_pool::text, 'Bonus notice acknowledged',
            jsonb_build_object('notice_id', _notice_id, 'kind', v_kind));
  END IF;
END $function$;

DROP FUNCTION public.hr_pay_bonus_pending_for_me();
CREATE FUNCTION public.hr_pay_bonus_pending_for_me()
 RETURNS TABLE(pool_id uuid, kind text, title text, pool_amount numeric, allocated numeric, people integer, return_note text, prepared_by_name text,
               notice_id uuid, notice_kind text, actor_name text, raised_at timestamptz)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
#variable_conflict use_column
DECLARE v_appr boolean; v_rel boolean; v_prep boolean;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not authorised'; END IF;
  v_appr := public.hr_pay_is_approver(); v_rel := public.hr_pay_is_releaser(); v_prep := public.hr_pay_is_preparer();
  RETURN QUERY
  SELECT q.pool_id, q.kind, q.title, q.pool_amount, q.allocated, q.people, q.return_note, q.prepared_by_name,
         q.notice_id, q.notice_kind, q.actor_name, q.raised_at
    FROM (
      SELECT p.id AS pool_id, k.kind, p.title, p.pool_amount::numeric AS pool_amount, coalesce(x.amt,0)::numeric AS allocated,
             coalesce(x.n,0)::int AS people, p.return_note, pp.full_name::text AS prepared_by_name,
             NULL::uuid AS notice_id, NULL::text AS notice_kind,
             CASE k.kind WHEN 'pay' THEN ap.full_name::text WHEN 'rework' THEN rp.full_name::text END AS actor_name,
             CASE k.kind WHEN 'approve' THEN p.submitted_at WHEN 'pay' THEN p.approved_at ELSE p.returned_at END AS raised_at,
             k.ord, -extract(epoch FROM p.updated_at) AS sk
        FROM hr_pay_bonus_pools p
        JOIN LATERAL (SELECT 'approve'::text AS kind, 1 AS ord WHERE v_appr AND p.status = 'submitted'
                      UNION ALL SELECT 'pay'::text, 2 WHERE v_rel AND p.status = 'approved'
                      UNION ALL SELECT 'rework'::text, 3 WHERE v_prep AND p.status = 'returned') k ON true
        LEFT JOIN LATERAL (SELECT count(*) n, sum(a.amount) amt FROM hr_pay_bonus_allocations a WHERE a.pool_id = p.id) x ON true
        LEFT JOIN profiles pp ON pp.id = p.prepared_by
        LEFT JOIN profiles ap ON ap.id = p.approved_by
        LEFT JOIN profiles rp ON rp.id = p.returned_by
      UNION ALL
      SELECT p.id, 'notice'::text, p.title, p.pool_amount::numeric, coalesce(x.amt,0)::numeric, coalesce(x.n,0)::int,
             p.return_note, pp.full_name::text, nt.id, nt.kind, an.full_name::text, nt.created_at,
             4, extract(epoch FROM nt.created_at)
        FROM hr_pay_bonus_notices nt
        JOIN hr_pay_bonus_pools p ON p.id = nt.pool_id
        LEFT JOIN LATERAL (SELECT count(*) n, sum(a.amount) amt FROM hr_pay_bonus_allocations a WHERE a.pool_id = p.id) x ON true
        LEFT JOIN profiles pp ON pp.id = p.prepared_by
        LEFT JOIN profiles an ON an.id = nt.actor_id
       WHERE nt.recipient_id = auth.uid() AND nt.acknowledged_at IS NULL
    ) q
   ORDER BY q.ord, q.sk;
END $function$;

REVOKE ALL ON FUNCTION public.hr_pay_bonus_ack(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.hr_pay_bonus_ack(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.hr_pay_bonus_pending_for_me() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.hr_pay_bonus_pending_for_me() TO authenticated;