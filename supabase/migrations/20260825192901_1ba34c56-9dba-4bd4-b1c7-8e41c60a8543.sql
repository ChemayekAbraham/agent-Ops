INSERT INTO public.short_links (code, user_id, target_path, target_params)
VALUES (
  'wjoin',
  '2c6569ce-f236-464f-91b8-e04a9a0c05a6',
  '/join',
  '{"r":"2c6569ce-f236-464f-91b8-e04a9a0c05a6"}'::jsonb
)
ON CONFLICT (code) DO NOTHING;