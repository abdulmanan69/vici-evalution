-- Speed: indexes the slow paths were missing (agent scopes and agent/dialer
-- deletes scanned every call; the Transfers queue sorts by kind + time).
-- Delete: dialers being deleted keep their row until the worker has removed
-- their data, and free their name for re-use meanwhile.
DROP INDEX IF EXISTS "dialers_company_name_uq";--> statement-breakpoint
ALTER TABLE "dialer_servers" ADD COLUMN "deleting_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "calls_agent_idx" ON "calls" USING btree ("vici_agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evaluations_call_idx" ON "evaluations" USING btree ("call_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "transfers_company_kind_idx" ON "transfers" USING btree ("company_id","kind","xfer_time");--> statement-breakpoint
CREATE UNIQUE INDEX "dialers_company_name_uq" ON "dialer_servers" USING btree ("company_id","name") WHERE "dialer_servers"."deleting_at" is null;