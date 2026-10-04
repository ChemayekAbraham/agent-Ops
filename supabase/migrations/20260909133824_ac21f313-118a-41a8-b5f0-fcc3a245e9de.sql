DROP POLICY IF EXISTS "Users can update their own NFC cards" ON public.nfc_cards;

CREATE POLICY "Users can revoke their own NFC cards"
ON public.nfc_cards
FOR UPDATE
TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (
  auth.uid() = user_id
  AND status = 'revoked'
  AND pinless_limit IS NOT DISTINCT FROM (SELECT c.pinless_limit FROM public.nfc_cards c WHERE c.id = nfc_cards.id)
  AND pin_hash IS NOT DISTINCT FROM (SELECT c.pin_hash FROM public.nfc_cards c WHERE c.id = nfc_cards.id)
  AND card_id IS NOT DISTINCT FROM (SELECT c.card_id FROM public.nfc_cards c WHERE c.id = nfc_cards.id)
);