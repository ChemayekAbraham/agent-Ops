WITH t AS (SELECT id FROM public.budget_calls WHERE title LIKE 'ZZ AUDIT TEST CYCLE%'),
     s AS (SELECT id FROM public.budget_submissions WHERE call_id IN (SELECT id FROM t))
DELETE FROM public.budget_submission_documents WHERE submission_id IN (SELECT id FROM s);

WITH t AS (SELECT id FROM public.budget_calls WHERE title LIKE 'ZZ AUDIT TEST CYCLE%'),
     s AS (SELECT id FROM public.budget_submissions WHERE call_id IN (SELECT id FROM t))
DELETE FROM public.budget_submission_lines WHERE submission_id IN (SELECT id FROM s);

WITH t AS (SELECT id FROM public.budget_calls WHERE title LIKE 'ZZ AUDIT TEST CYCLE%'),
     s AS (SELECT id FROM public.budget_submissions WHERE call_id IN (SELECT id FROM t))
DELETE FROM public.budget_submission_events WHERE submission_id IN (SELECT id FROM s);

DELETE FROM public.budget_submissions
 WHERE call_id IN (SELECT id FROM public.budget_calls WHERE title LIKE 'ZZ AUDIT TEST CYCLE%');

DELETE FROM public.budget_calls WHERE title LIKE 'ZZ AUDIT TEST CYCLE%';