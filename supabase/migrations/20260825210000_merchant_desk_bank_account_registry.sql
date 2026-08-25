-- Merchant desk bank-account registry
--
-- Outbound bank transfers to a merchant desk's own bank account are float
-- DELIVERIES to that desk, exactly like an outbound MoMo send to its
-- registered `float_phone`. Until now there was no bank equivalent of
-- `float_phone`, so those transfers could not be attributed and FinOps
-- closed the gap with manual "set merchant desk float to X" assertions.
-- Those assertions carry no reference_id and, being absolute rather than
-- additive, silently re-credit float the desk has already spent.
--
-- Bank notification emails mask the account, revealing only the FIRST digit
-- and the LAST FOUR, e.g. Equity sends `1********7076` for 1046202587076.
-- Matching therefore keys on (first digit, length, last 4). That is a weak
-- key on its own, so the unique index below guarantees it can never resolve
-- to two active desks — the poller refuses to credit on ambiguity.

ALTER TABLE public.cashout_agents
  ADD COLUMN IF NOT EXISTS bank_account_number text,
  ADD COLUMN IF NOT EXISTS bank_account_name   text,
  ADD COLUMN IF NOT EXISTS bank_name           text,
  ADD COLUMN IF NOT EXISTS bank_account_set_at timestamptz,
  ADD COLUMN IF NOT EXISTS bank_account_set_by uuid REFERENCES public.profiles(id);

COMMENT ON COLUMN public.cashout_agents.bank_account_number IS
  'Full bank account number this desk receives float on. Bank emails mask all '
  'but the first digit and last four, so matching uses those; store the full '
  'number so the match can be validated on length and first digit too.';

-- Digits only, and long enough for a first-digit + last-4 match to mean anything.
ALTER TABLE public.cashout_agents
  DROP CONSTRAINT IF EXISTS cashout_agents_bank_account_number_digits;
ALTER TABLE public.cashout_agents
  ADD CONSTRAINT cashout_agents_bank_account_number_digits
  CHECK (bank_account_number IS NULL OR bank_account_number ~ '^[0-9]{8,20}$');

-- The masked form must be unambiguous across ACTIVE desks, or auto-credit
-- could post to the wrong desk. Partial unique index on the match key.
DROP INDEX IF EXISTS cashout_agents_bank_match_key_uniq;
CREATE UNIQUE INDEX cashout_agents_bank_match_key_uniq
  ON public.cashout_agents (
    left(bank_account_number, 1),
    length(bank_account_number),
    right(bank_account_number, 4)
  )
  WHERE bank_account_number IS NOT NULL AND is_active = true;

CREATE INDEX IF NOT EXISTS cashout_agents_bank_account_tail_idx
  ON public.cashout_agents (right(bank_account_number, 4))
  WHERE bank_account_number IS NOT NULL;

-- Seed: Sky Bubbles (desk BAITA). Equity account 1046202587076 is the
-- destination they receive float on; it links to the desk whose wallet /
-- float_phone is 256762952753, so a detected transfer credits that desk's
-- float bucket.
UPDATE public.cashout_agents
SET bank_account_number = '1046202587076',
    bank_account_name   = 'SKYBUBBLES TRADING AND INVESTMENT LIMITED',
    bank_name           = 'Equity',
    bank_account_set_at = now()
WHERE id = '6078d940-3c87-425b-8b36-f6462bb2e406'
  AND agent_id = '1a88b1b8-6601-477b-b119-8e18d5dc9ebd';

DO $$
DECLARE v_float_phone text;
BEGIN
  SELECT float_phone INTO v_float_phone
  FROM public.cashout_agents
  WHERE id = '6078d940-3c87-425b-8b36-f6462bb2e406';

  IF v_float_phone IS NULL THEN
    RAISE EXCEPTION 'Sky Bubbles desk has no float_phone; record_merchant_float_delivery would reject the credit';
  END IF;

  -- The RPC requires float_phone IS NOT NULL, and the desk was confirmed on
  -- 2026-08-25 as 256762952753. Warn loudly if that ever drifts.
  IF regexp_replace(v_float_phone, '[^0-9]', '', 'g') NOT LIKE '%762952753' THEN
    RAISE WARNING 'Sky Bubbles float_phone is % — expected to end 762952753', v_float_phone;
  END IF;
END $$;
