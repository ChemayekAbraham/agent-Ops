-- Consolidate the tenant-pay-rent wallet-payment SMS onto the same Stage-6
-- notification catalogue and topup-eligibility wording every other tenant
-- payment-confirmation message already uses (tenant-payment-notices'
-- PAYMENT_FULL/PAYMENT_PARTIAL), instead of its own bespoke inline template
-- with a hardcoded flat "up to UGX 3,000,000" line.
--
-- Same class, same shape as PAYMENT_FULL/PAYMENT_PARTIAL: transactional, no
-- per-day/week cap (checked live: both have max_per_day/max_per_week NULL).
-- No policy row is inserted -- routeTenantNotification()'s DEFAULT_POLICY
-- (sms_enabled, critical, push/in-app off) is exactly the existing
-- SMS-only behaviour this message already has; giving it push/in-app would
-- be a new capability this task did not ask for.
--
-- access_now/next_level are rendered in real money only (accessSentence /
-- nextLevelSentence in _shared/tenantTemplates.ts never emit a percentage) --
-- reusing tenant_topup_eligibility_rules()'s existing 70%/90% thresholds
-- unchanged.

INSERT INTO public.tenant_notification_events (
  event_key, label, message_class, max_per_day, max_per_week, active,
  link_path, description, body_template
) VALUES (
  'WALLET_RENT_PAYMENT_CONFIRMED',
  'Wallet rent payment confirmed',
  'transactional',
  NULL,
  NULL,
  true,
  '/dashboard/tenant',
  'Sent when tenant-pay-rent settles a rent payment from the tenant''s own wallet (self-pay or an agent auto-collecting from it). Consolidated 2026-09-25 onto the same progress/topup wording PAYMENT_FULL and PAYMENT_PARTIAL already use.',
  E'WELILE — Rent Money You Can Get\n\nHello {{name}},\n\nYou have paid {{amount_paid}} toward your rent. Your remaining balance is {{balance}}.{{access_now}}{{next_level}}\n\nView your rent card here:\n{{share_url}}\n\nPay on time, your rent limit increases daily!'
)
ON CONFLICT (event_key) DO UPDATE
  SET label = EXCLUDED.label,
      message_class = EXCLUDED.message_class,
      link_path = EXCLUDED.link_path,
      description = EXCLUDED.description,
      body_template = EXCLUDED.body_template,
      updated_at = now();
