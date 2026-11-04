-- Puts auto_create_deposits_from_gmail_impl back to matching by profile phone only, and removes Immaculate's two registered numbers.

DELETE FROM public.merchant_desk_phone_numbers
 WHERE agent_id = '1a88b1b8-6601-477b-b119-8e18d5dc9ebd' AND phone9 IN ('741003567', '752383262');

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
    ('  v_only_gmail_id uuid;' || E'\n' || '  v_desk_agent  uuid;' || E'\n' || 'begin',
     '  v_only_gmail_id uuid;' || E'\n' || 'begin'),
    ('    -- A number finance registered to a merchant desk always belongs to that desk, even if it is also on another profile.' || E'\n' ||
     '    v_desk_agent := null;' || E'\n' ||
     '    select m.agent_id into v_desk_agent' || E'\n' ||
     '      from public.merchant_desk_phone_numbers m' || E'\n' ||
     '     where m.phone9 in (right(regexp_replace(coalesce(v_tx.counterparty, ''''), ''[^0-9]'', '''', ''g''), 9),' || E'\n' ||
     '                        right(regexp_replace(coalesce(v_phone_match, ''''), ''[^0-9]'', '''', ''g''), 9))' || E'\n' ||
     '     limit 1;' || E'\n' ||
     '    if v_desk_agent is not null then v_user_id := v_desk_agent; end if;' || E'\n' || E'\n' ||
     '    if v_user_id is null' || E'\n' || '       and v_tx.channel = ''mtn_momo''',
     '    if v_user_id is null' || E'\n' || '       and v_tx.channel = ''mtn_momo''')
  ) AS t(old_text, new_text) LOOP
    IF (length(v_new) - length(replace(v_new, r.old_text, ''))) / length(r.old_text) <> 1 THEN
      RAISE EXCEPTION 'The live auto_create_deposits_from_gmail_impl is not the patched one. Nothing was changed.';
    END IF;
    v_new := replace(v_new, r.old_text, r.new_text);
  END LOOP;

  EXECUTE v_new;
END
$migration$;
