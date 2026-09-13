-- Sole CFO approver allowlist + backend enforcement on CFO Dashboard approval RPCs.
CREATE TABLE IF NOT EXISTS public.cfo_approval_approvers (
  user_id uuid PRIMARY KEY,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.cfo_approval_approvers TO authenticated;
GRANT ALL ON public.cfo_approval_approvers TO service_role;

ALTER TABLE public.cfo_approval_approvers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated can read CFO approver allowlist" ON public.cfo_approval_approvers;
CREATE POLICY "Authenticated can read CFO approver allowlist"
  ON public.cfo_approval_approvers FOR SELECT TO authenticated USING (true);

INSERT INTO public.cfo_approval_approvers(user_id, note)
VALUES ('29a0cfa8-1eaf-453c-874c-0fc72fa4f74b', 'Angwen Sarah - sole CFO Dashboard approver')
ON CONFLICT (user_id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.is_cfo_approver(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT _user_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.cfo_approval_approvers a WHERE a.user_id = _user_id)
     AND public.has_role(_user_id, 'cfo'::app_role)
$$;

GRANT EXECUTE ON FUNCTION public.is_cfo_approver(uuid) TO authenticated, service_role;

-- Inject the approver guard into every CFO Dashboard approval/decision RPC.
DO $mig$
DECLARE
  r record;
  v_def text;
  v_guard text;
  v_pos int;
BEGIN
  v_guard := E'\n  IF auth.uid() IS NOT NULL AND NOT public.is_cfo_approver(auth.uid()) THEN\n    RAISE EXCEPTION ''Only the designated CFO approver may action CFO Dashboard requests'';\n  END IF;\n';

  FOR r IN
    SELECT p.oid, p.proname
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = ANY (ARRAY[
        'cfo_approve_float_request',
        'cfo_create_advance',
        'cfo_decide_agent_unallocation',
        'cfo_decide_allocation_return',
        'cfo_decide_service_centre',
        'cfo_disburse_bike_lease',
        'cfo_disburse_smartphone_order',
        'cfo_reconcile_stale_withdrawal',
        'cfo_correct_trail_entry',
        'budget_finalize_submission',
        'budget_request_revision'
      ])
  LOOP
    v_def := pg_get_functiondef(r.oid);
    IF position('is_cfo_approver' IN v_def) > 0 THEN
      CONTINUE;
    END IF;
    v_pos := position(E'\nBEGIN\n' IN v_def);
    IF v_pos = 0 THEN
      RAISE EXCEPTION 'Could not locate BEGIN in %', r.proname;
    END IF;
    v_def := left(v_def, v_pos + 6) || v_guard || substr(v_def, v_pos + 7);
    EXECUTE v_def;
  END LOOP;
END $mig$;