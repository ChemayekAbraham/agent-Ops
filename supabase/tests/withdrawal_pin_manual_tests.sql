-- Manual test script for 20261104090000_withdrawal_pin.sql (doc 258).
-- RUN ONLY on a Supabase preview branch or a throwaway database, NEVER on production.
-- It creates a fake user, impersonates it via the JWT claim, and rolls everything back.
-- Each "expect" comment is what a reviewer should see.

begin;

-- fake user (adjust columns if auth.users needs more on your instance)
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000a1', 'pin-test@example.invalid');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);

-- 1. weak PINs refused                          expect: weak_pin x3
select public.set_withdrawal_pin('123456');
select public.set_withdrawal_pin('000000');
select public.set_withdrawal_pin('12ab56');

-- 2. first PIN                                  expect: success pin_set
select public.set_withdrawal_pin('481926');
-- 3. second "first" PIN is refused              expect: current_pin_required
select public.set_withdrawal_pin('739204');

-- 4. wrong PIN counts down                      expect: wrong_pin attempts_left 4, then 3
select public.verify_withdrawal_pin('000111', 'withdrawal');
select public.verify_withdrawal_pin('000111', 'withdrawal');

-- 5. lockout: wrong x3 more = 5 total, then even the CORRECT PIN is refused
select public.verify_withdrawal_pin('000111', 'withdrawal');   -- wrong_pin 1 left
select public.verify_withdrawal_pin('000111', 'withdrawal');   -- pin_locked
select public.verify_withdrawal_pin('481926', 'withdrawal');   -- expect: pin_locked (correct PIN refused)

-- 6. unlock by time travel (test only), then verify works and counter resets
reset role;
update public.user_withdrawal_pins set locked_until = now() - interval '1 minute'
 where user_id = '00000000-0000-0000-0000-0000000000a1';
set local role authenticated;
select public.verify_withdrawal_pin('481926', 'withdrawal');   -- expect: success verified
select public.my_withdrawal_pin_status();                       -- expect: has_pin true, required true, no locked_until

-- 7. number-change purpose blocked by the 48h hold after first set
select public.verify_withdrawal_pin('481926', 'payout_number_change');   -- expect: pin_recently_set

-- 8. the gate: a self-service withdrawal insert with NO proof is refused
--    (the withdrawal proof from step 6 is still unused, so first spend it on a bad insert to see it consumed,
--     then try again). Adjust the column list to your withdrawal_requests NOT NULL columns.
-- insert into public.withdrawal_requests (user_id, amount, payout_method, mobile_money_number, mobile_money_name)
-- values ('00000000-0000-0000-0000-0000000000a1', 5000, 'mobile_money', '0700000001', 'TEST USER');
--   expect first insert: allowed (proof consumed); second insert: ERROR withdrawal_pin_proof_required

-- 9. reset flow: request -> not ready -> (time travel) -> complete
select public.request_withdrawal_pin_reset();                   -- expect: reset_requested, release_at +48h
select public.verify_withdrawal_pin('481926', 'withdrawal');    -- expect: pin_reset_pending
select public.complete_withdrawal_pin_reset('739204');          -- expect: not_ready
reset role;
update public.withdrawal_pin_resets set release_at = now() - interval '1 minute'
 where user_id = '00000000-0000-0000-0000-0000000000a1';
set local role authenticated;
select public.complete_withdrawal_pin_reset('739204');          -- expect: pin_reset
select public.verify_withdrawal_pin('739204', 'withdrawal');    -- expect: verified (new PIN works)
select public.verify_withdrawal_pin('481926', 'withdrawal');    -- expect: wrong_pin (old PIN dead)

-- 10. owner cancels a reset they did not ask for, using the PIN
select public.request_withdrawal_pin_reset();                   -- expect: reset_requested
select public.verify_withdrawal_pin('739204', 'pin_change');    -- expect: verified (allowed while a reset is pending)
-- select public.cancel_withdrawal_pin_reset('<id from the previous result>');   -- expect: reset_cancelled

-- 11. closed by default: anon cannot call anything
reset role;
set local role anon;
-- select public.verify_withdrawal_pin('481926', 'withdrawal');   -- expect: permission denied for function

rollback;
