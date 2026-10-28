-- A dialer imports the whole retention window (7 days) once, resuming after
-- any interruption, before it settles into minute-by-minute syncs. Dialers
-- that already finished a full import count as done.
ALTER TABLE "dialer_servers" ADD COLUMN "backfilled_at" timestamp with time zone;--> statement-breakpoint
UPDATE "dialer_servers" d SET "backfilled_at" = (SELECT max(j."finished_at") FROM "sync_jobs" j WHERE j."dialer_server_id" = d."id" AND j."job_type" = 'full' AND j."status" = 'success');
