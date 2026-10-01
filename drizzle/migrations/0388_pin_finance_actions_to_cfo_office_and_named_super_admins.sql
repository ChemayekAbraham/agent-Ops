-- Pin seven finance actions to (a) two named super admins, while they still hold super_admin,
-- and (b) whoever currently holds the Chief Finance Officer office in hr_assignments.
-- Holding the cfo, ceo, coo, manager, landlord_ops or cto role no longer grants these actions.

CREATE TABLE IF NOT EXISTS public.pinned_finance_action_super_admins (
  user_id uuid PRIMARY KEY,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.pinned_finance_action_super_admins ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pinned_finance_action_super_admins FROM PUBLIC;
REVOKE ALL ON public.pinned_finance_action_super_admins FROM anon;
REVOKE ALL ON public.pinned_finance_action_super_admins FROM authenticated;
GRANT ALL ON public.pinned_finance_action_super_admins TO service_role;

INSERT INTO public.pinned_finance_action_super_admins (user_id, note) VALUES
  ('cf561688-b3a2-4f62-b9c1-67ee7b36ff2b', 'Benjamin Muhanguzi - pinned super admin for finance actions'),
  ('bd266fc7-1066-468a-8beb-347430d9d9b6', 'Nabukenya Hellen - pinned super admin for finance actions')
ON CONFLICT (user_id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.can_act_pinned_finance_action(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT _user_id IS NOT NULL AND (
    EXISTS (
      SELECT 1
        FROM public.pinned_finance_action_super_admins s
       WHERE s.user_id = _user_id
         AND public.has_role(_user_id, 'super_admin'::public.app_role)
    )
    OR EXISTS (
      SELECT 1
        FROM public.hr_assignments a
        JOIN public.hr_staff st ON st.id = a.staff_id
       WHERE a.position_id = 'c0985816-85c2-41ea-ae89-a8d8a9c44e69'::uuid
         AND st.user_id = _user_id
         AND st.active
         AND a.started_on <= current_date
         AND (a.ended_on IS NULL OR a.ended_on > current_date)
    )
  )
$$;

COMMENT ON FUNCTION public.can_act_pinned_finance_action(uuid) IS
'True for a person named in pinned_finance_action_super_admins who still holds super_admin, or for whoever currently holds the Chief Finance Officer position (c0985816-85c2-41ea-ae89-a8d8a9c44e69). An assignment ending today stops counting today. Holding the cfo role alone grants nothing.';

REVOKE ALL ON FUNCTION public.can_act_pinned_finance_action(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.can_act_pinned_finance_action(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.can_act_pinned_finance_action(uuid) TO authenticated, service_role;

DO $mig$
DECLARE
  r      record;
  v_oid  oid;
  v_src  text;
  v_hits integer;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('cfo_settle_tenant_shortfall_via_advance_topup', 'dee577010edbe568be9ec19d79054a9d',
$o1$  IF v_uid IS NULL OR NOT (
       public.has_role(v_uid, 'cfo') OR public.has_role(v_uid, 'manager')
       OR public.has_role(v_uid, 'super_admin')
     ) THEN
    RAISE EXCEPTION 'Only the CFO, a manager or a super admin can settle a tenant shortfall from an agent advance.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;$o1$,
$n1$  IF v_uid IS NULL OR NOT public.can_act_pinned_finance_action(v_uid) THEN
    RAISE EXCEPTION 'Only the Chief Finance Officer or a designated super admin can settle a tenant shortfall from an agent advance.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;$n1$),

      ('cfo_record_advance_payment', '35cc9ac0ae7f38aacec602444ee5d56b',
$o2$  IF NOT (public.has_role(v_caller, 'cfo'::app_role)
       OR public.has_role(v_caller, 'manager'::app_role)) THEN
    RAISE EXCEPTION 'Only CFO or Manager can record advance payments'
      USING ERRCODE = '42501';
  END IF;$o2$,
$n2$  IF NOT public.can_act_pinned_finance_action(v_caller) THEN
    RAISE EXCEPTION 'Only the Chief Finance Officer or a designated super admin can record advance payments'
      USING ERRCODE = '42501';
  END IF;$n2$),

      ('cfo_issue_boutique_order', 'a57df393382a7c7986dc63d6a2a1e8bc',
$o3$  IF NOT (public.has_role(auth.uid(),'cfo') OR public.has_role(auth.uid(),'super_admin')) THEN
    RAISE EXCEPTION 'Only the CFO can give final approval and issue boutique orders';
  END IF;$o3$,
$n3$  IF NOT public.can_act_pinned_finance_action(auth.uid()) THEN
    RAISE EXCEPTION 'Only the Chief Finance Officer or a designated super admin can give final approval and issue boutique orders';
  END IF;$n3$),

      ('cfo_decide_allocation_return', '780f9a987745a5107ef6318001aa942d',
$o4$  IF NOT public.can_reverse_landlord_float(v_caller) THEN
    RETURN jsonb_build_object('success', false, 'error',
      'Only the CFO, Landlord Operations, the CTO or a Super Admin may return landlord float.');
  END IF;$o4$,
$n4$  IF NOT public.can_act_pinned_finance_action(v_caller) THEN
    RETURN jsonb_build_object('success', false, 'error',
      'Only the Chief Finance Officer or a designated super admin may return landlord float.');
  END IF;$n4$),

      ('ceo_approve_service_centres', 'f1ce49ef7ec62547cd16952267a0a801',
$o5$  IF NOT (public.has_role(v_actor, 'coo') OR public.has_role(v_actor, 'manager')
          OR public.has_role(v_actor, 'ceo') OR public.has_role(v_actor, 'super_admin')) THEN
    RAISE EXCEPTION 'Only the COO can vet service centres';
  END IF;$o5$,
$n5$  IF NOT public.can_act_pinned_finance_action(v_actor) THEN
    RAISE EXCEPTION 'Only the Chief Finance Officer or a designated super admin can vet service centres';
  END IF;$n5$),

      ('ceo_reject_service_centres', '9bf98437a7bea4c41094793da40c6470',
$o6$  IF NOT (public.has_role(v_actor, 'coo') OR public.has_role(v_actor, 'manager')
          OR public.has_role(v_actor, 'ceo') OR public.has_role(v_actor, 'super_admin')) THEN
    RAISE EXCEPTION 'Only the COO can vet service centres';
  END IF;$o6$,
$n6$  IF NOT public.can_act_pinned_finance_action(v_actor) THEN
    RAISE EXCEPTION 'Only the Chief Finance Officer or a designated super admin can vet service centres';
  END IF;$n6$),

      ('ceo_angel_pool_shareholder_action', '3d4b1802f639feeffe7228bcc654acde',
$o7$  IF NOT (
    public.has_role(v_caller, 'ceo'::app_role)
    OR public.has_role(v_caller, 'manager'::app_role)
  ) THEN
    RAISE EXCEPTION 'Only CEO or manager can perform this action';
  END IF;$o7$,
$n7$  IF NOT public.can_act_pinned_finance_action(v_caller) THEN
    RAISE EXCEPTION 'Only the Chief Finance Officer or a designated super admin can perform this action';
  END IF;$n7$)
    ) AS t(fn, expected_md5, old_guard, new_guard)
  LOOP
    IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = r.fn) <> 1 THEN
      RAISE EXCEPTION '% has more than one overload or does not exist - stopping', r.fn;
    END IF;

    SELECT p.oid, p.prosrc INTO v_oid, v_src
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = r.fn;

    IF md5(v_src) <> r.expected_md5 THEN
      RAISE EXCEPTION '% has changed since it was reviewed (current md5 %) - stopping', r.fn, md5(v_src);
    END IF;

    v_hits := (length(v_src) - length(replace(v_src, r.old_guard, ''))) / length(r.old_guard);
    IF v_hits <> 1 THEN
      RAISE EXCEPTION '% guard block found % times, expected exactly 1 - stopping', r.fn, v_hits;
    END IF;

    EXECUTE replace(pg_get_functiondef(v_oid), r.old_guard, r.new_guard);

    SELECT p.prosrc INTO v_src
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = r.fn;

    IF position('can_act_pinned_finance_action' in v_src) = 0 OR position(r.old_guard in v_src) > 0 THEN
      RAISE EXCEPTION '% did not take the new guard - stopping', r.fn;
    END IF;
  END LOOP;
END
$mig$;