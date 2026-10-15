CREATE TABLE "agent_dispositions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"dialer_server_id" uuid NOT NULL,
	"agent_log_id" bigint NOT NULL,
	"vici_user" varchar(50),
	"event_time" timestamp with time zone NOT NULL,
	"status" varchar(20),
	"vici_lead_id" bigint,
	"vici_uniqueid" varchar(32),
	"vici_campaign_id" varchar(50),
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "transfers" ADD COLUMN "agent_log_id" bigint;--> statement-breakpoint
ALTER TABLE "transfers" ADD COLUMN "counted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_dispositions" ADD CONSTRAINT "agent_dispositions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_dispositions" ADD CONSTRAINT "agent_dispositions_dialer_server_id_dialer_servers_id_fk" FOREIGN KEY ("dialer_server_id") REFERENCES "public"."dialer_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_dispositions_dialer_log_uq" ON "agent_dispositions" USING btree ("dialer_server_id","agent_log_id");--> statement-breakpoint
CREATE INDEX "agent_dispositions_time_idx" ON "agent_dispositions" USING btree ("dialer_server_id","event_time");--> statement-breakpoint
CREATE UNIQUE INDEX "transfers_agent_log_uq" ON "transfers" USING btree ("dialer_server_id","agent_log_id") WHERE "transfers"."agent_log_id" is not null;