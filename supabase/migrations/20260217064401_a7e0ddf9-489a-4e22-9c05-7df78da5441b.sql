-- Make temp_password nullable since activated invites clear the password
ALTER TABLE public.supporter_invites ALTER COLUMN temp_password DROP NOT NULL;