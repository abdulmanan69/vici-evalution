CREATE TYPE "public"."transfer_kind" AS ENUM('transfer', 'callback_sale', 'inbound_sale');--> statement-breakpoint
ALTER TABLE "transfers" ALTER COLUMN "fronter_call_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "transfers" ADD COLUMN "kind" "transfer_kind" DEFAULT 'transfer' NOT NULL;--> statement-breakpoint
ALTER TABLE "transfers" ADD COLUMN "sale_call_id" uuid;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_sale_call_id_calls_id_fk" FOREIGN KEY ("sale_call_id") REFERENCES "public"."calls"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "transfers_sale_only_uq" ON "transfers" USING btree ("closer_call_id") WHERE "transfers"."kind" <> 'transfer';--> statement-breakpoint
CREATE UNIQUE INDEX "transfers_sale_call_uq" ON "transfers" USING btree ("sale_call_id") WHERE "transfers"."sale_call_id" is not null;--> statement-breakpoint
CREATE INDEX "transfers_lead_idx" ON "transfers" USING btree ("dialer_server_id","vici_lead_id");