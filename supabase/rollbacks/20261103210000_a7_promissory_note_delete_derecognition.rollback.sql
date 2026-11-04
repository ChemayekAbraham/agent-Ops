-- Rollback of 20261103210000_a7_promissory_note_delete_derecognition: removes the delete trigger and the two functions. The table promissory_note_derecognitions
-- (evidence) and every ledger entry posted stay (append-only). After a rollback, deleting a note no longer reverses A7.
SET lock_timeout = '5s';
DROP TRIGGER derecognise_partner_receivable_on_delete ON public.promissory_notes;
DROP FUNCTION public.trg_derecognise_partner_receivable_on_delete();
DROP FUNCTION public._partner_receivable_derecognise_deleted(uuid, text, text, text);
