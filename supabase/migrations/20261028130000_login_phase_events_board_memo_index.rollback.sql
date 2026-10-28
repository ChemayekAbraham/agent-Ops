-- Removes the index the Board Technology Report uses. The report still works; it is slower and can pass the 8-second limit again.

DROP INDEX CONCURRENTLY IF EXISTS public.idx_login_phase_events_board_phases;
