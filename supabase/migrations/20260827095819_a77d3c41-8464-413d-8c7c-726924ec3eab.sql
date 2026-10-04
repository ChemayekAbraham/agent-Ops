CREATE INDEX IF NOT EXISTS idx_user_roles_active_agent_lookup
ON public.user_roles (user_id, role)
WHERE COALESCE(enabled, true) = true AND role IN ('agent', 'senior_agent', 'sub_agent');