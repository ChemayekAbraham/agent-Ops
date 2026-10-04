-- NFC Cards table for funder wallet card setup
CREATE TABLE public.nfc_cards (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  card_id UUID NOT NULL UNIQUE,
  pin_hash TEXT NOT NULL,
  pinless_limit NUMERIC NOT NULL DEFAULT 0 CHECK (pinless_limit >= 0),
  hmac_signature_preview TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_nfc_cards_user_id ON public.nfc_cards(user_id);
CREATE INDEX idx_nfc_cards_card_id ON public.nfc_cards(card_id);

ALTER TABLE public.nfc_cards ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own NFC cards"
  ON public.nfc_cards FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own NFC cards"
  ON public.nfc_cards FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own NFC cards"
  ON public.nfc_cards FOR UPDATE
  USING (auth.uid() = user_id);

CREATE TRIGGER update_nfc_cards_updated_at
  BEFORE UPDATE ON public.nfc_cards
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();