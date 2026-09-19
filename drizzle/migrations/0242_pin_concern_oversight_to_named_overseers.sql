CREATE TABLE IF NOT EXISTS public.cc_concern_overseers (
  user_id uuid PRIMARY KEY,
  required_role app_role NOT NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.cc_concern_overseers TO authenticated;
GRANT ALL ON public.cc_concern_overseers TO service_role;

ALTER TABLE public.cc_concern_overseers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Overseers can read the concern overseer allowlist" ON public.cc_concern_overseers;
CREATE POLICY "Overseers can read the concern overseer allowlist"
  ON public.cc_concern_overseers FOR SELECT TO authenticated
  USING (user_id = auth.uid());

INSERT INTO public.cc_concern_overseers(user_id, required_role, note)
VALUES
  ('fe1e9f51-a2c3-49fc-bd40-b2c143afe628', 'hr'::app_role,  'Bwayo Mark Donald - sole HR overseer of Calling Center concerns'),
  ('cf561688-b3a2-4f62-b9c1-67ee7b36ff2b', 'ceo'::app_role, 'Benjamin Muhanguzi - sole CEO overseer of Calling Center concerns')
ON CONFLICT (user_id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.is_cc_concern_overseer(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT _user_id IS NOT NULL
     AND EXISTS (
       SELECT 1
         FROM public.cc_concern_overseers o
        WHERE o.user_id = _user_id
          AND public.has_role(_user_id, o.required_role)
     )
$$;

GRANT EXECUTE ON FUNCTION public.is_cc_concern_overseer(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.is_cc_concern_overseer(uuid) IS
'True only for a person named in cc_concern_overseers who still holds the role recorded against their row. Holding hr or ceo alone grants nothing.';

CREATE OR REPLACE FUNCTION public.cc_can_view_concern(
  p_concern_id uuid,
  p_user_id uuid DEFAULT auth.uid()
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT auth.uid() IS NOT NULL AND EXISTS (
    SELECT 1
      FROM public.cc_forwarded_concerns c
     WHERE c.id = p_concern_id
       AND (
         c.forwarded_by = auth.uid()
         OR c.forwarded_to = auth.uid()
         OR EXISTS (
           SELECT 1
             FROM public.cc_concern_reviewers r
            WHERE r.concern_id = c.id
              AND r.user_id = auth.uid()
              AND r.removed_at IS NULL
         )
         OR public.is_cc_concern_overseer(auth.uid())
       )
  );
$$;

COMMENT ON FUNCTION public.cc_can_view_concern(uuid, uuid) IS
'Sole read rule for Calling Center concerns, their history and their participant lists: the sender, the current recipient, anyone still an active recipient on the thread, and the named overseers in cc_concern_overseers. Non-recursive via SECURITY DEFINER. p_user_id is retained for signature compatibility only and cannot impersonate.';

ALTER POLICY cc_fc_select_scoped ON public.cc_forwarded_concerns
  USING (public.cc_can_view_concern(id, auth.uid()));

ALTER POLICY cc_reviewers_select_scoped ON public.cc_concern_reviewers
  USING (public.cc_can_view_concern(concern_id, auth.uid()));

CREATE OR REPLACE FUNCTION public.cc_can_manage_concern_participants(
  p_concern_id uuid,
  p_user_id uuid DEFAULT auth.uid()
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT p_user_id IS NOT NULL AND EXISTS (
    SELECT 1
      FROM public.cc_forwarded_concerns c
     WHERE c.id = p_concern_id
       AND (
         c.forwarded_by = p_user_id
         OR c.forwarded_to = p_user_id
         OR EXISTS (
           SELECT 1
             FROM public.cc_concern_reviewers r
            WHERE r.concern_id = c.id
              AND r.user_id = p_user_id
              AND r.removed_at IS NULL
         )
         OR public.is_cc_concern_overseer(p_user_id)
       )
  );
$$;

CREATE OR REPLACE FUNCTION public.cc_concern_reviewer_list(p_concern_ids uuid[])
RETURNS TABLE(concern_id uuid, user_id uuid, full_name text, role text, added_by_name text, created_at timestamp with time zone, added_reason text, note text, notified_at timestamp with time zone, acknowledged_at timestamp with time zone, removed_at timestamp with time zone, removed_by_name text, remove_reason text, active boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT r.concern_id, r.user_id, r.full_name, r.role,
         r.added_by_name, r.created_at, r.added_reason, r.note,
         r.notified_at, r.acknowledged_at,
         r.removed_at, r.removed_by_name, r.remove_reason,
         (r.removed_at IS NULL) AS active
    FROM public.cc_concern_reviewers r
   WHERE r.concern_id = ANY (p_concern_ids)
     AND public.cc_can_view_concern(r.concern_id, auth.uid())
   ORDER BY r.created_at ASC;
$$;

CREATE OR REPLACE FUNCTION public.cc_concern_powers()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_over boolean := false;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('can_reassign', false, 'can_set_due', false, 'is_hr', false, 'is_ceo', false, 'is_super_admin', false);
  END IF;
  v_over := public.is_cc_concern_overseer(v_uid);
  RETURN jsonb_build_object(
    'can_reassign', v_over,
    'can_set_due', v_over,
    'is_hr', (v_over AND public.has_role(v_uid, 'hr'::app_role)),
    'is_ceo', (v_over AND public.has_role(v_uid, 'ceo'::app_role)),
    'is_super_admin', false
  );
END;
$$;