-- ECHO TAG: TW-GITEMAIL-ALIAS-2026-09-21-A
-- Append GitHub noreply alias to engineer code 'TW' git_emails array.
-- Idempotent; preserves existing entries; aborts if preconditions fail.

DO $$
DECLARE
  v_alias text := '70208638+TimothyWaniayeChristian@users.noreply.github.com';
  v_tw_id uuid;
  v_other_code text;
BEGIN
  -- Engineer 'TW' must exist.
  SELECT id INTO v_tw_id
  FROM public.engrep_engineers
  WHERE code = 'TW';

  IF v_tw_id IS NULL THEN
    RAISE EXCEPTION 'Engineer code TW does not exist';
  END IF;

  -- Alias must not already be registered to any OTHER engineer.
  SELECT code INTO v_other_code
  FROM public.engrep_engineers
  WHERE code <> 'TW'
    AND v_alias = ANY(git_emails)
  LIMIT 1;

  IF v_other_code IS NOT NULL THEN
    RAISE EXCEPTION 'Alias % is already registered to engineer %', v_alias, v_other_code;
  END IF;

  -- Append alias idempotently to TW, preserving all existing emails.
  UPDATE public.engrep_engineers
  SET git_emails = CASE
    WHEN git_emails IS NULL THEN ARRAY[v_alias]
    WHEN v_alias = ANY(git_emails) THEN git_emails
    ELSE array_append(git_emails, v_alias)
  END
  WHERE code = 'TW';
END $$;