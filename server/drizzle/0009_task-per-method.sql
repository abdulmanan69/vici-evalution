-- tasks made before methods existed carry no queue: give them the call's queue
UPDATE "qa_assignments" a SET "queue" = t."queue_status" FROM "transfers" t WHERE t."id" = a."transfer_id" AND a."queue" IS NULL;--> statement-breakpoint
DROP INDEX "qa_assignments_transfer_user_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "qa_assignments_transfer_user_queue_uq" ON "qa_assignments" USING btree ("transfer_id","assigned_to","queue");