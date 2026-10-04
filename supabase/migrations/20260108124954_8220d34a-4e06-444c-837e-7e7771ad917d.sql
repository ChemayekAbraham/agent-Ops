-- Drop existing insert policy for conversation_participants
DROP POLICY IF EXISTS "Users can add participants to conversations they're in" ON public.conversation_participants;

-- Create a proper policy that allows:
-- 1. Users to add themselves to any conversation
-- 2. Users to add others to conversations they participate in
CREATE POLICY "Users can add participants to conversations"
ON public.conversation_participants
FOR INSERT
WITH CHECK (
  -- User can add themselves
  user_id = auth.uid()
  OR 
  -- User can add others if they're already a participant
  EXISTS (
    SELECT 1 FROM public.conversation_participants cp
    WHERE cp.conversation_id = conversation_participants.conversation_id
    AND cp.user_id = auth.uid()
  )
);