-- Connections (docs/CONNECTIONS.md): API keys for the machine API, outbound
-- webhooks with their delivery outbox, and the dispatcher's read cursors.
-- New tables only, plus two indexes the dispatcher reads events in order by.
CREATE TABLE "integration_cursors" (
	"name" varchar(64) PRIMARY KEY NOT NULL,
	"last_at" timestamp with time zone,
	"last_id" text,
	"state" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"webhook_id" uuid NOT NULL,
	"event" varchar(64) NOT NULL,
	"event_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now(),
	"delivered_at" timestamp with time zone,
	"last_status" integer,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid,
	"name" text NOT NULL,
	"key_prefix" varchar(16) NOT NULL,
	"key_hash" varchar(64) NOT NULL,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "integration_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "integration_webhooks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"secret" text NOT NULL,
	"events" text[] DEFAULT '{}'::text[] NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"last_status" integer,
	"last_error" text,
	"last_delivery_at" timestamp with time zone,
	"failing_since" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "integration_deliveries" ADD CONSTRAINT "integration_deliveries_webhook_id_integration_webhooks_id_fk" FOREIGN KEY ("webhook_id") REFERENCES "public"."integration_webhooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_keys" ADD CONSTRAINT "integration_keys_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_keys" ADD CONSTRAINT "integration_keys_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_webhooks" ADD CONSTRAINT "integration_webhooks_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_webhooks" ADD CONSTRAINT "integration_webhooks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "integration_deliveries_webhook_event_uq" ON "integration_deliveries" USING btree ("webhook_id","event_key");--> statement-breakpoint
CREATE INDEX "integration_deliveries_due_idx" ON "integration_deliveries" USING btree ("next_attempt_at") WHERE "integration_deliveries"."next_attempt_at" is not null;--> statement-breakpoint
CREATE INDEX "integration_deliveries_webhook_idx" ON "integration_deliveries" USING btree ("webhook_id","created_at");--> statement-breakpoint
CREATE INDEX "integration_keys_company_idx" ON "integration_keys" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "integration_webhooks_company_idx" ON "integration_webhooks" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "evaluations_completed_idx" ON "evaluations" USING btree ("completed_at","id") WHERE "evaluations"."completed_at" is not null;--> statement-breakpoint
CREATE INDEX "transfer_events_created_idx" ON "transfer_events" USING btree ("created_at","id");