-- Keep reconciliation WRITE-DISABLED until CFO approves the pivot swap (approved gate 1 & 8).
SELECT cron.alter_job(41, active := false);