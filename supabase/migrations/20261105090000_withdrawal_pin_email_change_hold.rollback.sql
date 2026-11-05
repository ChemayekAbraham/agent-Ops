-- Rollback for 20261105090000_withdrawal_pin_email_change_hold.sql.
-- Faster, non-destructive: update public.withdrawal_pin_config set email_change_hold_hours = 0;
drop trigger if exists trg_withdrawal_pin_note_email_change on public.profiles;
drop function if exists public.withdrawal_pin_note_email_change();
alter table public.user_withdrawal_pins drop column if exists email_changed_at;
alter table public.withdrawal_pin_config drop column if exists email_change_hold_hours;
-- pin_reset_begin: re-run its definition from 20261104150000_withdrawal_pin_email_otp.sql (it has no email-change check).
