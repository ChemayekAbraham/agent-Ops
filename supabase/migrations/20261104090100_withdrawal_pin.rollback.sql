-- Rollback for 20261104090100_withdrawal_pin.sql AND its follow-ups 20261104130000 (four digits) and 20261104150100 (email codes). Drops the gates first, then the data.
-- Kill switch without dropping anything:  update public.withdrawal_pin_config set enforce_mode = 'off';
-- Redeploy-free: the edge function withdrawal-pin-reset simply starts failing once its functions are gone; delete it too.
drop trigger if exists trg_require_withdrawal_pin_proof on public.withdrawal_requests;
drop trigger if exists trg_require_withdrawal_pin_proof on public.payout_number_change_requests;
drop function if exists public.require_withdrawal_pin_proof();
drop function if exists public.my_withdrawal_pin_status();
drop function if exists public.cancel_withdrawal_pin_reset(uuid);
drop function if exists public.pin_change_complete(uuid, text, text, text);
drop function if exists public.pin_change_issue(uuid, text, text);
drop function if exists public.pin_reset_complete(uuid, text, text, text);
drop function if exists public.pin_challenge_check(uuid, uuid, text, text);
drop function if exists public.pin_challenge_issue(uuid, text, text, text);
drop function if exists public.pin_reset_begin(uuid, boolean);
drop function if exists public.set_withdrawal_pin(text, text);
drop function if exists public.verify_withdrawal_pin(text, text, text);
drop function if exists public.consume_withdrawal_pin_proof(uuid, text);
drop function if exists public.withdrawal_pin_check(uuid, text);
drop function if exists public.withdrawal_pin_format_ok(text);
drop table if exists public.withdrawal_pin_challenges;
drop table if exists public.withdrawal_pin_resets;
drop table if exists public.withdrawal_pin_proofs;
drop table if exists public.user_withdrawal_pins;
drop table if exists public.withdrawal_pin_config;
alter table public.payout_number_change_requests
  drop column if exists pin_verified,
  drop column if exists device_fp,
  drop column if exists device_trusted;
