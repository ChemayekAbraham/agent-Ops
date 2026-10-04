
ALTER TABLE public.agent_capabilities DROP CONSTRAINT IF EXISTS chk_capability;
ALTER TABLE public.agent_capabilities
  ADD CONSTRAINT chk_capability CHECK (
    capability IN (
      'collect_rent','onboard_tenants','onboard_landlords',
      'capture_supporters','act_as_proxy','process_cash_out',
      'manage_subagents','approve_subagents','request_float',
      'view_agent_dashboard','view_subagent_data'
    )
  );
