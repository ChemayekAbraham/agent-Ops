CREATE OR REPLACE FUNCTION public._agent_kyc_identity_members(p_agent_ids uuid[])
RETURNS TABLE(subject_id uuid, agent_id uuid, name text, phone text, status text, has_vetting boolean, relation text, masked_nin text, is_holder boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
WITH eligible AS MATERIALIZED (
 SELECT p.id,p.full_name,p.phone,p.created_at,p.linked_national_id,v.status,v.id_source,v.id_holder_id,v.id_link_request_id,v.agent_id IS NOT NULL has_vetting,
 coalesce(nullif(p.national_id,''),(SELECT d.national_id FROM public.payout_destination_verifications d WHERE d.user_id=p.id AND d.status='verified' AND coalesce(d.national_id,'')<>'' ORDER BY d.national_id_submitted_at DESC NULLS LAST LIMIT 1)) own_id
 FROM public.profiles p LEFT JOIN public.agent_vetting v ON v.agent_id=p.id
 WHERE v.agent_id IS NOT NULL OR EXISTS(SELECT 1 FROM public.user_roles ur WHERE ur.user_id=p.id AND ur.role='agent' AND ur.enabled)
), ids AS MATERIALIZED (
 SELECT e.id,public.normalize_national_id_fuzzy(e.own_id) key,e.own_id raw_id,'own'::text relation,NULL::uuid holder_id FROM eligible e WHERE public.normalize_national_id_fuzzy(e.own_id)<>''
 UNION ALL SELECT e.id,public.normalize_national_id_fuzzy(e.linked_national_id),e.linked_national_id,'linked',NULL::uuid FROM eligible e WHERE public.normalize_national_id_fuzzy(e.linked_national_id)<>''
 UNION ALL SELECT e.id,public.normalize_national_id_fuzzy(l.nin),l.nin,'linked',l.holder_id FROM eligible e JOIN public.national_id_link_requests l ON l.requester_id=e.id AND l.status='active' WHERE public.normalize_national_id_fuzzy(l.nin)<>''
), selected AS MATERIALIZED (
 SELECT e.id,e.id_holder_id,public.normalize_national_id_fuzzy(CASE WHEN e.id_source='parent' THEN coalesce(l.nin,nullif(e.linked_national_id,'')) ELSE coalesce(nullif(e.own_id,''),nullif(e.linked_national_id,'')) END) key,
 public.mask_national_id(CASE WHEN e.id_source='parent' THEN coalesce(l.nin,nullif(e.linked_national_id,'')) ELSE coalesce(nullif(e.own_id,''),nullif(e.linked_national_id,'')) END) masked
 FROM eligible e LEFT JOIN public.national_id_link_requests l ON l.id=e.id_link_request_id AND l.requester_id=e.id AND l.holder_id=e.id_holder_id AND l.status='active'
 WHERE e.id=ANY(p_agent_ids)
), matches AS (
 SELECT DISTINCT ON(s.id,m.id) s.id subject_id,m.id agent_id,m.full_name name,m.phone,m.status,m.has_vetting,i.relation,s.masked masked_nin,s.id_holder_id,m.created_at
 FROM selected s JOIN ids i ON s.key<>'' AND i.key=s.key JOIN eligible m ON m.id=i.id
 ORDER BY s.id,m.id,(i.relation='own') DESC
), holders AS (
 SELECT m.*,coalesce(m.id_holder_id,first_value(m.agent_id) OVER(PARTITION BY m.subject_id ORDER BY (m.relation='own') DESC,m.created_at ASC NULLS LAST,m.agent_id)) holder_id FROM matches m
)
SELECT subject_id,agent_id,name,phone,status,has_vetting,relation,masked_nin,agent_id=holder_id FROM holders;
$fn$;
REVOKE ALL ON FUNCTION public._agent_kyc_identity_members(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._agent_kyc_identity_members(uuid[]) TO service_role;

CREATE OR REPLACE FUNCTION public.agent_kyc_identity_summary(p_agent_ids uuid[])
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
 IF public.is_agent_vetting_reviewer((SELECT auth.uid())) IS NOT TRUE OR public.staff_mfa_ok() IS NOT TRUE THEN RAISE EXCEPTION 'Only authorized Agent Ops reviewers can read KYC reports.' USING ERRCODE='42501'; END IF;
 IF coalesce(cardinality(p_agent_ids),0)>200 THEN RAISE EXCEPTION 'At most 200 agents per request.' USING ERRCODE='22023'; END IF;
 RETURN coalesce((SELECT jsonb_object_agg(s.id,coalesce(c.n,0)) FROM (SELECT DISTINCT unnest(p_agent_ids) id) s LEFT JOIN (SELECT subject_id,count(*) FILTER(WHERE agent_id<>subject_id) n FROM public._agent_kyc_identity_members(p_agent_ids) GROUP BY subject_id) c ON c.subject_id=s.id),'{}'::jsonb);
END; $fn$;
REVOKE ALL ON FUNCTION public.agent_kyc_identity_summary(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.agent_kyc_identity_summary(uuid[]) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.agent_kyc_identity_group(p_agent_id uuid,p_limit integer DEFAULT 50,p_offset integer DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
DECLARE result jsonb;
BEGIN
 IF public.is_agent_vetting_reviewer((SELECT auth.uid())) IS NOT TRUE OR public.staff_mfa_ok() IS NOT TRUE THEN RAISE EXCEPTION 'Only authorized Agent Ops reviewers can read KYC reports.' USING ERRCODE='42501'; END IF;
 WITH members AS MATERIALIZED (SELECT * FROM public._agent_kyc_identity_members(ARRAY[p_agent_id]))
 SELECT jsonb_build_object('masked_nin',(SELECT masked_nin FROM members LIMIT 1),'total',(SELECT count(*) FROM members),'linked_count',(SELECT count(*) FROM members WHERE agent_id<>p_agent_id),'members',coalesce((SELECT jsonb_agg(to_jsonb(m)-'subject_id'-'masked_nin' ORDER BY m.is_holder DESC,m.name,m.agent_id) FROM (SELECT * FROM members ORDER BY is_holder DESC,name,agent_id LIMIT greatest(least(coalesce(p_limit,50),100),1) OFFSET greatest(coalesce(p_offset,0),0)) m),'[]'::jsonb)) INTO result;
 RETURN result;
END; $fn$;
REVOKE ALL ON FUNCTION public.agent_kyc_identity_group(uuid,integer,integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.agent_kyc_identity_group(uuid,integer,integer) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.agent_kyc_overview(p_days integer DEFAULT 7,p_in_scope_only boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
DECLARE today date := (now() AT TIME ZONE 'Africa/Kampala')::date; result jsonb;
BEGIN
 IF public.is_agent_vetting_reviewer((SELECT auth.uid())) IS NOT TRUE OR public.staff_mfa_ok() IS NOT TRUE THEN RAISE EXCEPTION 'Only authorized Agent Ops reviewers can read KYC reports.' USING ERRCODE='42501'; END IF;
 IF p_days IS NULL OR p_days NOT IN (7,30) THEN RAISE EXCEPTION 'Choose 7 or 30 days.' USING ERRCODE='22023'; END IF;
 WITH daily AS (
 SELECT (e.created_at AT TIME ZONE 'Africa/Kampala')::date AS day,count(*) FILTER(WHERE e.event='submitted') submitted,count(*) FILTER(WHERE e.event='approved') approved,count(*) FILTER(WHERE e.event='rejected') rejected
 FROM public.agent_vetting_events e JOIN public.agent_vetting v ON v.agent_id=e.agent_id JOIN public.profiles p ON p.id=v.agent_id
 WHERE e.created_at >= ((today-p_days+1)::timestamp AT TIME ZONE 'Africa/Kampala') AND e.created_at < ((today+1)::timestamp AT TIME ZONE 'Africa/Kampala') AND e.event IN ('submitted','approved','rejected') AND (NOT p_in_scope_only OR v.in_scope)
 GROUP BY 1
 ), series AS (SELECT (today-p_days+1+i) AS day,coalesce(d.submitted,0) submitted,coalesce(d.approved,0) approved,coalesce(d.rejected,0) rejected FROM generate_series(0,p_days-1) i LEFT JOIN daily d ON d.day=today-p_days+1+i)
 SELECT jsonb_build_object('generated_at',now(),'days',p_days,'series',(SELECT jsonb_agg(to_jsonb(s) ORDER BY day) FROM series s),'counts',(SELECT coalesce(jsonb_object_agg(status,n),'{}'::jsonb) FROM (SELECT v.status,count(*) n FROM public.agent_vetting v WHERE NOT p_in_scope_only OR v.in_scope GROUP BY v.status) c)) INTO result;
 RETURN result;
END; $fn$;
REVOKE ALL ON FUNCTION public.agent_kyc_overview(integer,boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.agent_kyc_overview(integer,boolean) TO authenticated, service_role;