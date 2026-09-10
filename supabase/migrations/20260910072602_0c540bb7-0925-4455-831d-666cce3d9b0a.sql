create unique index if not exists engrep_engineers_code_uq
  on public.engrep_engineers (code);
create unique index if not exists engrep_engineers_staff_uq
  on public.engrep_engineers (staff_id);

insert into public.engrep_engineers (staff_id, code, git_emails, active) values
  ('5ae6976d-b96b-42ba-8c5d-55ec4099e999','BW','{256781260170@welile.user}',true),
  ('66716970-f46a-49e8-890b-6aa40ed31d1d','SP','{pexpert46@gmail.com}',true),
  ('4281a997-8060-498b-b78a-b47dd6e569f9','TK','{timothykalyango@gmail.com}',true),
  ('dc24eab2-b2ac-4d92-ba4a-f38647ec8f94','TW','{tcwaniaye@gmail.com}',true),
  ('acd32c9b-4cba-4d87-9d75-0c72a13aaa81','KJ','{katongolejames22@gmail.com}',true),
  ('baddfb16-bc54-4ec2-b47d-e166cf47b2e2','JW','{joshwanda17@gmail.com}',true),
  ('b948f57d-7ced-499f-b6ba-43aa87333c83','EL','{paphra.me@gmail.com}',true),
  ('63d45e79-be25-4394-a9d7-e3c3a071b682','TC','{256786686225@welile.user}',true),
  ('543e183c-4c75-403e-ab1c-0cc68249167c','AC','{chemayekabraham289@gmail.com}',true),
  ('d4e247ce-6d84-46c8-a119-783de819b2a0','AS','{angwensarahsunday@gmail.com}',true)
on conflict (code) do nothing;