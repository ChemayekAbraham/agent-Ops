-- Agent assistant: the floating assistant is visible to everyone signed in.
--
-- Previously the button appeared only for users on the rollout allowlist or with an Elite rank
-- (drizzle/migrations/0536_assistant_rollout_gate.sql). The data gate is unchanged: every
-- assistant tool RPC still calls public.assistant_require_agent(), which requires
-- public.assistant_is_agent(), so only agents with a collection footprint can read account data.
-- Everyone else can still open the chat and hand it to the support team.

create or replace function public.assistant_has_access()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select auth.uid() is not null;
$$;

comment on function public.assistant_has_access() is
  'Assistant visibility gate: any signed-in user. One named function so the client, the edge function and every tool RPC share one definition. Reading account data is still gated separately by public.assistant_is_agent() inside public.assistant_require_agent().';

comment on table public.assistant_config is
  'Assistant settings. The ''rollout'' key is DEPRECATED: assistant_has_access() no longer reads it since the assistant was opened to every signed-in user.';

revoke execute on function public.assistant_has_access() from public, anon;
grant  execute on function public.assistant_has_access() to authenticated, service_role;