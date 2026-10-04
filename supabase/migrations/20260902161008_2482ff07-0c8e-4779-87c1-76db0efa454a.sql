-- WELILE-AGENTOPS-SPINE1: Agent Operations reporting spine

CREATE TABLE public.agent_ops_period_snapshots (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  granularity text NOT NULL CHECK (granularity IN ('daily','weekly','monthly')),
  period_start date NOT NULL,
  period_end date NOT NULL,
  opening_agents integer NOT NULL DEFAULT 0,
  new_agents integer NOT NULL DEFAULT 0,
  removed_agents integer NOT NULL DEFAULT 0,
  closing_agents integer NOT NULL DEFAULT 0,
  active_agents_30d integer NOT NULL DEFAULT 0,
  qualified_at_open integer NOT NULL DEFAULT 0,
  converted_in_period integer NOT NULL DEFAULT 0,
  stage_onboarded integer NOT NULL DEFAULT 0,
  stage_training integer NOT NULL DEFAULT 0,
  stage_qualified integer NOT NULL DEFAULT 0,
  centres_opening integer NOT NULL DEFAULT 0,
  centres_opened integer NOT NULL DEFAULT 0,
  centres_closed integer NOT NULL DEFAULT 0,
  provisional boolean NOT NULL DEFAULT true,
  frozen_at timestamptz,
  computed_at timestamptz NOT NULL DEFAULT now(),
  basis jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_ops_period_snapshots_uq UNIQUE (granularity, period_start)
);

CREATE TABLE public.agent_ops_district_snapshots (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  snapshot_id uuid NOT NULL REFERENCES public.agent_ops_period_snapshots(id) ON DELETE CASCADE,
  district_id integer REFERENCES public.ug_districts(id),
  subcounty_id integer REFERENCES public.ug_subcounties(id),
  agent_count integer NOT NULL DEFAULT 0,
  net_change integer NOT NULL DEFAULT 0,
  active_agents_30d integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_ops_district_snapshots_uq UNIQUE (snapshot_id, district_id, subcounty_id)
);

CREATE TABLE public.agent_ops_reports (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  granularity text NOT NULL CHECK (granularity IN ('daily','weekly','monthly')),
  period_start date NOT NULL,
  period_end date NOT NULL,
  snapshot_id uuid NOT NULL REFERENCES public.agent_ops_period_snapshots(id),
  prior_snapshot_id uuid REFERENCES public.agent_ops_period_snapshots(id),
  target_net_agents integer,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted')),
  created_by uuid NOT NULL DEFAULT auth.uid(),
  submitted_at timestamptz,
  submitted_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_ops_reports_uq UNIQUE (granularity, period_start)
);

CREATE TABLE public.agent_ops_report_notes (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  report_id uuid NOT NULL REFERENCES public.agent_ops_reports(id) ON DELETE CASCADE,
  zone text NOT NULL CHECK (zone IN ('growth','pipeline')),
  reason_note text NOT NULL CHECK (char_length(btrim(reason_note)) >= 80),
  created_by uuid NOT NULL DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_ops_report_notes_uq UNIQUE (report_id, zone)
);

CREATE TABLE public.agent_ops_report_addenda (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  report_id uuid NOT NULL REFERENCES public.agent_ops_reports(id) ON DELETE CASCADE,
  zone text NOT NULL CHECK (zone IN ('growth','pipeline')),
  addendum_text text NOT NULL,
  created_by uuid NOT NULL DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.agent_ops_report_actions (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  report_id uuid NOT NULL REFERENCES public.agent_ops_reports(id) ON DELETE CASCADE,
  zone text NOT NULL CHECK (zone IN ('growth','pipeline')),
  item_text text NOT NULL CHECK (char_length(btrim(item_text)) >= 10),
  owner_staff_id uuid REFERENCES public.hr_staff(id),
  owner_label text,
  due_date date NOT NULL,
  outcome text CHECK (outcome IN ('done','partly_done','not_done')),
  outcome_note text,
  carried_from_action_id uuid REFERENCES public.agent_ops_report_actions(id),
  closed_at timestamptz,
  closed_by uuid,
  created_by uuid NOT NULL DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewer_notified_at timestamptz,
  CONSTRAINT agent_ops_report_actions_owner_ck CHECK (owner_staff_id IS NOT NULL OR char_length(btrim(COALESCE(owner_label, ''))) > 0),
  CONSTRAINT agent_ops_report_actions_outcome_ck CHECK (outcome IS NULL OR char_length(btrim(COALESCE(outcome_note, ''))) > 0)
);

CREATE INDEX agent_ops_report_actions_report ON public.agent_ops_report_actions (report_id, zone);
CREATE INDEX agent_ops_report_actions_carried ON public.agent_ops_report_actions (carried_from_action_id) WHERE carried_from_action_id IS NOT NULL;

CREATE TABLE public.agent_ops_period_targets (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  granularity text NOT NULL CHECK (granularity IN ('daily','weekly','monthly')),
  period_start date NOT NULL,
  target_net_agents integer,
  note text,
  set_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_ops_period_targets_uq UNIQUE (granularity, period_start)
);

CREATE TABLE public.agent_ops_recruiter_exclusions (
  profile_id uuid NOT NULL PRIMARY KEY,
  reason text,
  added_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.agent_ops_pipeline_stage_events (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  agent_profile_id uuid NOT NULL,
  stage text NOT NULL CHECK (stage IN ('onboarded','training','qualified')),
  entered_at timestamptz NOT NULL DEFAULT now(),
  set_by uuid NOT NULL DEFAULT auth.uid(),
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX agent_ops_pipeline_stage_events_agent ON public.agent_ops_pipeline_stage_events (agent_profile_id, entered_at DESC);

-- Grants
GRANT SELECT ON public.agent_ops_period_snapshots TO authenticated;
GRANT ALL ON public.agent_ops_period_snapshots TO service_role;
GRANT SELECT ON public.agent_ops_district_snapshots TO authenticated;
GRANT ALL ON public.agent_ops_district_snapshots TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.agent_ops_reports TO authenticated;
GRANT ALL ON public.agent_ops_reports TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.agent_ops_report_notes TO authenticated;
GRANT ALL ON public.agent_ops_report_notes TO service_role;
GRANT SELECT, INSERT ON public.agent_ops_report_addenda TO authenticated;
GRANT ALL ON public.agent_ops_report_addenda TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.agent_ops_report_actions TO authenticated;
GRANT ALL ON public.agent_ops_report_actions TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.agent_ops_period_targets TO authenticated;
GRANT ALL ON public.agent_ops_period_targets TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.agent_ops_recruiter_exclusions TO authenticated;
GRANT ALL ON public.agent_ops_recruiter_exclusions TO service_role;
GRANT SELECT, INSERT ON public.agent_ops_pipeline_stage_events TO authenticated;
GRANT ALL ON public.agent_ops_pipeline_stage_events TO service_role;

ALTER TABLE public.agent_ops_period_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_ops_district_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_ops_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_ops_report_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_ops_report_addenda ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_ops_report_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_ops_period_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_ops_recruiter_exclusions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_ops_pipeline_stage_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "agent_ops_select_period_snapshots" ON public.agent_ops_period_snapshots FOR SELECT TO authenticated USING (has_role(auth.uid(), 'agent_ops'::app_role) OR has_role(auth.uid(), 'operations'::app_role) OR has_role(auth.uid(), 'manager'::app_role) OR has_role(auth.uid(), 'coo'::app_role) OR has_role(auth.uid(), 'ceo'::app_role) OR has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'super_admin'::app_role));

CREATE POLICY "agent_ops_select_district_snapshots" ON public.agent_ops_district_snapshots FOR SELECT TO authenticated USING (has_role(auth.uid(), 'agent_ops'::app_role) OR has_role(auth.uid(), 'operations'::app_role) OR has_role(auth.uid(), 'manager'::app_role) OR has_role(auth.uid(), 'coo'::app_role) OR has_role(auth.uid(), 'ceo'::app_role) OR has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'super_admin'::app_role));

CREATE POLICY "agent_ops_select_reports" ON public.agent_ops_reports FOR SELECT TO authenticated USING (has_role(auth.uid(), 'agent_ops'::app_role) OR has_role(auth.uid(), 'operations'::app_role) OR has_role(auth.uid(), 'manager'::app_role) OR has_role(auth.uid(), 'coo'::app_role) OR has_role(auth.uid(), 'ceo'::app_role) OR has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'super_admin'::app_role));

CREATE POLICY "agent_ops_insert_reports" ON public.agent_ops_reports FOR INSERT TO authenticated WITH CHECK (has_role(auth.uid(), 'agent_ops'::app_role));

CREATE POLICY "agent_ops_update_reports" ON public.agent_ops_reports FOR UPDATE TO authenticated USING (status = 'draft' AND (created_by = auth.uid() OR has_role(auth.uid(), 'agent_ops'::app_role))) WITH CHECK (created_by = auth.uid() OR has_role(auth.uid(), 'agent_ops'::app_role));

CREATE POLICY "agent_ops_select_report_notes" ON public.agent_ops_report_notes FOR SELECT TO authenticated USING (has_role(auth.uid(), 'agent_ops'::app_role) OR has_role(auth.uid(), 'operations'::app_role) OR has_role(auth.uid(), 'manager'::app_role) OR has_role(auth.uid(), 'coo'::app_role) OR has_role(auth.uid(), 'ceo'::app_role) OR has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'super_admin'::app_role));

CREATE POLICY "agent_ops_insert_report_notes" ON public.agent_ops_report_notes FOR INSERT TO authenticated WITH CHECK (has_role(auth.uid(), 'agent_ops'::app_role) OR EXISTS (SELECT 1 FROM public.agent_ops_reports r WHERE r.id = report_id AND r.created_by = auth.uid()));

CREATE POLICY "agent_ops_update_report_notes" ON public.agent_ops_report_notes FOR UPDATE TO authenticated USING (EXISTS (SELECT 1 FROM public.agent_ops_reports r WHERE r.id = agent_ops_report_notes.report_id AND r.status = 'draft' AND (r.created_by = auth.uid() OR has_role(auth.uid(), 'agent_ops'::app_role)))) WITH CHECK (has_role(auth.uid(), 'agent_ops'::app_role) OR EXISTS (SELECT 1 FROM public.agent_ops_reports r WHERE r.id = agent_ops_report_notes.report_id AND r.created_by = auth.uid()));

CREATE POLICY "agent_ops_select_report_addenda" ON public.agent_ops_report_addenda FOR SELECT TO authenticated USING (has_role(auth.uid(), 'agent_ops'::app_role) OR has_role(auth.uid(), 'operations'::app_role) OR has_role(auth.uid(), 'manager'::app_role) OR has_role(auth.uid(), 'coo'::app_role) OR has_role(auth.uid(), 'ceo'::app_role) OR has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'super_admin'::app_role));

CREATE POLICY "agent_ops_insert_report_addenda" ON public.agent_ops_report_addenda FOR INSERT TO authenticated WITH CHECK (has_role(auth.uid(), 'agent_ops'::app_role) OR EXISTS (SELECT 1 FROM public.agent_ops_reports r WHERE r.id = report_id AND r.created_by = auth.uid()));

CREATE POLICY "agent_ops_select_report_actions" ON public.agent_ops_report_actions FOR SELECT TO authenticated USING (has_role(auth.uid(), 'agent_ops'::app_role) OR has_role(auth.uid(), 'operations'::app_role) OR has_role(auth.uid(), 'manager'::app_role) OR has_role(auth.uid(), 'coo'::app_role) OR has_role(auth.uid(), 'ceo'::app_role) OR has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'super_admin'::app_role));

CREATE POLICY "agent_ops_insert_report_actions" ON public.agent_ops_report_actions FOR INSERT TO authenticated WITH CHECK (has_role(auth.uid(), 'agent_ops'::app_role) OR EXISTS (SELECT 1 FROM public.agent_ops_reports r WHERE r.id = report_id AND r.created_by = auth.uid()));

CREATE POLICY "agent_ops_update_report_actions" ON public.agent_ops_report_actions FOR UPDATE TO authenticated USING (EXISTS (SELECT 1 FROM public.agent_ops_reports r WHERE r.id = agent_ops_report_actions.report_id AND r.status = 'draft' AND (r.created_by = auth.uid() OR has_role(auth.uid(), 'agent_ops'::app_role)))) WITH CHECK (has_role(auth.uid(), 'agent_ops'::app_role) OR EXISTS (SELECT 1 FROM public.agent_ops_reports r WHERE r.id = agent_ops_report_actions.report_id AND r.created_by = auth.uid()));

CREATE POLICY "agent_ops_select_period_targets" ON public.agent_ops_period_targets FOR SELECT TO authenticated USING (has_role(auth.uid(), 'agent_ops'::app_role) OR has_role(auth.uid(), 'operations'::app_role) OR has_role(auth.uid(), 'manager'::app_role) OR has_role(auth.uid(), 'coo'::app_role) OR has_role(auth.uid(), 'ceo'::app_role) OR has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'super_admin'::app_role));

CREATE POLICY "agent_ops_manage_period_targets_insert" ON public.agent_ops_period_targets FOR INSERT TO authenticated WITH CHECK (has_role(auth.uid(), 'coo'::app_role) OR has_role(auth.uid(), 'manager'::app_role) OR has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'super_admin'::app_role));

CREATE POLICY "agent_ops_manage_period_targets_update" ON public.agent_ops_period_targets FOR UPDATE TO authenticated USING (has_role(auth.uid(), 'coo'::app_role) OR has_role(auth.uid(), 'manager'::app_role) OR has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'super_admin'::app_role)) WITH CHECK (has_role(auth.uid(), 'coo'::app_role) OR has_role(auth.uid(), 'manager'::app_role) OR has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'super_admin'::app_role));

CREATE POLICY "agent_ops_select_recruiter_exclusions" ON public.agent_ops_recruiter_exclusions FOR SELECT TO authenticated USING (has_role(auth.uid(), 'agent_ops'::app_role) OR has_role(auth.uid(), 'operations'::app_role) OR has_role(auth.uid(), 'manager'::app_role) OR has_role(auth.uid(), 'coo'::app_role) OR has_role(auth.uid(), 'ceo'::app_role) OR has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'super_admin'::app_role));

CREATE POLICY "agent_ops_manage_recruiter_exclusions_insert" ON public.agent_ops_recruiter_exclusions FOR INSERT TO authenticated WITH CHECK (has_role(auth.uid(), 'coo'::app_role) OR has_role(auth.uid(), 'manager'::app_role) OR has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'super_admin'::app_role));

CREATE POLICY "agent_ops_manage_recruiter_exclusions_update" ON public.agent_ops_recruiter_exclusions FOR UPDATE TO authenticated USING (has_role(auth.uid(), 'coo'::app_role) OR has_role(auth.uid(), 'manager'::app_role) OR has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'super_admin'::app_role)) WITH CHECK (has_role(auth.uid(), 'coo'::app_role) OR has_role(auth.uid(), 'manager'::app_role) OR has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'super_admin'::app_role));

CREATE POLICY "agent_ops_manage_recruiter_exclusions_delete" ON public.agent_ops_recruiter_exclusions FOR DELETE TO authenticated USING (has_role(auth.uid(), 'coo'::app_role) OR has_role(auth.uid(), 'manager'::app_role) OR has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'super_admin'::app_role));

CREATE POLICY "agent_ops_select_pipeline_stage_events" ON public.agent_ops_pipeline_stage_events FOR SELECT TO authenticated USING (has_role(auth.uid(), 'agent_ops'::app_role) OR has_role(auth.uid(), 'operations'::app_role) OR has_role(auth.uid(), 'manager'::app_role) OR has_role(auth.uid(), 'coo'::app_role) OR has_role(auth.uid(), 'ceo'::app_role) OR has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'super_admin'::app_role));

CREATE POLICY "agent_ops_insert_pipeline_stage_events" ON public.agent_ops_pipeline_stage_events FOR INSERT TO authenticated WITH CHECK (has_role(auth.uid(), 'agent_ops'::app_role) OR has_role(auth.uid(), 'coo'::app_role) OR has_role(auth.uid(), 'manager'::app_role) OR has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'super_admin'::app_role));

CREATE OR REPLACE FUNCTION public.agent_ops_touch_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END; $$ LANGUAGE plpgsql SET search_path = public;

CREATE TRIGGER agent_ops_reports_touch BEFORE UPDATE ON public.agent_ops_reports FOR EACH ROW EXECUTE FUNCTION public.agent_ops_touch_updated_at();
CREATE TRIGGER agent_ops_period_targets_touch BEFORE UPDATE ON public.agent_ops_period_targets FOR EACH ROW EXECUTE FUNCTION public.agent_ops_touch_updated_at();