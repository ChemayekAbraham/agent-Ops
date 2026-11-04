-- Rollback for 20261104090000_withdrawal_pin.sql. Drops the gates first, then the data.
-- Kill switch without dropping anything:  update public.withdrawal_pin_config set enforce_mode = 'off';
drop trigger if exists trg_require_withdrawal_pin_proof on public.withdrawal_requests;
drop trigger if exists trg_require_withdrawal_pin_proof on public.payout_number_change_requests;
drop function if exists public.require_withdrawal_pin_proof();
drop function if exists public.my_withdrawal_pin_status();
drop function if exists public.complete_withdrawal_pin_reset(text);
drop function if exists public.cancel_withdrawal_pin_reset(uuid);
drop function if exists public.request_withdrawal_pin_reset();
drop function if exists public.set_withdrawal_pin(text, text);
drop function if exists public.verify_withdrawal_pin(text, text);
drop function if exists public.consume_withdrawal_pin_proof(uuid, text);
drop function if exists public.withdrawal_pin_check(uuid, text);
drop function if exists public.withdrawal_pin_format_ok(text);
drop table if exists public.withdrawal_pin_resets;
drop table if exists public.withdrawal_pin_proofs;
drop table if exists public.user_withdrawal_pins;
drop table if exists public.withdrawal_pin_config;
