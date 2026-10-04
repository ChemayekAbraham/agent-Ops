
-- Sweep function: process up to N eligible completed campaign registrations.
CREATE OR REPLACE FUNCTION public.sweep_link_campaign_sub_agents(p_batch_size int DEFAULT 500)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  r record;
  v_created int := 0;
  v_reused int := 0;
  v_conflict int := 0;
  v_skipped int := 0;
  v_res jsonb;
BEGIN
  FOR r IN
    SELECT DISTINCT ON (rcr.registered_user_id) rcr.registered_user_id
      FROM public.recruitment_campaign_registrations rcr
      JOIN public.recruitment_campaign_links rcl ON rcl.id = rcr.campaign_link_id
     WHERE rcr.registered_user_id IS NOT NULL
       AND rcl.agent_id IS NOT NULL
       AND rcl.agent_id <> rcr.registered_user_id
       -- No formal relationship yet
       AND NOT EXISTS (
         SELECT 1 FROM public.agent_subagents s
          WHERE s.sub_agent_id = rcr.registered_user_id
       )
       -- Registrant currently has the agent role
       AND EXISTS (
         SELECT 1 FROM public.user_roles ur
          WHERE ur.user_id = rcr.registered_user_id AND ur.role = 'agent'
       )
     ORDER BY rcr.registered_user_id, rcr.registered_at DESC
     LIMIT p_batch_size
  LOOP
    v_res := public.link_campaign_sub_agent(r.registered_user_id);
    IF (v_res->>'result') = 'created' THEN v_created := v_created + 1;
    ELSIF (v_res->>'result') = 'reused' THEN v_reused := v_reused + 1;
    ELSIF (v_res->>'status') = 'other_parent_conflict' THEN v_conflict := v_conflict + 1;
    ELSE v_skipped := v_skipped + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'created', v_created, 'reused', v_reused,
    'other_parent_conflict', v_conflict, 'skipped', v_skipped
  );
END $$;

GRANT EXECUTE ON FUNCTION public.sweep_link_campaign_sub_agents(int) TO service_role;

-- Schedule sweep every 5 minutes (idempotent: unschedule if already exists).
DO $$
DECLARE v_job_id int;
BEGIN
  SELECT jobid INTO v_job_id FROM cron.job WHERE jobname = 'sweep-link-campaign-sub-agents';
  IF v_job_id IS NOT NULL THEN
    PERFORM cron.unschedule(v_job_id);
  END IF;
  PERFORM cron.schedule(
    'sweep-link-campaign-sub-agents',
    '*/5 * * * *',
    $sql$ SELECT public.sweep_link_campaign_sub_agents(500); $sql$
  );
END $$;

-- One-time backfill: run the sweep now (capped larger for the initial pass).
DO $$
DECLARE v_res jsonb;
BEGIN
  v_res := public.sweep_link_campaign_sub_agents(5000);
  INSERT INTO public.audit_logs(user_id, action_type, table_name, record_id, metadata)
  VALUES (NULL, 'campaign_sub_agent_backfill_report', 'agent_subagents', NULL,
    v_res || jsonb_build_object(
      'reason','One-time backfill of formal agent_subagents from completed campaign registrations; residual will be handled by 5-minute sweep cron.'
    ));
END $$;
