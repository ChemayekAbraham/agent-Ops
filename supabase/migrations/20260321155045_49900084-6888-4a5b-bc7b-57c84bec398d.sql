
-- Agent tasks for operations manager to assign work
CREATE TABLE public.agent_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  assigned_by UUID REFERENCES public.profiles(id),
  task_type TEXT NOT NULL DEFAULT 'general',
  title TEXT NOT NULL,
  description TEXT,
  priority TEXT NOT NULL DEFAULT 'medium',
  status TEXT NOT NULL DEFAULT 'pending',
  due_date TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  tenant_id UUID REFERENCES public.profiles(id),
  rent_request_id UUID,
  gps_required BOOLEAN DEFAULT false,
  completion_latitude DOUBLE PRECISION,
  completion_longitude DOUBLE PRECISION,
  completion_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.agent_tasks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view agent tasks"
  ON public.agent_tasks FOR SELECT TO authenticated USING (true);

CREATE POLICY "Managers can manage agent tasks"
  ON public.agent_tasks FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'coo'));

CREATE POLICY "Agents can update own tasks"
  ON public.agent_tasks FOR UPDATE TO authenticated
  USING (agent_id = auth.uid());

-- Agent escalations
CREATE TABLE public.agent_escalations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  escalation_type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'medium',
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  resolved_at TIMESTAMPTZ,
  resolved_by UUID REFERENCES public.profiles(id),
  resolution_notes TEXT,
  tenant_id UUID REFERENCES public.profiles(id),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.agent_escalations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view agent escalations"
  ON public.agent_escalations FOR SELECT TO authenticated USING (true);

CREATE POLICY "Managers can manage agent escalations"
  ON public.agent_escalations FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'coo'));

CREATE POLICY "Agents can insert escalations"
  ON public.agent_escalations FOR INSERT TO authenticated
  WITH CHECK (agent_id = auth.uid());
