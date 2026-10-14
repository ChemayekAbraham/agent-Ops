CREATE TABLE public.hr_pay_bonus_pools (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 3 AND 120),
  pool_amount numeric(14,0) NOT NULL CHECK (pool_amount > 0),
  notes text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','returned','approved','paid','cancelled')),
  prepared_by uuid NOT NULL,
  submitted_at timestamptz,
  approved_by uuid, approved_at timestamptz,
  return_note text, returned_by uuid, returned_at timestamptz,
  paid_by uuid, paid_at timestamptz,
  cancelled_by uuid, cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.hr_pay_bonus_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pool_id uuid NOT NULL REFERENCES public.hr_pay_bonus_pools(id) ON DELETE CASCADE,
  staff_id uuid NOT NULL REFERENCES public.hr_staff(id) ON DELETE RESTRICT,
  percentage numeric(7,3) NOT NULL CHECK (percentage > 0 AND percentage <= 100),
  amount numeric(14,0) NOT NULL DEFAULT 0 CHECK (amount >= 0),
  ledger_group_id uuid,
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pool_id, staff_id)
);
-- No policies: reachable only through the functions below.
ALTER TABLE public.hr_pay_bonus_pools ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hr_pay_bonus_allocations ENABLE ROW LEVEL SECURITY;

-- Internal: amount = pool x % / 100, rounded so the amounts sum exactly (largest remainder).
CREATE OR REPLACE FUNCTION public.hr_pay_bonus_recompute(_pool_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE v_pool numeric; v_target numeric; v_base numeric; v_short int;
BEGIN
  SELECT pool_amount INTO v_pool FROM hr_pay_bonus_pools WHERE id = _pool_id;
  SELECT round(v_pool * coalesce(sum(percentage),0) / 100) INTO v_target FROM hr_pay_bonus_allocations WHERE pool_id = _pool_id;
  UPDATE hr_pay_bonus_allocations SET amount = floor(v_pool * percentage / 100) WHERE pool_id = _pool_id;
  SELECT coalesce(sum(amount),0) INTO v_base FROM hr_pay_bonus_allocations WHERE pool_id = _pool_id;
  v_short := (v_target - v_base)::int;
  IF v_short > 0 THEN
    UPDATE hr_pay_bonus_allocations a SET amount = a.amount + 1
     WHERE a.id IN (SELECT x.id FROM hr_pay_bonus_allocations x WHERE x.pool_id = _pool_id
                     ORDER BY (v_pool * x.percentage / 100) - floor(v_pool * x.percentage / 100) DESC, x.staff_id
                     LIMIT v_short);
  END IF;
END $function$;
REVOKE ALL ON FUNCTION public.hr_pay_bonus_recompute(uuid) FROM public, anon, authenticated;

-- Save a draft. _allocations = [{"staff_id": uuid, "percentage": number}, ...]
CREATE OR REPLACE FUNCTION public.hr_pay_bonus_save(_pool_id uuid, _title text, _pool_amount numeric, _notes text, _allocations jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE v_id uuid := _pool_id; v_status text; v_sum numeric; v_bad int; v_alloc jsonb := coalesce(_allocations, '[]'::jsonb);
BEGIN
  IF NOT public.hr_pay_is_preparer() THEN RAISE EXCEPTION 'Only the position holding prepare authority can prepare a bonus pool.'; END IF;
  IF _pool_amount IS NULL OR _pool_amount <= 0 THEN RAISE EXCEPTION 'Enter the amount to distribute.'; END IF;
  IF jsonb_typeof(v_alloc) <> 'array' THEN RAISE EXCEPTION 'Allocations must be a list.'; END IF;
  SELECT count(*) INTO v_bad FROM (SELECT e->>'staff_id' FROM jsonb_array_elements(v_alloc) e GROUP BY 1 HAVING count(*) > 1) d;
  IF v_bad > 0 THEN RAISE EXCEPTION 'A person appears twice in this pool.'; END IF;
  SELECT count(*) INTO v_bad FROM jsonb_array_elements(v_alloc) e
   WHERE (e->>'percentage') IS NULL OR (e->>'percentage')::numeric <= 0 OR (e->>'percentage')::numeric > 100;
  IF v_bad > 0 THEN RAISE EXCEPTION 'Each percentage must be above 0 and at most 100.'; END IF;
  SELECT coalesce(sum(round((e->>'percentage')::numeric, 3)), 0) INTO v_sum FROM jsonb_array_elements(v_alloc) e;
  IF v_sum > 100 THEN RAISE EXCEPTION 'Percentages add up to % percent, which is more than 100 percent.', v_sum; END IF;

  IF v_id IS NULL THEN
    INSERT INTO hr_pay_bonus_pools (title, pool_amount, notes, prepared_by)
    VALUES (btrim(_title), round(_pool_amount), nullif(btrim(_notes),''), auth.uid()) RETURNING id INTO v_id;
  ELSE
    SELECT status INTO v_status FROM hr_pay_bonus_pools WHERE id = v_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Bonus pool not found.'; END IF;
    IF v_status NOT IN ('draft','returned') THEN RAISE EXCEPTION 'This pool is % and can no longer be edited.', v_status; END IF;
    UPDATE hr_pay_bonus_pools SET title = btrim(_title), pool_amount = round(_pool_amount), notes = nullif(btrim(_notes),''),
           status = 'draft', prepared_by = auth.uid(), updated_at = now() WHERE id = v_id;
  END IF;

  DELETE FROM hr_pay_bonus_allocations WHERE pool_id = v_id;
  INSERT INTO hr_pay_bonus_allocations (pool_id, staff_id, percentage)
  SELECT v_id, (e->>'staff_id')::uuid, round((e->>'percentage')::numeric, 3) FROM jsonb_array_elements(v_alloc) e;
  PERFORM public.hr_pay_bonus_recompute(v_id);

  INSERT INTO audit_logs (user_id, action_type, table_name, record_id, action, metadata)
  VALUES (auth.uid(), 'hr_pay_bonus_saved', 'hr_pay_bonus_pools', v_id::text, 'Bonus pool saved',
          jsonb_build_object('pool_amount', round(_pool_amount), 'people', jsonb_array_length(v_alloc), 'total_pct', v_sum));
  RETURN v_id;
END $function$;

CREATE OR REPLACE FUNCTION public.hr_pay_bonus_submit(_pool_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE p record; v_n int; v_alloc numeric;
BEGIN
  IF NOT public.hr_pay_is_preparer() THEN RAISE EXCEPTION 'Only the position holding prepare authority can submit a bonus pool.'; END IF;
  SELECT * INTO p FROM hr_pay_bonus_pools WHERE id = _pool_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Bonus pool not found.'; END IF;
  IF p.status NOT IN ('draft','returned') THEN RAISE EXCEPTION 'This pool is % and cannot be submitted.', p.status; END IF;
  SELECT count(*), coalesce(sum(amount),0) INTO v_n, v_alloc FROM hr_pay_bonus_allocations WHERE pool_id = _pool_id;
  IF v_n = 0 THEN RAISE EXCEPTION 'Add at least one person.'; END IF;
  UPDATE hr_pay_bonus_pools SET status = 'submitted', submitted_at = now(), updated_at = now() WHERE id = _pool_id;
  INSERT INTO audit_logs (user_id, action_type, table_name, record_id, action, metadata)
  VALUES (auth.uid(), 'hr_pay_bonus_submitted', 'hr_pay_bonus_pools', _pool_id::text, 'Bonus pool submitted for approval',
          jsonb_build_object('pool_amount', p.pool_amount, 'allocated', v_alloc, 'people', v_n));
END $function$;

CREATE OR REPLACE FUNCTION public.hr_pay_bonus_return(_pool_id uuid, _note text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE v_status text;
BEGIN
  IF NOT public.hr_pay_is_approver() THEN RAISE EXCEPTION 'Only the position holding approve authority can return a bonus pool.'; END IF;
  IF nullif(btrim(_note),'') IS NULL THEN RAISE EXCEPTION 'Write a note saying what to change.'; END IF;
  SELECT status INTO v_status FROM hr_pay_bonus_pools WHERE id = _pool_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Bonus pool not found.'; END IF;
  IF v_status <> 'submitted' THEN RAISE EXCEPTION 'This pool is % and cannot be returned.', v_status; END IF;
  UPDATE hr_pay_bonus_pools SET status = 'returned', return_note = btrim(_note), returned_by = auth.uid(),
         returned_at = now(), updated_at = now() WHERE id = _pool_id;
  INSERT INTO audit_logs (user_id, action_type, table_name, record_id, action, metadata)
  VALUES (auth.uid(), 'hr_pay_bonus_returned', 'hr_pay_bonus_pools', _pool_id::text, 'Bonus pool returned for rework',
          jsonb_build_object('note', btrim(_note)));
END $function$;

CREATE OR REPLACE FUNCTION public.hr_pay_bonus_approve(_pool_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE p record; v_n int; v_alloc numeric;
BEGIN
  IF NOT public.hr_pay_is_approver() THEN RAISE EXCEPTION 'Only the position holding approve authority can approve a bonus pool.'; END IF;
  SELECT * INTO p FROM hr_pay_bonus_pools WHERE id = _pool_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Bonus pool not found.'; END IF;
  IF p.status <> 'submitted' THEN RAISE EXCEPTION 'This pool is % and cannot be approved.', p.status; END IF;
  SELECT count(*), coalesce(sum(amount),0) INTO v_n, v_alloc FROM hr_pay_bonus_allocations WHERE pool_id = _pool_id;
  UPDATE hr_pay_bonus_pools SET status = 'approved', approved_by = auth.uid(), approved_at = now(), updated_at = now() WHERE id = _pool_id;
  INSERT INTO audit_logs (user_id, action_type, table_name, record_id, action, metadata)
  VALUES (auth.uid(), 'hr_pay_bonus_approved', 'hr_pay_bonus_pools', _pool_id::text, 'Bonus pool approved',
          jsonb_build_object('pool_amount', p.pool_amount, 'allocated', v_alloc, 'people', v_n));
END $function$;

-- CFO pays: credits each person's wallet, all-or-nothing, once per allocation.
-- Entry keys match hr-pay-release's take-home pair (no wallet_bucket key; the recipient_type trigger stamps the bucket).
CREATE OR REPLACE FUNCTION public.hr_pay_bonus_pay(_pool_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE p record; a record; v_gid uuid; v_n int := 0; v_total numeric := 0; v_missing text;
BEGIN
  IF NOT public.hr_pay_is_releaser() THEN RAISE EXCEPTION 'Only the position holding release authority can pay a bonus pool.'; END IF;
  SELECT * INTO p FROM hr_pay_bonus_pools WHERE id = _pool_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Bonus pool not found.'; END IF;
  IF p.status <> 'approved' THEN RAISE EXCEPTION 'This pool is % — only an approved pool can be paid.', p.status; END IF;
  SELECT string_agg(s.staff_ref, ', ') INTO v_missing
    FROM hr_pay_bonus_allocations x JOIN hr_staff s ON s.id = x.staff_id WHERE x.pool_id = _pool_id AND s.user_id IS NULL;
  IF v_missing IS NOT NULL THEN RAISE EXCEPTION 'No app account linked for: %. Link them before paying.', v_missing; END IF;

  FOR a IN SELECT x.id, x.amount, s.user_id FROM hr_pay_bonus_allocations x JOIN hr_staff s ON s.id = x.staff_id
            WHERE x.pool_id = _pool_id AND x.amount > 0 AND x.ledger_group_id IS NULL LOOP
    v_gid := public.create_ledger_transaction(
      entries => jsonb_build_array(
        jsonb_build_object('user_id', a.user_id, 'amount', a.amount, 'direction', 'cash_out', 'category', 'salary_payout',
          'ledger_scope', 'platform', 'recipient_type', 'user', 'currency', 'UGX',
          'source_table', 'hr_pay_bonus_allocations', 'reference_id', a.id::text, 'description', 'Staff bonus — ' || p.title),
        jsonb_build_object('user_id', a.user_id, 'amount', a.amount, 'direction', 'cash_in', 'category', 'salary_payout',
          'ledger_scope', 'wallet', 'recipient_type', 'user', 'currency', 'UGX',
          'source_table', 'hr_pay_bonus_allocations', 'reference_id', a.id::text, 'description', 'Staff bonus — ' || p.title)),
      idempotency_key => 'staff-bonus-' || a.id::text,
      skip_balance_check => false);
    UPDATE hr_pay_bonus_allocations SET ledger_group_id = v_gid, paid_at = now() WHERE id = a.id;
    v_n := v_n + 1; v_total := v_total + a.amount;
  END LOOP;

  UPDATE hr_pay_bonus_pools SET status = 'paid', paid_by = auth.uid(), paid_at = now(), updated_at = now() WHERE id = _pool_id;
  INSERT INTO audit_logs (user_id, action_type, table_name, record_id, action, metadata)
  VALUES (auth.uid(), 'hr_pay_bonus_paid', 'hr_pay_bonus_pools', _pool_id::text, 'Bonus pool paid to staff wallets',
          jsonb_build_object('people', v_n, 'amount', v_total));
  RETURN jsonb_build_object('status', 'paid', 'people', v_n, 'amount', v_total);
END $function$;

CREATE OR REPLACE FUNCTION public.hr_pay_bonus_cancel(_pool_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE v_status text;
BEGIN
  IF NOT (public.hr_pay_is_preparer() OR public.hr_pay_is_approver()) THEN RAISE EXCEPTION 'Not authorised.'; END IF;
  SELECT status INTO v_status FROM hr_pay_bonus_pools WHERE id = _pool_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Bonus pool not found.'; END IF;
  IF v_status NOT IN ('draft','submitted','returned','approved') THEN RAISE EXCEPTION 'This pool is % and cannot be cancelled.', v_status; END IF;
  UPDATE hr_pay_bonus_pools SET status = 'cancelled', cancelled_by = auth.uid(), cancelled_at = now(), updated_at = now() WHERE id = _pool_id;
  INSERT INTO audit_logs (user_id, action_type, table_name, record_id, action, metadata)
  VALUES (auth.uid(), 'hr_pay_bonus_cancelled', 'hr_pay_bonus_pools', _pool_id::text, 'Bonus pool cancelled',
          jsonb_build_object('previous_status', v_status));
END $function$;

CREATE OR REPLACE FUNCTION public._hr_pay_bonus_read_ok()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $f$
  SELECT public.hr_pay_is_preparer() OR public.hr_pay_is_approver() OR public.hr_pay_is_releaser()
      OR public.has_role(auth.uid(), 'super_admin'::app_role)
$f$;
REVOKE ALL ON FUNCTION public._hr_pay_bonus_read_ok() FROM public, anon, authenticated;

CREATE OR REPLACE FUNCTION public.hr_pay_bonus_list()
RETURNS TABLE(pool_id uuid, title text, pool_amount numeric, notes text, status text, people int, total_pct numeric,
  allocated numeric, prepared_by_name text, approved_by_name text, paid_by_name text, submitted_at timestamptz,
  approved_at timestamptz, paid_at timestamptz, return_note text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
#variable_conflict use_column
BEGIN
  IF NOT public._hr_pay_bonus_read_ok() THEN RAISE EXCEPTION 'not authorised'; END IF;
  RETURN QUERY
  SELECT p.id, p.title, p.pool_amount::numeric, p.notes, p.status,
         coalesce(x.n,0)::int, coalesce(x.pct,0)::numeric, coalesce(x.amt,0)::numeric,
         pp.full_name::text, pa.full_name::text, pd.full_name::text,
         p.submitted_at, p.approved_at, p.paid_at, p.return_note
    FROM hr_pay_bonus_pools p
    LEFT JOIN LATERAL (SELECT count(*) n, sum(a.percentage) pct, sum(a.amount) amt
                         FROM hr_pay_bonus_allocations a WHERE a.pool_id = p.id) x ON true
    LEFT JOIN profiles pp ON pp.id = p.prepared_by
    LEFT JOIN profiles pa ON pa.id = p.approved_by
    LEFT JOIN profiles pd ON pd.id = p.paid_by
   ORDER BY (p.status = 'cancelled'), p.created_at DESC;
END $function$;

CREATE OR REPLACE FUNCTION public.hr_pay_bonus_detail(_pool_id uuid)
RETURNS TABLE(staff_id uuid, staff_ref text, full_name text, department text, "position" text,
  percentage numeric, amount numeric, paid_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
#variable_conflict use_column
BEGIN
  IF NOT public._hr_pay_bonus_read_ok() THEN RAISE EXCEPTION 'not authorised'; END IF;
  RETURN QUERY
  SELECT a.staff_id, s.staff_ref::text, pr.full_name::text, d.name::text, po.title::text,
         a.percentage::numeric, a.amount::numeric, a.paid_at
    FROM hr_pay_bonus_allocations a
    JOIN hr_staff s ON s.id = a.staff_id
    LEFT JOIN profiles pr ON pr.id = s.user_id
    LEFT JOIN LATERAL (SELECT ps.department_id, ps.position_id FROM hr_pay_payslips ps
                        WHERE ps.staff_id = s.id AND ps.is_current ORDER BY ps.computed_at DESC NULLS LAST LIMIT 1) ps ON true
    LEFT JOIN hr_departments d ON d.id = ps.department_id
    LEFT JOIN hr_positions po ON po.id = ps.position_id
   WHERE a.pool_id = _pool_id
   ORDER BY a.amount DESC;
END $function$;

CREATE OR REPLACE FUNCTION public.hr_pay_bonus_staff_options()
RETURNS TABLE(staff_id uuid, staff_ref text, full_name text, department text, "position" text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
#variable_conflict use_column
BEGIN
  IF NOT public._hr_pay_bonus_read_ok() THEN RAISE EXCEPTION 'not authorised'; END IF;
  RETURN QUERY
  SELECT s.id, s.staff_ref::text, pr.full_name::text, d.name::text, po.title::text
    FROM hr_staff s
    LEFT JOIN profiles pr ON pr.id = s.user_id
    LEFT JOIN LATERAL (SELECT ps.department_id, ps.position_id FROM hr_pay_payslips ps
                        WHERE ps.staff_id = s.id AND ps.is_current ORDER BY ps.computed_at DESC NULLS LAST LIMIT 1) ps ON true
    LEFT JOIN hr_departments d ON d.id = ps.department_id
    LEFT JOIN hr_positions po ON po.id = ps.position_id
   WHERE s.active
   ORDER BY pr.full_name NULLS LAST, s.staff_ref;
END $function$;

CREATE OR REPLACE FUNCTION public.hr_pay_bonus_pending_for_me()
RETURNS TABLE(pool_id uuid, kind text, title text, pool_amount numeric, allocated numeric, people int,
  return_note text, prepared_by_name text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
#variable_conflict use_column
DECLARE v_appr boolean; v_rel boolean; v_prep boolean;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not authorised'; END IF;
  v_appr := public.hr_pay_is_approver(); v_rel := public.hr_pay_is_releaser(); v_prep := public.hr_pay_is_preparer();
  RETURN QUERY
  SELECT p.id, k.kind, p.title, p.pool_amount::numeric, coalesce(x.amt,0)::numeric, coalesce(x.n,0)::int,
         p.return_note, pp.full_name::text
    FROM hr_pay_bonus_pools p
    JOIN LATERAL (SELECT 'approve'::text AS kind WHERE v_appr AND p.status = 'submitted'
                  UNION ALL SELECT 'pay'::text WHERE v_rel AND p.status = 'approved'
                  UNION ALL SELECT 'rework'::text WHERE v_prep AND p.status = 'returned') k ON true
    LEFT JOIN LATERAL (SELECT count(*) n, sum(a.amount) amt FROM hr_pay_bonus_allocations a WHERE a.pool_id = p.id) x ON true
    LEFT JOIN profiles pp ON pp.id = p.prepared_by
   ORDER BY p.updated_at DESC;
END $function$;

REVOKE ALL ON FUNCTION public.hr_pay_bonus_save(uuid, text, numeric, text, jsonb) FROM public, anon;
REVOKE ALL ON FUNCTION public.hr_pay_bonus_submit(uuid) FROM public, anon;
REVOKE ALL ON FUNCTION public.hr_pay_bonus_return(uuid, text) FROM public, anon;
REVOKE ALL ON FUNCTION public.hr_pay_bonus_approve(uuid) FROM public, anon;
REVOKE ALL ON FUNCTION public.hr_pay_bonus_pay(uuid) FROM public, anon;
REVOKE ALL ON FUNCTION public.hr_pay_bonus_cancel(uuid) FROM public, anon;
REVOKE ALL ON FUNCTION public.hr_pay_bonus_list() FROM public, anon;
REVOKE ALL ON FUNCTION public.hr_pay_bonus_detail(uuid) FROM public, anon;
REVOKE ALL ON FUNCTION public.hr_pay_bonus_staff_options() FROM public, anon;
REVOKE ALL ON FUNCTION public.hr_pay_bonus_pending_for_me() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.hr_pay_bonus_save(uuid, text, numeric, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.hr_pay_bonus_submit(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.hr_pay_bonus_return(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.hr_pay_bonus_approve(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.hr_pay_bonus_pay(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.hr_pay_bonus_cancel(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.hr_pay_bonus_list() TO authenticated;
GRANT EXECUTE ON FUNCTION public.hr_pay_bonus_detail(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.hr_pay_bonus_staff_options() TO authenticated;
GRANT EXECUTE ON FUNCTION public.hr_pay_bonus_pending_for_me() TO authenticated;