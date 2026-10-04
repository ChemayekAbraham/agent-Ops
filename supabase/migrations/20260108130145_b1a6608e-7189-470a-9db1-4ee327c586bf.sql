-- Fix infinite recursion in conversation_participants RLS policies by using a SECURITY DEFINER helper

-- 1) Helper function (bypasses RLS safely)
create or replace function public.is_conversation_participant(_conversation_id uuid, _user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.conversation_participants cp
    where cp.conversation_id = _conversation_id
      and cp.user_id = _user_id
  );
$$;

-- 2) Replace recursive policies

drop policy if exists "Users can view participants of their conversations" on public.conversation_participants;
create policy "Users can view participants of their conversations"
on public.conversation_participants
for select
using (
  public.is_conversation_participant(conversation_id, auth.uid())
);

drop policy if exists "Users can add participants to conversations" on public.conversation_participants;
create policy "Users can add participants to conversations"
on public.conversation_participants
for insert
with check (
  user_id = auth.uid()
  or public.is_conversation_participant(conversation_id, auth.uid())
);

-- Note: UPDATE policy is already non-recursive (user_id = auth.uid())