CREATE TABLE public.crm_communications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), series_id uuid NOT NULL, version integer NOT NULL DEFAULT 1,
 title text NOT NULL, body text NOT NULL, communication_type text NOT NULL,
 audiences text[] NOT NULL, link_path text, starts_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
 state text NOT NULL DEFAULT 'draft', created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 published_at timestamptz, withdrawn_at timestamptz, withdrawn_by uuid,
 UNIQUE(series_id, version),
 CHECK (communication_type IN ('announcement','information','important','action')),
 CHECK (state IN ('draft','published','withdrawn')),
 CHECK (char_length(title) BETWEEN 1 AND 160), CHECK (char_length(body) BETWEEN 1 AND 8000),
 CHECK (cardinality(audiences) BETWEEN 1 AND 4),
 CHECK (audiences <@ ARRAY['agent','supporter','tenant','landlord','everyone']::text[]),
 CHECK (NOT ('everyone'=ANY(audiences)) OR cardinality(audiences)=1), CHECK (expires_at>starts_at),
 CHECK (link_path IS NULL OR link_path IN ('/dashboard/agent','/dashboard/tenant','/dashboard/landlord','/dashboard/funder','/settings','/profile','/crm/dashboard'))
);
GRANT SELECT ON public.crm_communications TO authenticated;
GRANT ALL ON public.crm_communications TO service_role;
ALTER TABLE public.crm_communications ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.crm_communication_receipts (
 communication_id uuid NOT NULL REFERENCES public.crm_communications(id), user_id uuid NOT NULL,
 acknowledged_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(communication_id,user_id)
);
GRANT SELECT ON public.crm_communication_receipts TO authenticated;
GRANT ALL ON public.crm_communication_receipts TO service_role;
ALTER TABLE public.crm_communication_receipts ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.crm_communication_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), communication_id uuid NOT NULL REFERENCES public.crm_communications(id),
 actor_id uuid NOT NULL, action text NOT NULL, reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(char_length(reason)>=10)
);
GRANT SELECT ON public.crm_communication_events TO authenticated;
GRANT ALL ON public.crm_communication_events TO service_role;
ALTER TABLE public.crm_communication_events ENABLE ROW LEVEL SECURITY;

CREATE INDEX crm_communications_live_window ON public.crm_communications(state,starts_at,expires_at);
CREATE INDEX crm_communications_audiences ON public.crm_communications USING gin(audiences);
CREATE INDEX crm_communication_receipts_user ON public.crm_communication_receipts(user_id,communication_id);
CREATE INDEX crm_communication_events_message ON public.crm_communication_events(communication_id,created_at);

CREATE FUNCTION public.crm_communication_account_live(p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
 SELECT EXISTS(SELECT 1 FROM public.profiles p WHERE p.id=p_user AND p.deleted_at IS NULL)
 AND NOT EXISTS(SELECT 1 FROM public.deleted_accounts d WHERE d.user_id=p_user AND d.restored_at IS NULL AND d.status IN ('soft_deleted','purged'))
$$;
CREATE FUNCTION public.crm_communication_editor() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
 SELECT auth.uid() IS NOT NULL AND public.crm_communication_account_live(auth.uid())
 AND public._has_enabled_role(auth.uid(),ARRAY['crm','super_admin'])
$$;
REVOKE ALL ON FUNCTION public.crm_communication_account_live(uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.crm_communication_editor() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.crm_communication_editor() TO authenticated,service_role;
CREATE POLICY crm_communications_editor_read ON public.crm_communications FOR SELECT TO authenticated USING(public.crm_communication_editor());
CREATE POLICY crm_receipts_read ON public.crm_communication_receipts FOR SELECT TO authenticated USING(user_id=auth.uid() OR public.crm_communication_editor());
CREATE POLICY crm_events_editor_read ON public.crm_communication_events FOR SELECT TO authenticated USING(public.crm_communication_editor());

CREATE FUNCTION public.crm_communication_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path=public AS $$ BEGIN RAISE EXCEPTION 'Communication history is append-only'; END $$;
CREATE TRIGGER crm_communication_events_immutable BEFORE UPDATE OR DELETE ON public.crm_communication_events FOR EACH ROW EXECUTE FUNCTION public.crm_communication_append_only();
CREATE TRIGGER crm_communication_receipts_immutable BEFORE UPDATE OR DELETE ON public.crm_communication_receipts FOR EACH ROW EXECUTE FUNCTION public.crm_communication_append_only();
CREATE FUNCTION public.crm_communication_content_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Withdraw communications instead of deleting them'; END IF;
 IF OLD.state<>'draft' AND (NEW.title,NEW.body,NEW.communication_type,NEW.audiences,NEW.link_path,NEW.starts_at,NEW.expires_at,NEW.series_id,NEW.version,NEW.created_by,NEW.created_at) IS DISTINCT FROM (OLD.title,OLD.body,OLD.communication_type,OLD.audiences,OLD.link_path,OLD.starts_at,OLD.expires_at,OLD.series_id,OLD.version,OLD.created_by,OLD.created_at) THEN RAISE EXCEPTION 'Published content is immutable; create a new version'; END IF;
 IF OLD.state='withdrawn' OR (OLD.state='published' AND NEW.state NOT IN ('published','withdrawn')) THEN RAISE EXCEPTION 'Invalid communication transition'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER crm_communication_content_immutable BEFORE UPDATE OR DELETE ON public.crm_communications FOR EACH ROW EXECUTE FUNCTION public.crm_communication_content_guard();

CREATE FUNCTION public.crm_communication_audience_count(p_audiences text[]) RETURNS bigint
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
BEGIN
 IF NOT public.crm_communication_editor() THEN RAISE EXCEPTION 'CRM publishing permission required'; END IF;
 IF p_audiences IS NULL OR cardinality(p_audiences)=0 OR NOT p_audiences <@ ARRAY['agent','supporter','tenant','landlord','everyone']::text[] THEN RAISE EXCEPTION 'Select a valid audience'; END IF;
 RETURN (SELECT count(DISTINCT r.user_id) FROM public.user_roles r WHERE r.enabled AND ('everyone'=ANY(p_audiences) OR r.role::text=ANY(p_audiences)) AND public.crm_communication_account_live(r.user_id));
END $$;

CREATE FUNCTION public.crm_communication_manage(p_action text,p_id uuid DEFAULT NULL,p_content jsonb DEFAULT '{}'::jsonb,p_reason text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_row public.crm_communications; v_old public.crm_communications; v_id uuid; v_series uuid; v_version integer; v_audiences text[]; v_start timestamptz; v_end timestamptz; v_type text; v_event text;
BEGIN
 IF NOT public.crm_communication_editor() THEN RAISE EXCEPTION 'CRM publishing permission required'; END IF;
 IF char_length(trim(COALESCE(p_reason,'')))<10 THEN RAISE EXCEPTION 'Provide a reason of at least 10 characters'; END IF;
 IF p_action NOT IN ('save','publish','withdraw') THEN RAISE EXCEPTION 'Invalid communication action'; END IF;
 IF p_id IS NOT NULL THEN
   SELECT * INTO v_old FROM public.crm_communications WHERE id=p_id FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'Communication not found'; END IF;
 END IF;
 IF p_action='withdraw' THEN
   IF p_id IS NULL THEN RAISE EXCEPTION 'Communication not found'; END IF;
   IF v_old.state='withdrawn' THEN RETURN to_jsonb(v_old); END IF;
   UPDATE public.crm_communications SET state='withdrawn',withdrawn_at=now(),withdrawn_by=auth.uid() WHERE id=p_id RETURNING * INTO v_row;
 ELSE
   IF p_id IS NULL THEN
     v_id := COALESCE(NULLIF(p_content->>'id','')::uuid,gen_random_uuid());
     -- The client supplies a stable UUID: retries return the original row.
     SELECT * INTO v_row FROM public.crm_communications WHERE id=v_id;
     IF FOUND THEN
       IF v_row.created_by<>auth.uid() THEN RAISE EXCEPTION 'Communication identity conflict'; END IF;
       RETURN to_jsonb(v_row);
     END IF;
   ELSE v_id:=p_id; END IF;
   SELECT array_agg(DISTINCT a) INTO v_audiences FROM jsonb_array_elements_text(p_content->'audiences') a;
   v_start:=NULLIF(p_content->>'starts_at','')::timestamptz;
   v_end:=NULLIF(p_content->>'expires_at','')::timestamptz;
   v_type:=p_content->>'communication_type';
   IF v_start IS NULL OR v_end IS NULL OR v_end<=v_start OR v_end<=now() THEN RAISE EXCEPTION 'Choose a valid start and future expiry'; END IF;
   IF p_action='publish' AND 'everyone'=ANY(v_audiences) AND COALESCE((p_content->>'confirm_everyone')::boolean,false)=false THEN RAISE EXCEPTION 'Confirm publication to Everyone'; END IF;
   IF v_old.id IS NOT NULL AND v_old.state='published' AND p_action='publish' AND (v_old.title,v_old.body,v_old.communication_type,v_old.audiences,v_old.link_path,v_old.starts_at,v_old.expires_at) IS NOT DISTINCT FROM (trim(p_content->>'title'),trim(p_content->>'body'),v_type,v_audiences,NULLIF(p_content->>'link_path',''),v_start,v_end) THEN RETURN to_jsonb(v_old); END IF;
   v_series:=COALESCE(v_old.series_id,v_id); v_version:=COALESCE(v_old.version,1);
   IF v_old.id IS NOT NULL AND v_old.state<>'draft' THEN
     -- Lock a shared series row so two editors cannot allocate the same version.
     PERFORM 1 FROM public.crm_communications WHERE id=v_series FOR UPDATE;
     v_id:=COALESCE(NULLIF(p_content->>'revision_id','')::uuid,gen_random_uuid());
     SELECT * INTO v_row FROM public.crm_communications WHERE id=v_id;
     IF FOUND THEN
       IF v_row.series_id<>v_series OR v_row.created_by<>auth.uid() THEN RAISE EXCEPTION 'Revision identity conflict'; END IF;
       RETURN to_jsonb(v_row);
     END IF;
     SELECT max(version)+1 INTO v_version FROM public.crm_communications WHERE series_id=v_series;
   END IF;
   IF v_old.state='draft' THEN
     UPDATE public.crm_communications SET title=trim(p_content->>'title'),body=trim(p_content->>'body'),communication_type=v_type,audiences=v_audiences,link_path=NULLIF(p_content->>'link_path',''),starts_at=v_start,expires_at=v_end,state=CASE WHEN p_action='publish' THEN 'published' ELSE 'draft' END,published_at=CASE WHEN p_action='publish' THEN now() ELSE NULL END WHERE id=v_id RETURNING * INTO v_row;
   ELSE
     INSERT INTO public.crm_communications(id,series_id,version,title,body,communication_type,audiences,link_path,starts_at,expires_at,state,created_by,published_at)
     VALUES(v_id,v_series,v_version,trim(p_content->>'title'),trim(p_content->>'body'),v_type,v_audiences,NULLIF(p_content->>'link_path',''),v_start,v_end,CASE WHEN p_action='publish' THEN 'published' ELSE 'draft' END,auth.uid(),CASE WHEN p_action='publish' THEN now() ELSE NULL END) RETURNING * INTO v_row;
   END IF;
   IF p_action='publish' THEN
     UPDATE public.crm_communications SET state='withdrawn',withdrawn_at=now(),withdrawn_by=auth.uid() WHERE series_id=v_series AND id<>v_row.id AND state='published';
   END IF;
 END IF;
 v_event:=CASE p_action WHEN 'save' THEN 'saved' WHEN 'publish' THEN 'published' ELSE 'withdrawn' END;
 INSERT INTO public.crm_communication_events(communication_id,actor_id,action,reason) VALUES(v_row.id,auth.uid(),v_event,trim(p_reason));
 INSERT INTO public.audit_logs(user_id,action_type,table_name,record_id,reason,metadata) VALUES(auth.uid(),'crm_communication_'||v_event,'crm_communications',v_row.id::text,trim(p_reason),jsonb_build_object('version',v_row.version,'audiences',v_row.audiences));
 INSERT INTO public.system_events(event_type,user_id,related_entity_type,related_entity_id,metadata) VALUES('crm_communication_'||v_event,auth.uid(),'crm_communication',v_row.id,jsonb_build_object('version',v_row.version,'audiences',v_row.audiences));
 RETURN to_jsonb(v_row);
END $$;

CREATE FUNCTION public.crm_communication_admin_list(p_status text DEFAULT 'all',p_offset integer DEFAULT 0) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE v_rows jsonb; v_total bigint;
BEGIN
 IF NOT public.crm_communication_editor() THEN RAISE EXCEPTION 'CRM publishing permission required'; END IF;
 IF p_status NOT IN ('all','draft','scheduled','live','ended','withdrawn') OR p_offset<0 THEN RAISE EXCEPTION 'Invalid list filter'; END IF;
 SELECT count(*) INTO v_total FROM public.crm_communications c WHERE p_status='all' OR CASE WHEN c.state='withdrawn' THEN 'withdrawn' WHEN c.state='draft' THEN 'draft' WHEN c.expires_at<=now() THEN 'ended' WHEN c.starts_at>now() THEN 'scheduled' ELSE 'live' END=p_status;
 SELECT COALESCE(jsonb_agg(to_jsonb(q)),'[]'::jsonb) INTO v_rows FROM (
   SELECT c.*,p.full_name AS author_name,
   CASE WHEN c.state='withdrawn' THEN 'withdrawn' WHEN c.state='draft' THEN 'draft' WHEN c.expires_at<=now() THEN 'ended' WHEN c.starts_at>now() THEN 'scheduled' ELSE 'live' END AS status,
   (SELECT count(*) FROM public.crm_communication_receipts r WHERE r.communication_id=c.id) AS acknowledgements,
   (SELECT COALESCE(jsonb_agg(to_jsonb(e) ORDER BY e.created_at),'[]'::jsonb) FROM public.crm_communication_events e WHERE e.communication_id=c.id) AS history
   FROM public.crm_communications c LEFT JOIN public.profiles p ON p.id=c.created_by
   WHERE p_status='all' OR CASE WHEN c.state='withdrawn' THEN 'withdrawn' WHEN c.state='draft' THEN 'draft' WHEN c.expires_at<=now() THEN 'ended' WHEN c.starts_at>now() THEN 'scheduled' ELSE 'live' END=p_status
   ORDER BY c.created_at DESC,c.id LIMIT 20 OFFSET p_offset
 ) q;
 RETURN jsonb_build_object('items',v_rows,'total',v_total);
END $$;

CREATE FUNCTION public.crm_communication_inbox(p_role text,p_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE v_rows jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT public.crm_communication_account_live(auth.uid()) OR NOT public._has_enabled_role(auth.uid(),ARRAY[p_role]) THEN RAISE EXCEPTION 'An enabled dashboard role is required'; END IF;
 SELECT COALESCE(jsonb_agg(to_jsonb(q)),'[]'::jsonb) INTO v_rows FROM (
 SELECT c.id,c.series_id,c.version,c.title,c.body,c.communication_type,c.link_path,c.starts_at,c.expires_at,
 r.acknowledged_at FROM public.crm_communications c LEFT JOIN public.crm_communication_receipts r ON r.communication_id=c.id AND r.user_id=auth.uid()
 WHERE c.state='published' AND c.starts_at<=now() AND c.expires_at>now() AND ('everyone'=ANY(c.audiences) OR p_role=ANY(c.audiences)) AND (p_id IS NULL OR c.id=p_id)
 ORDER BY CASE c.communication_type WHEN 'important' THEN 0 WHEN 'action' THEN 1 ELSE 2 END,c.published_at DESC,c.id LIMIT 50
 ) q;
 RETURN v_rows;
END $$;
CREATE FUNCTION public.crm_communication_acknowledge(p_id uuid,p_role text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_existing timestamptz; v_eligible jsonb;
BEGIN
 -- Lock prevents acknowledgement racing a withdrawal.
 PERFORM 1 FROM public.crm_communications WHERE id=p_id FOR SHARE;
 v_eligible:=public.crm_communication_inbox(p_role,p_id);
 IF jsonb_array_length(v_eligible)=0 THEN RAISE EXCEPTION 'This communication is no longer available'; END IF;
 INSERT INTO public.crm_communication_receipts(communication_id,user_id) VALUES(p_id,auth.uid()) ON CONFLICT DO NOTHING RETURNING acknowledged_at INTO v_existing;
 IF v_existing IS NOT NULL THEN
 INSERT INTO public.system_events(event_type,user_id,related_entity_type,related_entity_id,metadata) VALUES('crm_communication_acknowledged',auth.uid(),'crm_communication',p_id,jsonb_build_object('role',p_role));
 -- Refresh via the canonical trust engine, not an invented score increment.
 PERFORM public.recompute_trust_score(auth.uid());
 END IF;
 SELECT acknowledged_at INTO v_existing FROM public.crm_communication_receipts WHERE communication_id=p_id AND user_id=auth.uid();
 RETURN jsonb_build_object('id',p_id,'acknowledged_at',v_existing);
END $$;
REVOKE ALL ON FUNCTION public.crm_communication_audience_count(text[]),public.crm_communication_manage(text,uuid,jsonb,text),public.crm_communication_admin_list(text,integer),public.crm_communication_inbox(text,uuid),public.crm_communication_acknowledge(uuid,text),public.crm_communication_append_only(),public.crm_communication_content_guard() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.crm_communication_audience_count(text[]),public.crm_communication_manage(text,uuid,jsonb,text),public.crm_communication_admin_list(text,integer),public.crm_communication_inbox(text,uuid),public.crm_communication_acknowledge(uuid,text) TO authenticated,service_role;
