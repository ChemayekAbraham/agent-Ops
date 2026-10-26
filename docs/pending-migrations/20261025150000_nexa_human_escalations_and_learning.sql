-- Prepared only: not applied. New private Nexa records; no financial writes.
BEGIN;
CREATE TABLE public.nexa_human_escalations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid,
  user_name text,
  user_phone text,
  user_role text,
  user_question text NOT NULL CHECK (length(user_question) BETWEEN 1 AND 4000),
  nexa_last_reply text,
  conversation_context jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','answered','closed')),
  founder_response text,
  responded_by uuid,
  responded_at timestamptz,
  delivered_to_user_at timestamptz,
  provider_message_id text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.nexa_human_escalations TO authenticated;
GRANT ALL ON public.nexa_human_escalations TO service_role;
REVOKE ALL ON public.nexa_human_escalations FROM anon;
ALTER TABLE public.nexa_human_escalations ENABLE ROW LEVEL SECURITY;
CREATE POLICY nexa_owner_read ON public.nexa_human_escalations FOR SELECT TO authenticated
  USING (user_id = (select auth.uid()));
CREATE POLICY nexa_desk_read ON public.nexa_human_escalations FOR SELECT TO authenticated
  USING (public.has_role((select auth.uid()), 'super_admin'));
CREATE POLICY mfa_required_for_staff ON public.nexa_human_escalations AS RESTRICTIVE FOR ALL TO authenticated
  USING ((select public.staff_mfa_ok())) WITH CHECK ((select public.staff_mfa_ok()));
CREATE INDEX nexa_escalations_user_created ON public.nexa_human_escalations (user_id, created_at DESC);
CREATE INDEX nexa_escalations_status_created ON public.nexa_human_escalations (status, created_at DESC);

CREATE TABLE public.nexa_learned_knowledge (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  topic text NOT NULL CHECK (length(topic) BETWEEN 1 AND 120),
  question_pattern text NOT NULL CHECK (length(question_pattern) BETWEEN 1 AND 500),
  canonical_answer text NOT NULL CHECK (length(canonical_answer) BETWEEN 1 AND 4000),
  role_scope text NOT NULL DEFAULT 'all' CHECK (role_scope IN ('all','tenant','agent','landlord','supporter')),
  source_escalation_id uuid REFERENCES public.nexa_human_escalations(id),
  taught_by uuid NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.nexa_learned_knowledge TO authenticated;
GRANT ALL ON public.nexa_learned_knowledge TO service_role;
REVOKE ALL ON public.nexa_learned_knowledge FROM anon;
ALTER TABLE public.nexa_learned_knowledge ENABLE ROW LEVEL SECURITY;
CREATE POLICY nexa_knowledge_active_read ON public.nexa_learned_knowledge FOR SELECT TO authenticated
  USING (active AND CASE role_scope
    WHEN 'all' THEN true
    WHEN 'tenant' THEN public.has_role((select auth.uid()), 'tenant')
    WHEN 'agent' THEN public.has_role((select auth.uid()), 'agent')
    WHEN 'landlord' THEN public.has_role((select auth.uid()), 'landlord')
    WHEN 'supporter' THEN public.has_role((select auth.uid()), 'supporter')
    ELSE false END);
CREATE POLICY nexa_knowledge_desk_read ON public.nexa_learned_knowledge FOR SELECT TO authenticated
  USING (public.has_role((select auth.uid()), 'super_admin'));
CREATE POLICY mfa_required_for_staff ON public.nexa_learned_knowledge AS RESTRICTIVE FOR ALL TO authenticated
  USING ((select public.staff_mfa_ok())) WITH CHECK ((select public.staff_mfa_ok()));
CREATE INDEX nexa_knowledge_active_scope ON public.nexa_learned_knowledge (role_scope, created_at DESC) WHERE active;
CREATE INDEX nexa_knowledge_source ON public.nexa_learned_knowledge (source_escalation_id);

-- Browser reads are RLS-scoped; writes use caller-checked RPCs. No client role stamp.
CREATE FUNCTION public.nexa_submit_escalation(p_question text, p_last_reply text, p_context jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_id uuid; v_user uuid := auth.uid();
BEGIN
  IF v_user IS NULL OR NOT public.staff_mfa_ok() THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501'; END IF;
  IF p_question IS NULL OR p_context IS NULL OR length(trim(p_question)) NOT BETWEEN 1 AND 4000 OR jsonb_typeof(p_context) <> 'array' OR pg_column_size(p_context)>30000 THEN RAISE EXCEPTION 'Invalid conversation'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('nexa:'||v_user::text));
  IF EXISTS(SELECT 1 FROM public.nexa_human_escalations WHERE user_id=v_user AND created_at>now()-interval '1 minute') THEN RAISE EXCEPTION 'Please wait before sending another request'; END IF;
  INSERT INTO public.nexa_human_escalations(user_id,user_name,user_phone,user_role,user_question,nexa_last_reply,conversation_context)
    SELECT v_user,p.full_name,p.phone,(SELECT role::text FROM public.user_roles WHERE user_id=v_user AND enabled ORDER BY created_at LIMIT 1),trim(p_question),left(p_last_reply,4000),p_context FROM public.profiles p WHERE p.id=v_user RETURNING id INTO v_id;
  IF v_id IS NULL THEN RAISE EXCEPTION 'Profile unavailable'; END IF;
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION public.nexa_submit_escalation(text,text,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.nexa_submit_escalation(text,text,jsonb) TO authenticated,service_role;

CREATE FUNCTION public.nexa_answer_escalation(p_id uuid,p_response text,p_topic text DEFAULT NULL,p_pattern text DEFAULT NULL,p_answer text DEFAULT NULL,p_role_scope text DEFAULT 'all')
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_user uuid := auth.uid();
BEGIN
  IF v_user IS NULL OR NOT public.has_role(v_user,'super_admin') OR NOT public.staff_mfa_ok() THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501'; END IF;
  IF p_response IS NULL OR length(trim(p_response)) NOT BETWEEN 1 AND 4000 THEN RAISE EXCEPTION 'Invalid response'; END IF;
  PERFORM 1 FROM public.nexa_human_escalations WHERE id=p_id AND status='pending' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request no longer pending'; END IF;
  UPDATE public.nexa_human_escalations SET founder_response=trim(p_response),responded_by=v_user,responded_at=now(),status='answered',updated_at=now() WHERE id=p_id;
  -- Learning is deliberate and separate from the private reply; never auto-copy personal details.
  IF p_answer IS NOT NULL THEN
    INSERT INTO public.nexa_learned_knowledge(topic,question_pattern,canonical_answer,role_scope,source_escalation_id,taught_by)
    VALUES(trim(p_topic),trim(p_pattern),trim(p_answer),p_role_scope,p_id,v_user);
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.nexa_answer_escalation(uuid,text,text,text,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.nexa_answer_escalation(uuid,text,text,text,text,text) TO authenticated,service_role;
COMMIT;