---
name: CTO SMS Exceptions
description: CTO Dashboard tab to block a phone from receiving a specific SMS type
type: feature
---
CTO Dashboard → "SMS Exceptions" tab (`activeTab='sms-exceptions'`, `SmsExceptionsManager.tsx`) lets CTO/super_admin/manager block a phone from receiving a certain SMS type.

- Table `public.sms_message_exceptions` (phone, message_type, reason, created_by); UNIQUE(phone, message_type). RLS: cto/super_admin/manager full access.
- `message_type` matches the `source` family on outgoing SMS. `all` blocks every type. Values in `SMS_MESSAGE_TYPES` (SmsExceptionsManager.tsx): all, daily_guarantee, collection_reminder, rent_access, signup_invite, viewing_confirmation, partner_broadcast, otp, password_reset.
- Enforcement helper: `supabase/functions/_shared/smsExceptions.ts` (`isPhoneBlocked`, fail-open). Wired into: landlord-daily-guarantee-sms (daily_guarantee), send-collection-sms (collection_reminder), send-rent-access-sms (rent_access), cto-broadcast-partners-sms (partner_broadcast). Other SMS functions not yet enforced.
