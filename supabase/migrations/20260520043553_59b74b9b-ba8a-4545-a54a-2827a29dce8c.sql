-- Restore all soft-deleted auth users using the original email/phone stored in public.profiles
UPDATE auth.users u
SET
  deleted_at = NULL,
  email = p.email,
  phone = CASE WHEN p.phone IS NOT NULL AND length(p.phone) > 0 THEN p.phone ELSE NULL END,
  updated_at = now()
FROM public.profiles p
WHERE p.id = u.id
  AND u.deleted_at IS NOT NULL;

-- Strip the [ARCHIVED] prefix from the display name
UPDATE public.profiles
SET full_name = regexp_replace(full_name, '^\[ARCHIVED\]\s*', ''),
    updated_at = now()
WHERE full_name LIKE '[ARCHIVED]%';
