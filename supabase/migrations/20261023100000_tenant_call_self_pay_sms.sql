-- Post-call "pay it yourself" SMS for tenants.
--
-- When an automated call ends and the tenant pressed:
--   T1 key 1 / T2 key 1  "I will pay today"         → CALL_SELF_PAY_PROMISE
--   T2 key 2             "I'm having difficulty"    → CALL_SELF_PAY_DIFFICULTY
-- voice-autocall-notify sends the matching SMS through the tenant notification
-- engine (opt-outs, exceptions and caps apply). Self-payment is the live MoMo
-- till route: the payment is matched by the payer's phone number, which is why
-- the message says "from this phone number". The till codes come from
-- payment_channels at send time ({{pay_channels}}), never from this file.
--
-- SMS only, one per tenant per day per event. Both bodies stay under the
-- engine's 106-character budget so the footer still fits one SMS.

insert into public.tenant_notification_events (
  event_key, label, description, message_class, active, max_per_day, max_per_week,
  body_template, push_title_template, push_body_template, in_app_title_template, in_app_body_template, link_path)
values
  ('CALL_SELF_PAY_PROMISE', 'After call: will pay today',
   'Sent after an automated call when the tenant pressed "I will pay today": how to pay Welile directly from their own phone.',
   'transactional', true, 1, null,
   'Welile: Thank you. Pay your UGX {{amount}} rent on {{pay_channels}} from this phone number.',
   null, null, null, null, null),
  ('CALL_SELF_PAY_DIFFICULTY', 'After call: difficulty paying',
   'Sent after an automated call when the tenant pressed "I am having difficulty": a part payment can be made directly.',
   'transactional', true, 1, null,
   'Welile: Even part payment helps. Pay any amount on {{pay_channels}} from this phone number.',
   null, null, null, null, null)
on conflict (event_key) do nothing;

insert into public.tenant_notification_channel_policy (
  event_key, critical, sms_enabled, sms_fallback, push_enabled, push_preferred, in_app_enabled)
values
  ('CALL_SELF_PAY_PROMISE', true, true, false, false, false, false),
  ('CALL_SELF_PAY_DIFFICULTY', true, true, false, false, false, false)
on conflict (event_key) do nothing;
