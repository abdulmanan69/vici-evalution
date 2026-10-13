CREATE TYPE "public"."agent_role" AS ENUM('fronter', 'closer', 'blended', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."assignment_status" AS ENUM('open', 'in_progress', 'done', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."call_source" AS ENUM('vicidial_log', 'vicidial_closer_log', 'manual');--> statement-breakpoint
CREATE TYPE "public"."dispo_meaning" AS ENUM('transfer', 'sale', 'no_sale', 'callback', 'dnc', 'other');--> statement-breakpoint
CREATE TYPE "public"."evaluation_status" AS ENUM('draft', 'completed');--> statement-breakpoint
CREATE TYPE "public"."form_state" AS ENUM('draft', 'published', 'archived');--> statement-breakpoint
CREATE TYPE "public"."form_target" AS ENUM('fronter', 'closer', 'any');--> statement-breakpoint
CREATE TYPE "public"."match_status" AS ENUM('pending_match', 'matched', 'flagged', 'unmatched');--> statement-breakpoint
CREATE TYPE "public"."queue_status" AS ENUM('transfer', 'unclosed', 'closed');--> statement-breakpoint
CREATE TYPE "public"."recording_status" AS ENUM('pending', 'available', 'missing', 'error');--> statement-breakpoint
CREATE TYPE "public"."dialer_source_mode" AS ENUM('api', 'db', 'hybrid');--> statement-breakpoint
CREATE TYPE "public"."sync_job_status" AS ENUM('queued', 'running', 'success', 'failed');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('active', 'disabled');--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid,
	"user_id" uuid,
	"action" varchar(100) NOT NULL,
	"entity_type" varchar(50),
	"entity_id" text,
	"before" jsonb,
	"after" jsonb,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"dialer_server_id" uuid NOT NULL,
	"source" "call_source" NOT NULL,
	"vici_lead_id" bigint,
	"vici_uniqueid" varchar(32),
	"campaign_id" uuid,
	"ingroup_id" uuid,
	"vici_agent_id" uuid,
	"vici_user_raw" varchar(50),
	"phone_number" varchar(24),
	"call_date" timestamp with time zone NOT NULL,
	"length_sec" integer,
	"status" varchar(20),
	"term_reason" varchar(30),
	"list_id" bigint,
	"raw" jsonb,
	"is_mock" boolean DEFAULT false NOT NULL,
	"first_synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"dialer_server_id" uuid NOT NULL,
	"vici_campaign_id" varchar(50) NOT NULL,
	"name" text,
	"active" boolean DEFAULT true NOT NULL,
	"raw" jsonb,
	"synced_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" varchar(64) NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "companies_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "dialer_servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"base_url" text NOT NULL,
	"api_user_enc" text,
	"api_pass_enc" text,
	"source_mode" "dialer_source_mode" DEFAULT 'api' NOT NULL,
	"db_host" text,
	"db_port" integer,
	"db_name" text,
	"db_user_enc" text,
	"db_pass_enc" text,
	"recording_base_url" text,
	"recording_auth_user_enc" text,
	"recording_auth_pass_enc" text,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "disposition_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"dialer_server_id" uuid,
	"campaign_id" uuid,
	"disposition_code" varchar(50) NOT NULL,
	"meaning" "dispo_meaning" NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evaluations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"transfer_id" uuid,
	"call_id" uuid,
	"form_version_id" uuid NOT NULL,
	"target_agent_id" uuid,
	"reviewer_id" uuid NOT NULL,
	"status" "evaluation_status" DEFAULT 'draft' NOT NULL,
	"answers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"score" numeric(8, 2),
	"max_score" numeric(8, 2),
	"percent" numeric(5, 2),
	"passed" boolean,
	"auto_failed" boolean DEFAULT false NOT NULL,
	"comments" text,
	"coaching_notes" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ingroups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"dialer_server_id" uuid NOT NULL,
	"vici_group_id" varchar(50) NOT NULL,
	"name" text,
	"raw" jsonb,
	"synced_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "qa_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"transfer_id" uuid NOT NULL,
	"assigned_to" uuid NOT NULL,
	"assigned_by" uuid,
	"due_at" timestamp with time zone,
	"status" "assignment_status" DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "qa_form_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"form_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"schema" jsonb NOT NULL,
	"max_score" numeric(8, 2) NOT NULL,
	"pass_threshold" numeric(5, 2) DEFAULT '80' NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "qa_forms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"target" "form_target" DEFAULT 'any' NOT NULL,
	"campaign_id" uuid,
	"state" "form_state" DEFAULT 'draft' NOT NULL,
	"current_version" integer DEFAULT 0 NOT NULL,
	"draft_schema" jsonb,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recordings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"dialer_server_id" uuid NOT NULL,
	"call_id" uuid,
	"vici_recording_id" bigint,
	"vici_lead_id" bigint,
	"filename" text NOT NULL,
	"location_url" text,
	"start_time" timestamp with time zone,
	"length_sec" integer,
	"status" "recording_status" DEFAULT 'pending' NOT NULL,
	"check_attempts" integer DEFAULT 0 NOT NULL,
	"last_checked_at" timestamp with time zone,
	"raw" jsonb,
	"is_mock" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid,
	"name" varchar(64) NOT NULL,
	"description" text,
	"permissions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "sync_cursors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dialer_server_id" uuid NOT NULL,
	"stream" varchar(50) NOT NULL,
	"last_timestamp" timestamp with time zone,
	"last_id" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dialer_server_id" uuid NOT NULL,
	"job_type" varchar(50) NOT NULL,
	"status" "sync_job_status" DEFAULT 'queued' NOT NULL,
	"window_start" timestamp with time zone,
	"window_end" timestamp with time zone,
	"stats" jsonb,
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transfer_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transfer_id" uuid NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"reason" text,
	"actor_user_id" uuid,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"dialer_server_id" uuid NOT NULL,
	"fronter_call_id" uuid NOT NULL,
	"closer_call_id" uuid,
	"xfer_time" timestamp with time zone NOT NULL,
	"phone_number" varchar(24),
	"vici_lead_id" bigint,
	"closer_lead_id" bigint,
	"match_status" "match_status" DEFAULT 'pending_match' NOT NULL,
	"match_confidence" integer,
	"match_method" text,
	"match_notes" text,
	"queue_status" "queue_status" DEFAULT 'transfer' NOT NULL,
	"sale_disposition" varchar(20),
	"closed_at" timestamp with time zone,
	"is_mock" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid,
	"role_id" uuid NOT NULL,
	"email" varchar(255) NOT NULL,
	"password_hash" text NOT NULL,
	"name" text NOT NULL,
	"status" "user_status" DEFAULT 'active' NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "vici_agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"dialer_server_id" uuid NOT NULL,
	"vici_user" varchar(50) NOT NULL,
	"full_name" text,
	"user_group" varchar(50),
	"agent_role" "agent_role" DEFAULT 'unknown' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"raw" jsonb,
	"synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_dialer_server_id_dialer_servers_id_fk" FOREIGN KEY ("dialer_server_id") REFERENCES "public"."dialer_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_ingroup_id_ingroups_id_fk" FOREIGN KEY ("ingroup_id") REFERENCES "public"."ingroups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_vici_agent_id_vici_agents_id_fk" FOREIGN KEY ("vici_agent_id") REFERENCES "public"."vici_agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_dialer_server_id_dialer_servers_id_fk" FOREIGN KEY ("dialer_server_id") REFERENCES "public"."dialer_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dialer_servers" ADD CONSTRAINT "dialer_servers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disposition_mappings" ADD CONSTRAINT "disposition_mappings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disposition_mappings" ADD CONSTRAINT "disposition_mappings_dialer_server_id_dialer_servers_id_fk" FOREIGN KEY ("dialer_server_id") REFERENCES "public"."dialer_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disposition_mappings" ADD CONSTRAINT "disposition_mappings_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disposition_mappings" ADD CONSTRAINT "disposition_mappings_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluations" ADD CONSTRAINT "evaluations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluations" ADD CONSTRAINT "evaluations_transfer_id_transfers_id_fk" FOREIGN KEY ("transfer_id") REFERENCES "public"."transfers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluations" ADD CONSTRAINT "evaluations_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluations" ADD CONSTRAINT "evaluations_form_version_id_qa_form_versions_id_fk" FOREIGN KEY ("form_version_id") REFERENCES "public"."qa_form_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluations" ADD CONSTRAINT "evaluations_target_agent_id_vici_agents_id_fk" FOREIGN KEY ("target_agent_id") REFERENCES "public"."vici_agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluations" ADD CONSTRAINT "evaluations_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingroups" ADD CONSTRAINT "ingroups_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingroups" ADD CONSTRAINT "ingroups_dialer_server_id_dialer_servers_id_fk" FOREIGN KEY ("dialer_server_id") REFERENCES "public"."dialer_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_assignments" ADD CONSTRAINT "qa_assignments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_assignments" ADD CONSTRAINT "qa_assignments_transfer_id_transfers_id_fk" FOREIGN KEY ("transfer_id") REFERENCES "public"."transfers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_assignments" ADD CONSTRAINT "qa_assignments_assigned_to_users_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_assignments" ADD CONSTRAINT "qa_assignments_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_form_versions" ADD CONSTRAINT "qa_form_versions_form_id_qa_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "public"."qa_forms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_form_versions" ADD CONSTRAINT "qa_form_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_forms" ADD CONSTRAINT "qa_forms_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_forms" ADD CONSTRAINT "qa_forms_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_forms" ADD CONSTRAINT "qa_forms_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recordings" ADD CONSTRAINT "recordings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recordings" ADD CONSTRAINT "recordings_dialer_server_id_dialer_servers_id_fk" FOREIGN KEY ("dialer_server_id") REFERENCES "public"."dialer_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recordings" ADD CONSTRAINT "recordings_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_cursors" ADD CONSTRAINT "sync_cursors_dialer_server_id_dialer_servers_id_fk" FOREIGN KEY ("dialer_server_id") REFERENCES "public"."dialer_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_jobs" ADD CONSTRAINT "sync_jobs_dialer_server_id_dialer_servers_id_fk" FOREIGN KEY ("dialer_server_id") REFERENCES "public"."dialer_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_events" ADD CONSTRAINT "transfer_events_transfer_id_transfers_id_fk" FOREIGN KEY ("transfer_id") REFERENCES "public"."transfers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_events" ADD CONSTRAINT "transfer_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_dialer_server_id_dialer_servers_id_fk" FOREIGN KEY ("dialer_server_id") REFERENCES "public"."dialer_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_fronter_call_id_calls_id_fk" FOREIGN KEY ("fronter_call_id") REFERENCES "public"."calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_closer_call_id_calls_id_fk" FOREIGN KEY ("closer_call_id") REFERENCES "public"."calls"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vici_agents" ADD CONSTRAINT "vici_agents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vici_agents" ADD CONSTRAINT "vici_agents_dialer_server_id_dialer_servers_id_fk" FOREIGN KEY ("dialer_server_id") REFERENCES "public"."dialer_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_company_time_idx" ON "audit_logs" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_entity_idx" ON "audit_logs" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "calls_dialer_source_uid_uq" ON "calls" USING btree ("dialer_server_id","source","vici_uniqueid") WHERE "calls"."vici_uniqueid" is not null;--> statement-breakpoint
CREATE INDEX "calls_company_date_idx" ON "calls" USING btree ("company_id","call_date");--> statement-breakpoint
CREATE INDEX "calls_dialer_date_idx" ON "calls" USING btree ("dialer_server_id","call_date");--> statement-breakpoint
CREATE INDEX "calls_phone_idx" ON "calls" USING btree ("phone_number");--> statement-breakpoint
CREATE INDEX "calls_lead_idx" ON "calls" USING btree ("dialer_server_id","vici_lead_id");--> statement-breakpoint
CREATE INDEX "calls_status_idx" ON "calls" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "campaigns_dialer_cid_uq" ON "campaigns" USING btree ("dialer_server_id","vici_campaign_id");--> statement-breakpoint
CREATE UNIQUE INDEX "dialers_company_name_uq" ON "dialer_servers" USING btree ("company_id","name");--> statement-breakpoint
CREATE INDEX "dispo_company_idx" ON "disposition_mappings" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "dispo_lookup_idx" ON "disposition_mappings" USING btree ("company_id","disposition_code","active");--> statement-breakpoint
CREATE INDEX "evaluations_company_idx" ON "evaluations" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "evaluations_transfer_idx" ON "evaluations" USING btree ("transfer_id");--> statement-breakpoint
CREATE INDEX "evaluations_agent_idx" ON "evaluations" USING btree ("target_agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ingroups_dialer_gid_uq" ON "ingroups" USING btree ("dialer_server_id","vici_group_id");--> statement-breakpoint
CREATE UNIQUE INDEX "qa_assignments_transfer_user_uq" ON "qa_assignments" USING btree ("transfer_id","assigned_to");--> statement-breakpoint
CREATE INDEX "qa_assignments_assignee_idx" ON "qa_assignments" USING btree ("assigned_to","status");--> statement-breakpoint
CREATE UNIQUE INDEX "qa_form_versions_uq" ON "qa_form_versions" USING btree ("form_id","version");--> statement-breakpoint
CREATE INDEX "qa_forms_company_idx" ON "qa_forms" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "recordings_dialer_recid_uq" ON "recordings" USING btree ("dialer_server_id","vici_recording_id") WHERE "recordings"."vici_recording_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "recordings_dialer_filename_uq" ON "recordings" USING btree ("dialer_server_id","filename");--> statement-breakpoint
CREATE INDEX "recordings_call_idx" ON "recordings" USING btree ("call_id");--> statement-breakpoint
CREATE INDEX "recordings_company_time_idx" ON "recordings" USING btree ("company_id","start_time");--> statement-breakpoint
CREATE INDEX "recordings_lead_idx" ON "recordings" USING btree ("dialer_server_id","vici_lead_id");--> statement-breakpoint
CREATE UNIQUE INDEX "roles_company_name_uq" ON "roles" USING btree ("company_id","name");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sync_cursors_uq" ON "sync_cursors" USING btree ("dialer_server_id","stream");--> statement-breakpoint
CREATE INDEX "sync_jobs_dialer_idx" ON "sync_jobs" USING btree ("dialer_server_id","created_at");--> statement-breakpoint
CREATE INDEX "transfer_events_transfer_idx" ON "transfer_events" USING btree ("transfer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "transfers_fronter_call_uq" ON "transfers" USING btree ("fronter_call_id");--> statement-breakpoint
CREATE INDEX "transfers_company_queue_idx" ON "transfers" USING btree ("company_id","queue_status","xfer_time");--> statement-breakpoint
CREATE INDEX "transfers_match_idx" ON "transfers" USING btree ("match_status");--> statement-breakpoint
CREATE INDEX "transfers_closer_call_idx" ON "transfers" USING btree ("closer_call_id");--> statement-breakpoint
CREATE INDEX "users_company_idx" ON "users" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vici_agents_dialer_user_uq" ON "vici_agents" USING btree ("dialer_server_id","vici_user");--> statement-breakpoint
CREATE INDEX "vici_agents_company_idx" ON "vici_agents" USING btree ("company_id");