-- Tenant SMS copy rewritten to fit one 160-character segment (Yoola bills per
-- segment; production averaged 2.45 segments per message and only 11% of
-- messages fit in one). Meaning is unchanged; wording is tighter.
--
-- Optional fragments ({{plan_progress}}, {{growth_note}}, ...) are now dropped
-- lowest-priority-first by renderSmsTemplate() when the message would exceed
-- the budget, so the long PAYMENT_FULL / PAYMENT_PARTIAL tails no longer
-- spill into 4-6 segments.
--
-- Data-only: updates body_template for existing event_keys, touches nothing
-- else. WALLET_RENT_PAYMENT_CONFIRMED is intentionally left alone.

update public.tenant_notification_events set body_template = case event_key
  when 'DASHBOARD_ACTIVATED' then
    'Welile: Your dashboard is active. Track rent, balance and services: {{dashboard_link}}'
  when 'DASHBOARD_INVITE' then
    'Welile: Your tenant dashboard is ready. See payments and balance: {{dashboard_link}}{{status_appendix}}'
  when 'SMARTPHONE_DISCOVERY' then
    'Welile: Your tenant dashboard is ready. See payments and balance: {{dashboard_link}}{{status_appendix}}'
  when 'PUSH_MIGRATION' then
    'Welile: Turn on notifications in your dashboard for faster payment updates: {{dashboard_link}}'
  when 'FIVE_DAY_AGENT_OPPORTUNITY' then
    'Earn by helping people access Welile services. Become a Welile Agent.{{agent_cta}}'
  when 'MERCHANT_CODE_REMINDER' then
    'Pay Welile directly: {{pay_channels}}. Your agent stays recognised.'
  when 'PAYMENT_FULL' then
    'Welile: Received {{amount_paid}}. Today''s rent is cleared. Balance {{balance}}.{{plan_progress}}{{cycle_timing}}{{access_now}}{{next_level}}{{growth_note}}{{pay_direct}}{{care_note}}{{dashboard_suffix}}{{status_appendix}}'
  when 'PAYMENT_PARTIAL' then
    'Welile: Received {{amount_paid}} of {{amount_due}}. {{remaining_balance}} carries forward.{{plan_progress}}{{cycle_timing}}{{access_now}}{{next_level}}{{growth_note}}{{pay_direct}}{{care_note}}{{dashboard_suffix}}{{status_appendix}}'
  when 'PAYMENT_MISSED' then
    'Welile: Yesterday''s {{amount_due}} rent was not received and carries forward.{{pay_direct}}{{status_appendix}}'
  when 'RENT_LIMIT_INCREASED' then
    'Welile: Your rent access is now {{new_limit}}. Keep paying on time to grow it.{{dashboard_suffix}}{{status_appendix}}'
  when 'RENT_LIMIT_PROGRESS' then
    'Welile: Each on-time payment builds your record and raises your rent access.{{dashboard_suffix}}{{status_appendix}}'
  when 'TENANT_RELOCATION' then
    'Need to move? Tell Welile or your agent and help find a new tenant for your house.'
  else body_template
end
where event_key in (
  'DASHBOARD_ACTIVATED','DASHBOARD_INVITE','SMARTPHONE_DISCOVERY','PUSH_MIGRATION',
  'FIVE_DAY_AGENT_OPPORTUNITY','MERCHANT_CODE_REMINDER','PAYMENT_FULL','PAYMENT_PARTIAL',
  'PAYMENT_MISSED','RENT_LIMIT_INCREASED','RENT_LIMIT_PROGRESS','TENANT_RELOCATION'
);
