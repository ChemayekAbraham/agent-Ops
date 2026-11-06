-- Rollback for 20261106090000_withdrawal_pin_first_set_phone_code.sql.
-- Restores set_withdrawal_pin so it creates a first PIN again WITHOUT any proof (the hole doc 263 closes): only do
-- this together with putting the withdrawal OTP back (WithdrawFlow.tsx: WITHDRAWAL_OTP_REQUIRED = true).
drop function if exists public.pin_setup_complete(uuid, text, text);
drop function if exists public.pin_setup_issue(uuid, text, text);
drop table if exists public.withdrawal_pin_setup_codes;
-- set_withdrawal_pin: re-run its definition from 20261104150100_withdrawal_pin_email_otp.sql.
