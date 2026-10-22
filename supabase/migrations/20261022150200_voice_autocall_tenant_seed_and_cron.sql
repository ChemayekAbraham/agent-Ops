-- Automated call centre — the two tenant scripts, their campaigns, and the
-- per-minute dialer cron.
--
-- Both campaigns are seeded PAUSED. Nothing dials a tenant until a CRM, CTO or
-- super_admin user presses Start in the Command Center.
--
--   T1  Rent due today       08:00–10:00  Mon–Sat
--   T2  Missed payment       17:00–19:00  Mon–Sat
--   3 attempts, 2 hours apart, within the window.

insert into public.voice_autocall_scripts (code, category, name, occasion, description, steps)
values (
  'T1', 'tenant', 'Rent due today', 'rent_due',
  'Morning reminder to tenants with an unpaid Rent Plan payment on today''s bill.',
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
        "say": "Your Rent Plan payment of {amount} shillings is due today. Press 1 if you will pay today. Press 2 if you need your agent to call you. Press 3 to speak to Welile now. To stop receiving these calls, press 9.",
        "timeout": 10,
        "options": {
          "1": { "outcome": "promise_to_pay", "next": "thanks_pay" },
          "2": { "outcome": "agent_callback", "next": "thanks_callback" },
          "3": { "outcome": "transfer_requested", "next": "transfer" },
          "9": { "outcome": "opted_out", "action": "opt_out", "next": "bye_optout" }
        },
        "no_input": { "outcome": "no_choice", "next": "close" },
        "invalid": { "next": "main" }
      },
      "thanks_pay": { "type": "say", "say": "Thank you. Please pay {agent_name} today.", "next": "close" },
      "thanks_callback": { "type": "say", "say": "Thank you. Your agent will call you soon.", "next": "close" },
      "transfer": { "type": "transfer", "say": "Please hold while we connect you to the Welile team.", "outcome": "transferred", "fallback_next": "transfer_busy" },
      "transfer_busy": { "type": "say", "say": "Sorry, our team is busy right now. We will call you back.", "outcome": "callback_requested", "next": "close" },
      "bye_optout": { "type": "hangup", "say": "You will not receive these calls again. Goodbye." },
      "close": { "type": "hangup", "say": "Thank you for being with Welile. Goodbye." },
      "end_quiet": { "type": "hangup", "say": "Sorry to disturb you. Goodbye." }
    }
  }$json$::jsonb
), (
  'T2', 'tenant', 'Missed payment', 'missed_payment',
  'Evening follow-up to tenants who did not meet yesterday''s Rent Plan payment and have not paid today.',
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
        "say": "We did not receive your Rent Plan payment of {amount} shillings for {date}. Press 1 if you will pay today. Press 2 if you are having difficulty and want us to call you. Press 3 to leave a short message after the beep. To stop receiving these calls, press 9.",
        "timeout": 10,
        "options": {
          "1": { "outcome": "promise_to_pay", "next": "thanks_pay" },
          "2": { "outcome": "difficulty_callback", "next": "thanks_callback" },
          "3": { "next": "leave_message" },
          "9": { "outcome": "opted_out", "action": "opt_out", "next": "bye_optout" }
        },
        "no_input": { "outcome": "no_choice", "next": "close" },
        "invalid": { "next": "main" }
      },
      "leave_message": {
        "type": "record",
        "say": "Please speak after the beep. Press the hash key when you finish.",
        "max_seconds": 60,
        "outcome": "left_message",
        "no_input": { "outcome": "no_message", "next": "close" },
        "next": "thanks_message"
      },
      "thanks_pay": { "type": "say", "say": "Thank you. Please pay {agent_name} today.", "next": "close" },
      "thanks_callback": { "type": "say", "say": "Thank you. A Welile team member will call you.", "next": "close" },
      "thanks_message": { "type": "say", "say": "Thank you. We have received your message.", "next": "close" },
      "bye_optout": { "type": "hangup", "say": "You will not receive these calls again. Goodbye." },
      "close": { "type": "hangup", "say": "Thank you for being with Welile. Goodbye." },
      "end_quiet": { "type": "hangup", "say": "Sorry to disturb you. Goodbye." }
    }
  }$json$::jsonb
)
on conflict (code) do nothing;

do $$
begin
  perform public.voice_autocall_validate_steps(steps) from public.voice_autocall_scripts where code in ('T1', 'T2');
end $$;

insert into public.voice_autocall_script_versions (script_id, version, name, occasion, description, steps)
select id, version, name, occasion, description, steps from public.voice_autocall_scripts where code in ('T1', 'T2')
on conflict (script_id, version) do nothing;

insert into public.voice_autocall_campaigns (
  code, category, name, description, script_id, audience_kind, schedule_kind,
  window_start, window_end, days_of_week, max_attempts, retry_minutes, record_calls, status)
select 'T1', 'tenant', 'Rent due today (morning)',
       'Every tenant on today''s pinned bill who has not yet paid it in full.',
       s.id, 'tenant_due_today', 'daily', time '08:00', time '10:00',
       array[1, 2, 3, 4, 5, 6]::smallint[], 3, 120, true, 'paused'
from public.voice_autocall_scripts s where s.code = 'T1'
on conflict (code) do nothing;

insert into public.voice_autocall_campaigns (
  code, category, name, description, script_id, audience_kind, schedule_kind,
  window_start, window_end, days_of_week, max_attempts, retry_minutes, record_calls, status)
select 'T2', 'tenant', 'Missed payment (evening)',
       'Tenants who did not meet yesterday''s pinned bill and have paid nothing on it today.',
       s.id, 'tenant_missed_yesterday', 'daily', time '17:00', time '19:00',
       array[1, 2, 3, 4, 5, 6]::smallint[], 3, 120, true, 'paused'
from public.voice_autocall_scripts s where s.code = 'T2'
on conflict (code) do nothing;

-- 04:00–18:59 UTC = 07:00–21:59 Kampala, so staff test calls work early and
-- late; campaign windows and Sundays are enforced inside voice_autocall_claim.
do $$
begin
  perform cron.unschedule(jobid) from cron.job where jobname = 'voice-autocall-dialer';
  perform cron.schedule('voice-autocall-dialer', '* 4-18 * * *', $cmd$
  select net.http_post(
    url := 'https://byrzshwlentqvktcksem.supabase.co/functions/v1/voice-autocall-dialer',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || coalesce((select decrypted_secret from vault.decrypted_secrets where name = 'email_queue_service_role_key' limit 1), '')
    ),
    body := jsonb_build_object('scheduled_at', now())
  );
  $cmd$);
end
$$;
