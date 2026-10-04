-- Create a secure server-side function to create a conversation + participants in one transaction.
-- This avoids RLS issues caused by PostgREST returning the inserted conversation before participants exist.

create or replace function public.create_direct_conversation(other_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_conversation_id uuid;
  me uuid;
begin
  me := auth.uid();
  if me is null then
    raise exception 'Not authenticated';
  end if;

  if other_user_id is null or other_user_id = me then
    raise exception 'Invalid other_user_id';
  end if;

  -- If a direct conversation already exists between the two users, return it.
  select cp1.conversation_id
    into new_conversation_id
  from public.conversation_participants cp1
  join public.conversation_participants cp2
    on cp2.conversation_id = cp1.conversation_id
  where cp1.user_id = me
    and cp2.user_id = other_user_id
  limit 1;

  if new_conversation_id is not null then
    return new_conversation_id;
  end if;

  -- Create a new conversation.
  insert into public.conversations default values
  returning id into new_conversation_id;

  -- Add participants.
  insert into public.conversation_participants (conversation_id, user_id)
  values
    (new_conversation_id, me),
    (new_conversation_id, other_user_id);

  return new_conversation_id;
end;
$$;

-- Allow authenticated users to call it
grant execute on function public.create_direct_conversation(uuid) to authenticated;