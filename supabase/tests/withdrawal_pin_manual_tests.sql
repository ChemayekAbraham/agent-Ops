-- Manual test script for 20261104090000_withdrawal_pin.sql (doc 258, v2).
-- RUN ONLY on a Supabase preview branch or a throwaway database, NEVER on production.
-- It creates a fake user, impersonates it via the JWT claim, and rolls everything back.
-- Each "expect" comment is what a reviewer should see.

begin;

insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000a1', 'pin-test@example.invalid');
insert into public.login_devices (device_fp, user_id, status)
values ('trusted-device-fp-0001', '00000000-0000-0000-0000-0000000000a1', 'trusted');   -- adjust NOT NULL columns if needed

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);

-- 1. weak PINs refused                          expect: weak_pin x3
select public.set_withdrawal_pin('123456');
select public.set_withdrawal_pin('000000');
select public.set_withdrawal_pin('12ab56');

-- 2. first PIN, then a second "first" PIN       expect: pin_set, then current_pin_required
select public.set_withdrawal_pin('481926');
select public.set_withdrawal_pin('739204');

-- 3. wrong PIN counts down                      expect: wrong_pin attempts_left 4, then 3
select public.verify_withdrawal_pin('000111', 'withdrawal');
select public.verify_withdrawal_pin('000111', 'withdrawal');

-- 4. lockout: 5 wrong in total, then even the CORRECT PIN is refused
select public.verify_withdrawal_pin('000111', 'withdrawal');   -- wrong_pin, 1 left
select public.verify_withdrawal_pin('000111', 'withdrawal');   -- pin_locked
select public.verify_withdrawal_pin('481926', 'withdrawal');   -- expect: pin_locked (correct PIN refused)

-- 5. unlock by time travel (test only); the right PIN works and the counter resets
reset role;
update public.user_withdrawal_pins set locked_until = now() - interval '1 minute'
 where user_id = '00000000-0000-0000-0000-0000000000a1';
set local role authenticated;
select public.verify_withdrawal_pin('481926', 'withdrawal');                              -- expect: verified, device_trusted false (no fp sent)
select public.verify_withdrawal_pin('481926', 'withdrawal', 'trusted-device-fp-0001');    -- expect: verified, device_trusted true
select public.verify_withdrawal_pin('481926', 'withdrawal', 'some-unknown-device-fp');    -- expect: verified, device_trusted false
select public.my_withdrawal_pin_status();                                                 -- expect: has_pin true, required true

-- 6. number-change purpose blocked by the 48 h hold after the first set
select public.verify_withdrawal_pin('481926', 'payout_number_change', 'trusted-device-fp-0001');   -- expect: pin_recently_set

-- 7. the gate (adjust the column list to withdrawal_requests' NOT NULL columns; run as the fake user)
-- insert into public.withdrawal_requests (user_id, amount, payout_method, mobile_money_number, mobile_money_name)
-- values ('00000000-0000-0000-0000-0000000000a1', 5000, 'mobile_money', '0700000001', 'TEST USER');
--   expect: first insert allowed (a proof is consumed); second insert: ERROR withdrawal_pin_proof_required
-- repeat with payout_method 'cash' (cash pickups are gated too): same result
-- after a successful number-change request (when the hold has passed): payout_number_change_requests row has
--   pin_verified = true, device_fp = the fp sent, device_trusted = true/false accordingly

-- 8. RESET, real inbox path (email+sms). These are service-role functions: switch role.
reset role;
select public.pin_reset_begin('00000000-0000-0000-0000-0000000000a1', true);    -- expect: reset_requested, required_factors email+sms, release_at ~ now
select public.pin_reset_begin('00000000-0000-0000-0000-0000000000a1', true);    -- expect: already_pending (same reset_id)

set local role authenticated;
select public.verify_withdrawal_pin('481926', 'withdrawal');                    -- expect: pin_reset_pending

reset role;
-- the edge function would send the codes; here we store known hashes (sha256 hex of "<uid>:<channel>:<code>")
select public.pin_challenge_issue('00000000-0000-0000-0000-0000000000a1', 'sms',
  encode(digest('00000000-0000-0000-0000-0000000000a1:sms:111222', 'sha256'), 'hex'), '+••• ••• 001');     -- expect: issued
select public.pin_challenge_issue('00000000-0000-0000-0000-0000000000a1', 'email',
  encode(digest('00000000-0000-0000-0000-0000000000a1:email:333444', 'sha256'), 'hex'), 't***@x.com');     -- expect: issued
-- wrong sms code twice (counted), email missing:
select public.pin_reset_complete('00000000-0000-0000-0000-0000000000a1',
  encode(digest('00000000-0000-0000-0000-0000000000a1:sms:000000', 'sha256'), 'hex'), null, '739204');     -- expect: wrong_code, attempts_left 4
select public.pin_reset_complete('00000000-0000-0000-0000-0000000000a1',
  encode(digest('00000000-0000-0000-0000-0000000000a1:sms:111222', 'sha256'), 'hex'), null, '739204');     -- expect: sms ok, then email: wrong_code (null hash), attempts_left 4
select public.pin_reset_complete('00000000-0000-0000-0000-0000000000a1',
  encode(digest('00000000-0000-0000-0000-0000000000a1:sms:111222', 'sha256'), 'hex'),
  encode(digest('00000000-0000-0000-0000-0000000000a1:email:333444', 'sha256'), 'hex'), '739204');         -- expect: pin_reset (sms stayed verified)

set local role authenticated;
select public.verify_withdrawal_pin('739204', 'withdrawal');                    -- expect: verified (new PIN)
select public.verify_withdrawal_pin('481926', 'withdrawal');                    -- expect: wrong_pin (old PIN dead)

-- 9. RESET, no usable email (sms only + 48 h wait)
reset role;
select public.pin_reset_begin('00000000-0000-0000-0000-0000000000a1', false);   -- expect: reset_requested, required_factors sms, release_at +48 h
select public.pin_challenge_issue('00000000-0000-0000-0000-0000000000a1', 'email', repeat('a', 64));   -- expect: channel_not_required
select public.pin_reset_complete('00000000-0000-0000-0000-0000000000a1', repeat('a', 64), null, '581937');   -- expect: not_ready

-- 10. code rate limit: 3 per hour per channel      expect: issued x3 for sms, then rate_limited on the 4th
-- (loop pin_challenge_issue with fresh 64-hex hashes)

-- 11. owner cancels a reset they did not ask for, with the PIN
set local role authenticated;
select public.verify_withdrawal_pin('739204', 'pin_change');                    -- expect: verified (allowed while a reset is pending)
-- select public.cancel_withdrawal_pin_reset('<reset id from step 9>');          -- expect: reset_cancelled

-- 12. closed by default: anon and authenticated cannot call the service-role functions
-- set local role authenticated; select public.pin_reset_begin('00000000-0000-0000-0000-0000000000a1', true);   -- expect: permission denied
-- set local role anon;          select public.verify_withdrawal_pin('481926', 'withdrawal');                   -- expect: permission denied

rollback;
