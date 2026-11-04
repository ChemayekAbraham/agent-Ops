-- When money reaches the company's merchant phone from a number registered to a merchant desk, that desk's float is cut automatically.
--
-- THE PROBLEM: the automatic float return finds the desk from the SENDER'S PHONE matched to a profile. When an agent returns money from a second number
-- (Immaculate Namulindwa sent 5M from 741003567 and 752383262), nothing matched or the wrong profile did, so her float was never cut and the desk looked
-- bigger than it was.
--
-- THE FIX: merchant_desk_phone_numbers (numbers finance has registered to a desk, filled by "Remember this number" when a receipt is placed from the
-- Company Receipts To Place list) is now read first by auto_create_deposits_from_gmail_impl. A receipt whose sender number is registered to a desk is booked
-- as that desk's float return by the same function the phone match already uses (auto_record_merchant_float_return), even if the number is also on
-- another profile. Everything else in the function is unchanged. Patched in place from the live definition, each of the two text edits checked to occur
-- exactly once; if the live function is not what is expected the migration stops and writes nothing.
--
-- Also registers Immaculate's two numbers (741003567, 752383262), which the user confirmed are hers. Receipts already in the list stay there to place with one tap.
-- Roll back with 20261029110000_desk_numbers_cut_float_automatically.rollback.sql.

DO $migration$
DECLARE
  v_def text;
  v_new text;
  r record;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p WHERE p.proname = 'auto_create_deposits_from_gmail_impl' AND p.pronamespace = 'public'::regnamespace;
  IF v_def IS NULL THEN RAISE EXCEPTION 'auto_create_deposits_from_gmail_impl not found. Nothing was changed.'; END IF;

  v_new := v_def;
  FOR r IN SELECT * FROM (VALUES
    ('  v_only_gmail_id uuid;' || E'\n' || 'begin',
     '  v_only_gmail_id uuid;' || E'\n' || '  v_desk_agent  uuid;' || E'\n' || 'begin'),
    ('    if v_user_id is null' || E'\n' || '       and v_tx.channel = ''mtn_momo''',
     '    -- A number finance registered to a merchant desk always belongs to that desk, even if it is also on another profile.' || E'\n' ||
     '    v_desk_agent := null;' || E'\n' ||
     '    select m.agent_id into v_desk_agent' || E'\n' ||
     '      from public.merchant_desk_phone_numbers m' || E'\n' ||
     '     where m.phone9 in (right(regexp_replace(coalesce(v_tx.counterparty, ''''), ''[^0-9]'', '''', ''g''), 9),' || E'\n' ||
     '                        right(regexp_replace(coalesce(v_phone_match, ''''), ''[^0-9]'', '''', ''g''), 9))' || E'\n' ||
     '     limit 1;' || E'\n' ||
     '    if v_desk_agent is not null then v_user_id := v_desk_agent; end if;' || E'\n' || E'\n' ||
     '    if v_user_id is null' || E'\n' || '       and v_tx.channel = ''mtn_momo''')
  ) AS t(old_text, new_text) LOOP
    IF (length(v_new) - length(replace(v_new, r.old_text, ''))) / length(r.old_text) <> 1 THEN
      RAISE EXCEPTION 'The live auto_create_deposits_from_gmail_impl is not the expected one (a patch point is missing or repeated). Nothing was changed.';
    END IF;
    v_new := replace(v_new, r.old_text, r.new_text);
  END LOOP;

  EXECUTE v_new;
END
$migration$;

INSERT INTO public.merchant_desk_phone_numbers (agent_id, phone9, label)
VALUES ('1a88b1b8-6601-477b-b119-8e18d5dc9ebd', '741003567', 'Immaculate Namulindwa - second Airtel number'),
       ('1a88b1b8-6601-477b-b119-8e18d5dc9ebd', '752383262', 'Immaculate Namulindwa - Airtel number')
ON CONFLICT (phone9) DO UPDATE SET agent_id = excluded.agent_id, label = excluded.label;
