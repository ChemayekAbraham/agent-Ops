-- 2026-10-19 (doc 247, step 24, final): landlords_directory is no longer readable by signed-in users or anon.
-- The four screens that read it (EditHouseListingDialog, BorrowerResidenceGate, BorrowLoanSheet, RentalFinderSheet) now call the checked functions
-- landlord_directory_entry / landlord_directory_browse (published and tested by Josh). Only those owner-rights functions and the service role read the view now.
-- Applied to production 2026-10-19.
revoke all on public.landlords_directory from anon, public;
revoke all on public.landlords_directory from authenticated;
grant select on public.landlords_directory to service_role;
