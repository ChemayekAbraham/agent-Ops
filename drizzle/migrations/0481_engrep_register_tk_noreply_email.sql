update public.engrep_engineers
   set git_emails = array_append(git_emails, '148437140+kalyangotimothy@users.noreply.github.com')
 where code = 'TK'
   and not ('148437140+kalyangotimothy@users.noreply.github.com' = any(git_emails));