-- Assistant "Messages" tab: the signed-in person's own chat history.
--
-- The tables hold device, IP and location columns that must never reach the browser, so the app
-- cannot select from them. This returns only role, text and time, for the caller's own messages.
-- Identity is auth.uid(); there is no user parameter.

create or replace function public.assistant_my_messages(p_limit integer default 50)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100);
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  return jsonb_build_object(
    'messages', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', m.id,
               'conversation_id', m.conversation_id,
               'role', m.role,
               'content', left(m.content, 2000),
               'created_at', m.created_at) order by m.created_at desc)
        from (
          select id, conversation_id, role, content, created_at
            from public.assistant_messages
           where user_id = auth.uid()
             and role in ('user', 'assistant')
           order by created_at desc
           limit v_limit) m), '[]'::jsonb));
end;
$$;

revoke execute on function public.assistant_my_messages(integer) from public, anon;
grant  execute on function public.assistant_my_messages(integer) to authenticated, service_role;
