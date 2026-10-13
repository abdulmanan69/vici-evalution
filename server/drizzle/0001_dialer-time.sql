ALTER TABLE "dialer_servers" ADD COLUMN "tz_offset_min" integer;--> statement-breakpoint
ALTER TABLE "dialer_servers" ADD COLUMN "clock_drift_sec" integer;--> statement-breakpoint
ALTER TABLE "dialer_servers" ADD COLUMN "time_checked_at" timestamp with time zone;