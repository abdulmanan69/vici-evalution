CREATE TABLE "reviewer_agent_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"reviewer_user_id" uuid NOT NULL,
	"vici_agent_id" uuid NOT NULL,
	"methods" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "reviewer_agent_assignments" ADD CONSTRAINT "reviewer_agent_assignments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviewer_agent_assignments" ADD CONSTRAINT "reviewer_agent_assignments_reviewer_user_id_users_id_fk" FOREIGN KEY ("reviewer_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviewer_agent_assignments" ADD CONSTRAINT "reviewer_agent_assignments_vici_agent_id_vici_agents_id_fk" FOREIGN KEY ("vici_agent_id") REFERENCES "public"."vici_agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviewer_agent_assignments" ADD CONSTRAINT "reviewer_agent_assignments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reviewer_agent_uq" ON "reviewer_agent_assignments" USING btree ("reviewer_user_id","vici_agent_id");--> statement-breakpoint
CREATE INDEX "reviewer_agent_reviewer_idx" ON "reviewer_agent_assignments" USING btree ("reviewer_user_id");