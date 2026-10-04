ALTER TABLE public.promissory_notes
  ADD COLUMN IF NOT EXISTS follow_up_status text NOT NULL DEFAULT 'not_started',
  ADD COLUMN IF NOT EXISTS last_followed_up_on date,
  ADD COLUMN IF NOT EXISTS follow_up_note text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.promissory_notes'::regclass
      AND conname = 'promissory_notes_follow_up_status_check'
  ) THEN
    ALTER TABLE public.promissory_notes
      ADD CONSTRAINT promissory_notes_follow_up_status_check
      CHECK (follow_up_status IN ('not_started','in_progress','awaiting_payment','unreachable','done'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_promissory_notes_follow_up
  ON public.promissory_notes (agent_id, follow_up_status, last_followed_up_on DESC);