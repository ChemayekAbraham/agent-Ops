-- Promissory note linking and Supporter lookup: close the browser paths (2026-11-06).
--
-- Checked against production (byrzshwlentqvktcksem) on 2026-11-06 before writing this file:
--
-- 1. Policy "Agents can create promissory notes" (INSERT, WITH CHECK agent_id = auth.uid()) let any
--    signed-in user insert a note with any partner_user_id, status, approval flags, token or dates.
--    An insert with status 'activated' fires recognise_partner_receivable_on_insert, which books a
--    partner receivable in the ledger, and an insert with approval_bonus_paid = true is treated as an
--    approved note by the commission engine. Nothing in src/ or supabase/functions/ inserts notes
--    directly: every creation path is a SECURITY DEFINER RPC (agent_create_promissory_note,
--    agent_create_promissory_note_for_houses, neexabot_ensure_partner_note), which do not use RLS.
--    -> The policy is dropped. No other INSERT policy exists, so the browser can no longer insert.
--
-- 2. Policy "Agents can update own pending notes" (USING agent_id = auth.uid() AND status = 'pending',
--    no WITH CHECK) let the agent change every column of their own pending note as long as it stays
--    pending: partner_user_id (who the note belongs to), approval_bonus_paid (fires
--    pay_commission_after_note_approval), approved_at (fires the lead override ledger posting),
--    approved_by, activation_token, agent_id, total_collected. The only screen that edits a note
--    directly (AgentPromissoryNotesSection) changes seven descriptive fields.
--    -> Trigger guard_promissory_note_direct_edit: a direct browser update (role anon/authenticated)
--       by someone without a note-admin role may change only those descriptive fields. RPCs (run as
--       their owner), edge functions (service_role) and staff on the existing admin UPDATE policy
--       are not affected.
--
-- 3. search_supporters(text, integer) was callable by every signed-in user with no caller check and
--    matched any substring of name or phone, so it listed Supporters' names and phones. Its only
--    caller is AgentInvestForPartnerDialog (agent dashboard), which passes the last 9 digits of the
--    phone the agent typed and keeps only an exact last-9 match. 59,874 of 98,279 accounts hold an
--    enabled agent role, so a role check alone is not enough.
--    -> Agent-family or ops caller required, and the lookup is an exact last-9-digit phone match.
--
-- Rollback: supabase/rollbacks/20261106200000_promissory_note_link_security.rollback.sql
-- Test:     supabase/tests/promissory_note_link_security/

-- 1 ─────────────────────────────────────────────────────────────────────────────────────────────
drop policy if exists "Agents can create promissory notes" on public.promissory_notes;

-- 2 ─────────────────────────────────────────────────────────────────────────────────────────────
-- SECURITY INVOKER on purpose: current_user must be the role that issued the UPDATE. Inside a
-- SECURITY DEFINER RPC it is the RPC's owner, for an edge function it is service_role, and for a
-- PostgREST request from the browser it is authenticated (or anon).
create or replace function public.guard_promissory_note_direct_edit()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  -- What AgentPromissoryNotesSection edits, plus bookkeeping columns.
  v_editable constant text[] := array[
    'partner_name', 'amount', 'recorded_on', 'fulfilment_due_on',
    'follow_up_status', 'last_followed_up_on', 'follow_up_note', 'notes', 'updated_at'
  ];
  v_old jsonb := to_jsonb(old);
  v_locked text;
begin
  if current_user not in ('anon', 'authenticated') then
    return new;
  end if;

  -- The same roles as the "Admin roles can update promissory notes" policy.
  if public.current_user_has_any_role_ignoring_enabled(array[
       'operations', 'cfo', 'coo', 'super_admin', 'manager', 'partner_ops', 'agent_ops'
     ]::public.app_role[]) then
    return new;
  end if;

  select string_agg(n.key, ', ' order by n.key)
    into v_locked
    from jsonb_each(to_jsonb(new)) as n(key, value)
   where n.key <> all (v_editable)
     and (v_old -> n.key) is distinct from n.value;

  if v_locked is not null then
    raise exception 'NOTE_FIELD_LOCKED: % cannot be changed here. Linking, approval and status changes go through Partner Ops.', v_locked
      using errcode = '42501';
  end if;

  return new;
end;
$$;

revoke all on function public.guard_promissory_note_direct_edit() from public, anon, authenticated;

drop trigger if exists trg_guard_note_direct_edit on public.promissory_notes;
create trigger trg_guard_note_direct_edit
  before update on public.promissory_notes
  for each row execute function public.guard_promissory_note_direct_edit();

-- 3 ─────────────────────────────────────────────────────────────────────────────────────────────
-- CREATE OR REPLACE keeps the existing grants (authenticated, service_role).
create or replace function public.search_supporters(search_term text, result_limit integer default 20)
returns table(id uuid, full_name text, phone text)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_last9 text := public.normalize_phone_last9(search_term);
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  if not (
       public.has_role(v_uid, 'agent') or public.has_role(v_uid, 'senior_agent')
    or public.has_role(v_uid, 'sub_agent') or public.has_role(v_uid, 'partner_ops')
    or public.is_ops_role(v_uid)
  ) then
    raise exception 'Not authorised to search Supporters' using errcode = '42501';
  end if;

  -- Exact phone lookup only: a name or a partial number returns nothing.
  if v_last9 is null then
    return;
  end if;

  return query
  select p.id, p.full_name, p.phone
    from public.profiles p
   where public.normalize_phone_last9(p.phone) = v_last9
     -- Must have supporter role AND no other role
     and exists (
       select 1 from public.user_roles ur
        where ur.user_id = p.id and ur.role = 'supporter'
     )
     and not exists (
       select 1 from public.user_roles ur2
        where ur2.user_id = p.id and ur2.role <> 'supporter'
     )
     -- Must own at least one portfolio
     and exists (
       select 1 from public.investor_portfolios ip
        where ip.investor_id = p.id
     )
   limit least(greatest(coalesce(result_limit, 20), 1), 20);
end;
$$;

revoke all on function public.search_supporters(text, integer) from public, anon;
grant execute on function public.search_supporters(text, integer) to authenticated, service_role;

