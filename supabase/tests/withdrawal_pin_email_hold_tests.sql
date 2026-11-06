-- Manual test for 20261105090000_withdrawal_pin_email_change_hold.sql. Everything is rolled back.
-- Needs a profile that already has a PIN row. In psql run:  \set uid '''<profile uuid>'''
-- On production use only the CTO's own account, inside this transaction.
begin;
-- 1. a reset can start before any email change             expect: reset_requested
select public.pin_reset_begin(:uid::uuid, true);
-- 2. the email changes                                      expect: pending reset is cancelled, email_changed_at is set
update public.profiles set email = 'changed-' || email where id = :uid::uuid;
select status, decision_note from public.withdrawal_pin_resets where user_id = :uid::uuid order by requested_at desc limit 1;
select email_changed_at from public.user_withdrawal_pins where user_id = :uid::uuid;
-- 3. a new reset is refused inside the hold                 expect: email_recently_changed, release_at about now + 48 h
select public.pin_reset_begin(:uid::uuid, true);
-- 4. same address, different case: no new hold              expect: email_changed_at unchanged from step 2
update public.profiles set email = upper(email) where id = :uid::uuid;
select email_changed_at from public.user_withdrawal_pins where user_id = :uid::uuid;
-- 5. time travel (test only): the hold has passed           expect: reset_requested
update public.user_withdrawal_pins set email_changed_at = now() - interval '49 hours' where user_id = :uid::uuid;
select public.pin_reset_begin(:uid::uuid, true);
-- 6. switch the hold off                                    expect: allowed straight after an email change (already_pending, because step 5 left one open)
update public.withdrawal_pin_config set email_change_hold_hours = 0;
update public.user_withdrawal_pins set email_changed_at = now() where user_id = :uid::uuid;
select public.pin_reset_begin(:uid::uuid, true);
-- 7. a profile with no PIN row: changing its email does nothing for this feature (no error, no audit row).
rollback;
