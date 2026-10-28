CREATE TABLE "dialer_closer_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dialer_server_id" uuid NOT NULL,
	"closer_dialer_server_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "dialer_closer_links" ADD CONSTRAINT "dialer_closer_links_dialer_server_id_dialer_servers_id_fk" FOREIGN KEY ("dialer_server_id") REFERENCES "public"."dialer_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dialer_closer_links" ADD CONSTRAINT "dialer_closer_links_closer_dialer_server_id_dialer_servers_id_fk" FOREIGN KEY ("closer_dialer_server_id") REFERENCES "public"."dialer_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dialer_closer_links" ADD CONSTRAINT "dialer_closer_links_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dialer_closer_links_uq" ON "dialer_closer_links" USING btree ("dialer_server_id","closer_dialer_server_id");