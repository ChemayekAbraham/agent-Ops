CREATE TABLE public.budget_obligation_declines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id uuid NOT NULL REFERENCES public.budget_calls(id) ON DELETE CASCADE,
  department_id uuid NOT NULL REFERENCES public.hr_departments(id) ON DELETE CASCADE,
  declined_by uuid NOT NULL,
  reason text NOT NULL CHECK (char_length(btrim(reason)) >= 10),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (call_id, department_id)
);
GRANT SELECT ON public.budget_obligation_declines TO authenticated;
GRANT ALL ON public.budget_obligation_declines TO service_role;
ALTER TABLE public.budget_obligation_declines ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Decliner and finance leadership read declines" ON public.budget_obligation_declines
  FOR SELECT TO authenticated
  USING (declined_by = auth.uid() OR public.has_role(auth.uid(),'cfo') OR public.has_role(auth.uid(),'ceo') OR public.has_role(auth.uid(),'coo') OR public.has_role(auth.uid(),'super_admin'));

CREATE OR REPLACE FUNCTION public.budget_decline_obligation(p_call_id uuid, p_department_id uuid, p_reason text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_id uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not signed in' USING ERRCODE='42501'; END IF;
  IF char_length(btrim(coalesce(p_reason,''))) < 10 THEN RAISE EXCEPTION 'Reason must be at least 10 characters'; END IF;
  IF NOT EXISTS (SELECT 1 FROM budget_department_heads WHERE active AND user_id=v_uid AND department_id=p_department_id) THEN
    RAISE EXCEPTION 'Only the department head can decline this budget' USING ERRCODE='42501'; END IF;
  IF NOT EXISTS (SELECT 1 FROM budget_calls WHERE id=p_call_id AND status='open') THEN
    RAISE EXCEPTION 'This budget cycle is not open'; END IF;
  INSERT INTO budget_obligation_declines(call_id,department_id,declined_by,reason)
  VALUES (p_call_id,p_department_id,v_uid,btrim(p_reason)) RETURNING id INTO v_id;
  INSERT INTO audit_logs(user_id,action_type,table_name,record_id,metadata)
  VALUES (v_uid,'budget_obligation_declined','budget_obligation_declines',v_id::text,jsonb_build_object('call_id',p_call_id,'department_id',p_department_id,'reason',btrim(p_reason)));
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION public.budget_decline_obligation(uuid,uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.budget_decline_obligation(uuid,uuid,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.budget_my_outstanding_obligations()
 RETURNS TABLE(call_id uuid, cycle_title text, deadline timestamp with time zone, department_id uuid, department_name text, department_key text, draft_submission_id uuid, is_overdue boolean)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT c.id, c.title, c.deadline, d.id, d.name, d.key,
         (SELECT s.id FROM budget_submissions s
           WHERE s.call_id = c.id AND s.department_id = d.id AND s.status = 'draft'
           ORDER BY s.version DESC, s.created_at DESC LIMIT 1),
         (c.deadline IS NOT NULL AND now() > c.deadline)
    FROM budget_calls c
    JOIN budget_department_heads h ON h.active AND h.user_id = auth.uid()
    JOIN hr_departments d ON d.id = h.department_id AND d.active
   WHERE c.status = 'open'
     AND (c.target_department_ids IS NULL
          OR cardinality(c.target_department_ids) = 0
          OR d.id = ANY (c.target_department_ids))
     AND NOT EXISTS (
       SELECT 1 FROM budget_submissions s
        WHERE s.call_id = c.id AND s.department_id = d.id
          AND s.status IN ('pending_coo','coo_under_review','submitted',
                           'under_review','approved','rejected'))
     AND NOT EXISTS (SELECT 1 FROM budget_obligation_declines x WHERE x.call_id = c.id AND x.department_id = d.id)
   ORDER BY c.deadline NULLS LAST, c.created_at;
$function$;