-- Rollback for 20261031160000_staff_assistant_prompt3_teaching_loop_kb200_and_role_goals.sql
DROP FUNCTION IF EXISTS public.staff_assistant_role_goals_and_measures(integer);
DROP FUNCTION IF EXISTS public.assistant_staff_my_taught_updates();
DROP FUNCTION IF EXISTS public.staff_assistant_teach_from_review_queue(uuid, text, text, text, text, text, text, text, text, text, text[], text[]);
DROP FUNCTION IF EXISTS public.staff_assistant_department_teaching_queue(text, text, integer);
DROP FUNCTION IF EXISTS public.staff_assistant_can_send_web_push(uuid);
DROP TABLE IF EXISTS public.staff_assistant_kb_zero_hits;
