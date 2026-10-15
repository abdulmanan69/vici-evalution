ALTER TABLE "qa_assignments" ADD COLUMN "task_date" date;--> statement-breakpoint
ALTER TABLE "qa_assignments" ADD COLUMN "queue" "queue_status";--> statement-breakpoint
ALTER TABLE "qa_assignments" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "qa_assignments_company_date_idx" ON "qa_assignments" USING btree ("company_id","task_date");