-- Automated call centre — demonstration test calls to one fixed number, plus
-- the two Supporter scripts.
--
-- The Command Center's "Test calls" panel rings a single approved number
-- (0701355245) as a Tenant, Employee or Supporter. voice_autocall_test_call()
-- cannot do this: it only rings staff numbers, and 0701355245 is not a staff
-- account. The destination lives here, on the server, so a caller cannot point
-- a demo call anywhere else. Same gate as the rest: crm, cto, super_admin.
-- Demo calls are ordinary test jobs (is_test, one attempt, 07:00–21:00), so
-- opt-outs and person pauses still apply to the number.

create or replace function public.voice_autocall_demo_phone()
returns text
language sql
immutable
set search_path to 'public'
as $$ select '+256701355245'::text $$;

revoke all on function public.voice_autocall_demo_phone() from public, anon, authenticated;

create or replace function public.voice_autocall_demo_config()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  perform public.voice_autocall_assert();
  return jsonb_build_object('phone', '0' || right(public.voice_autocall_demo_phone(), 9));
end;
$$;

create or replace function public.voice_autocall_demo_call(p_script_id uuid)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  s public.voice_autocall_scripts;
  v_phone text := public.voice_autocall_demo_phone();
  v_person uuid;
  v_name text;
  v_id uuid;
begin
  perform public.voice_autocall_assert();
  select * into s from public.voice_autocall_scripts where id = p_script_id and is_active;
  if not found then raise exception 'script_not_found_or_inactive'; end if;

  -- One demo call at a time to the number, so repeated clicks don't stack up.
  if exists (
    select 1 from public.voice_autocall_jobs
    where phone = v_phone and is_test and status in ('queued', 'dialing', 'in_progress')
  ) then
    raise exception 'a_test_call_to_this_number_is_already_in_progress';
  end if;

  select id, full_name into v_person, v_name
  from public.profiles
  where public.voice_autocall_e164(phone) = v_phone and deleted_at is null
  order by created_at
  limit 1;

  insert into public.voice_autocall_jobs (
    script_id, script_version, script_snapshot, category, person_id, person_name, phone, variables,
    is_test, requested_by, max_attempts, retry_minutes, record_calls, expires_at)
  values (
    s.id, s.version, s.steps, s.category, v_person, coalesce(v_name, 'Test number'), v_phone,
    jsonb_build_object(
      'first_name', public.voice_autocall_first_name(v_name),
      'amount', '50,000',
      'date', to_char((now() at time zone 'Africa/Kampala')::date, 'FMDD FMMonth'),
      'agent_name', 'your agent',
      'message', 'This is a test message from the Welile automated call centre'),
    true, auth.uid(), 1, 15, true, now() + interval '30 minutes')
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public.voice_autocall_demo_config() from public, anon;
grant execute on function public.voice_autocall_demo_config() to authenticated, service_role;
revoke all on function public.voice_autocall_demo_call(uuid) from public, anon;
grant execute on function public.voice_autocall_demo_call(uuid) to authenticated, service_role;

-- ───────────────────────── Supporter scripts (no campaigns) ─────────────────────────

insert into public.voice_autocall_scripts (code, category, name, occasion, description, steps)
values (
  'P1', 'partner', 'Returns paid', 'returns_paid',
  'Tells a Supporter their Returns have been paid to their Welile wallet.',
  $json${
    "voice": "woman",
    "start": "confirm",
    "steps": {
      "confirm": {
        "type": "menu",
        "say": "Hello {first_name}, this is Welile calling. This call is recorded for quality. If you are {first_name}, press 1.",
        "timeout": 10,
        "options": { "1": { "next": "main" } },
        "no_input": { "outcome": "unconfirmed", "next": "end_quiet" },
        "invalid": { "next": "confirm" }
      },
      "main": {
        "type": "menu",
        "say": "Your Returns of {amount} shillings have been paid to your Welile wallet. Press 1 to speak to the Welile team. To stop receiving these calls, press 9.",
        "timeout": 10,
        "options": {
          "1": { "outcome": "transfer_requested", "next": "transfer" },
          "9": { "outcome": "opted_out", "action": "opt_out", "next": "bye_optout" }
        },
        "no_input": { "outcome": "listened", "next": "close" },
        "invalid": { "next": "main" }
      },
      "transfer": { "type": "transfer", "say": "Please hold while we connect you to the Welile team.", "outcome": "transferred", "fallback_next": "transfer_busy" },
      "transfer_busy": { "type": "say", "say": "Sorry, our team is busy right now. We will call you back.", "outcome": "callback_requested", "next": "close" },
      "bye_optout": { "type": "hangup", "say": "You will not receive these calls again. Goodbye." },
      "close": { "type": "hangup", "say": "Thank you for being a Welile Supporter. Goodbye." },
      "end_quiet": { "type": "hangup", "say": "Sorry to disturb you. Goodbye." }
    }
  }$json$::jsonb
), (
  'P2', 'partner', 'Supporter check-in', 'dormant_supporter',
  'Invites a Supporter who has not been active to hear about tenants waiting for Rent Plan support.',
  $json${
    "voice": "woman",
    "start": "confirm",
    "steps": {
      "confirm": {
        "type": "menu",
        "say": "Hello {first_name}, this is Welile calling. This call is recorded for quality. If you are {first_name}, press 1.",
        "timeout": 10,
        "options": { "1": { "next": "main" } },
        "no_input": { "outcome": "unconfirmed", "next": "end_quiet" },
        "invalid": { "next": "confirm" }
      },
      "main": {
        "type": "menu",
        "say": "We have new tenants waiting for Rent Plan support. Press 1 if you would like a Welile team member to call you. Press 2 if not now. To stop receiving these calls, press 9.",
        "timeout": 10,
        "options": {
          "1": { "outcome": "callback_requested", "next": "thanks_callback" },
          "2": { "outcome": "not_now", "next": "close" },
          "9": { "outcome": "opted_out", "action": "opt_out", "next": "bye_optout" }
        },
        "no_input": { "outcome": "no_choice", "next": "close" },
        "invalid": { "next": "main" }
      },
      "thanks_callback": { "type": "say", "say": "Thank you. A Welile team member will call you soon.", "next": "close" },
      "bye_optout": { "type": "hangup", "say": "You will not receive these calls again. Goodbye." },
      "close": { "type": "hangup", "say": "Thank you for being a Welile Supporter. Goodbye." },
      "end_quiet": { "type": "hangup", "say": "Sorry to disturb you. Goodbye." }
    }
  }$json$::jsonb
)
on conflict (code) do nothing;

do $$
begin
  perform public.voice_autocall_validate_steps(steps) from public.voice_autocall_scripts where code in ('P1', 'P2');
end $$;

insert into public.voice_autocall_script_versions (script_id, version, name, occasion, description, steps)
select id, version, name, occasion, description, steps from public.voice_autocall_scripts where code in ('P1', 'P2')
on conflict (script_id, version) do nothing;
