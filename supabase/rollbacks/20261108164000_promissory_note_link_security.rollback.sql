-- Rollback for 20261108164000 (was 20261106200000).
-- Rollback for 20261106200000_promissory_note_link_security.sql.
-- Restores the production state captured on 2026-11-06 (policy text and function body from
-- pg_policies / pg_get_functiondef). Reopens the holes the migration closed; use only to undo a bad release.

-- 1. The INSERT policy, as it was.
drop policy if exists "Agents can create promissory notes" on public.promissory_notes;
create policy "Agents can create promissory notes"
  on public.promissory_notes
  as permissive
  for insert
  to authenticated
  with check (agent_id = (select auth.uid()));

-- 2. The direct-edit guard.
drop trigger if exists trg_guard_note_direct_edit on public.promissory_notes;
drop function if exists public.guard_promissory_note_direct_edit();

-- 3. search_supporters, as it was (CREATE OR REPLACE keeps the grants).
create or replace function public.search_supporters(search_term text, result_limit integer default 20)
returns table(id uuid, full_name text, phone text)
language sql
stable security definer
set search_path to 'public'
as $function$
  SELECT p.id, p.full_name, p.phone
  FROM public.profiles p
  WHERE (p.full_name ILIKE '%' || search_term || '%'
      OR p.phone ILIKE '%' || search_term || '%')
    -- Must have supporter role AND no other role
    AND EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = p.id AND ur.role = 'supporter'
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.user_roles ur2
      WHERE ur2.user_id = p.id AND ur2.role <> 'supporter'
    )
    -- Must own at least one portfolio
    AND EXISTS (
      SELECT 1 FROM public.investor_portfolios ip
      WHERE ip.investor_id = p.id
    )
  LIMIT result_limit;
$function$;
