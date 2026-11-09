-- Puts reject_landlord_payouts back to "hide and message only" (no float return). Return requests already filed stay: the CFO decides them, or
-- reject them in the allocation-return screen, which puts the allocation back to open.
-- To restore the old function body re-run the version from 20261020120000_reject_landlord_payouts_with_message.sql (it has no v_wd loop).
DROP FUNCTION IF EXISTS public._file_allocation_return_for_rejected_payout(uuid, uuid, text);
-- NOTE: dropping the helper makes the current reject_landlord_payouts fail, so re-create the old body immediately after.
