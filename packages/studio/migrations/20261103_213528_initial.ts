import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  // Payload generates every statement inside the studio schema but not the schema itself.
  await db.execute(sql`CREATE SCHEMA IF NOT EXISTS "studio";`)
  await db.execute(sql`
   CREATE TYPE "studio"."enum_users_role" AS ENUM('member', 'author', 'publisher', 'steward', 'pi');
  CREATE TYPE "studio"."enum_agents_models_by_class_up_to" AS ENUM('D0', 'D1', 'D2', 'D3', 'R');
  CREATE TYPE "studio"."enum_agents_evals_expect_t" AS ENUM('contains', 'rubric');
  CREATE TYPE "studio"."enum_agents_instructions_class" AS ENUM('D0', 'D1', 'D2', 'D3', 'R');
  CREATE TYPE "studio"."enum_agents_audience_t" AS ENUM('lab', 'study-team', 'pi-only', 'members');
  CREATE TYPE "studio"."enum_agents_sandbox_mount_ceiling" AS ENUM('D0', 'D1', 'D2', 'D3', 'R');
  CREATE TYPE "studio"."enum_agents_kind" AS ENUM('interactive', 'background');
  CREATE TYPE "studio"."enum_agents_ceiling" AS ENUM('D0', 'D1', 'D2', 'D3', 'R');
  CREATE TYPE "studio"."enum__agents_v_version_models_by_class_up_to" AS ENUM('D0', 'D1', 'D2', 'D3', 'R');
  CREATE TYPE "studio"."enum__agents_v_version_evals_expect_t" AS ENUM('contains', 'rubric');
  CREATE TYPE "studio"."enum__agents_v_version_instructions_class" AS ENUM('D0', 'D1', 'D2', 'D3', 'R');
  CREATE TYPE "studio"."enum__agents_v_version_audience_t" AS ENUM('lab', 'study-team', 'pi-only', 'members');
  CREATE TYPE "studio"."enum__agents_v_version_sandbox_mount_ceiling" AS ENUM('D0', 'D1', 'D2', 'D3', 'R');
  CREATE TYPE "studio"."enum__agents_v_version_kind" AS ENUM('interactive', 'background');
  CREATE TYPE "studio"."enum__agents_v_version_ceiling" AS ENUM('D0', 'D1', 'D2', 'D3', 'R');
  CREATE TYPE "studio"."enum_knowledge_bases_sources_kind" AS ENUM('file', 'url');
  CREATE TYPE "studio"."enum_knowledge_bases_sources_cls" AS ENUM('D0', 'D1', 'D2', 'D3', 'R');
  CREATE TYPE "studio"."enum_knowledge_bases_sources_licence" AS ENUM('open', 'internal-only', 'copyrighted');
  CREATE TYPE "studio"."enum_knowledge_bases_definition_class" AS ENUM('D0', 'D1', 'D2', 'D3', 'R');
  CREATE TYPE "studio"."enum__knowledge_bases_v_version_sources_kind" AS ENUM('file', 'url');
  CREATE TYPE "studio"."enum__knowledge_bases_v_version_sources_cls" AS ENUM('D0', 'D1', 'D2', 'D3', 'R');
  CREATE TYPE "studio"."enum__knowledge_bases_v_version_sources_licence" AS ENUM('open', 'internal-only', 'copyrighted');
  CREATE TYPE "studio"."enum__knowledge_bases_v_version_definition_class" AS ENUM('D0', 'D1', 'D2', 'D3', 'R');
  CREATE TABLE "studio"."users_sessions" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"created_at" timestamp(3) with time zone,
  	"expires_at" timestamp(3) with time zone NOT NULL
  );
  
  CREATE TABLE "studio"."users" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"role" "studio"."enum_users_role" DEFAULT 'member' NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"email" varchar NOT NULL,
  	"reset_password_token" varchar,
  	"reset_password_expiration" timestamp(3) with time zone,
  	"salt" varchar,
  	"hash" varchar,
  	"reset_password_requested_at" timestamp(3) with time zone,
  	"login_attempts" numeric DEFAULT 0,
  	"lock_until" timestamp(3) with time zone
  );
  
  CREATE TABLE "studio"."agents_models_by_class" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"up_to" "studio"."enum_agents_models_by_class_up_to",
  	"model_endpoint_id" varchar,
  	"model_model_id" varchar,
  	"model_params_temperature" numeric DEFAULT 0,
  	"model_params_max_output_tokens" numeric DEFAULT 1024,
  	"model_params_seed" numeric,
  	"model_params_top_p" numeric
  );
  
  CREATE TABLE "studio"."agents_tools" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"name" varchar
  );
  
  CREATE TABLE "studio"."agents_evals" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"question" varchar,
  	"expect_t" "studio"."enum_agents_evals_expect_t",
  	"expect_text" varchar,
  	"expect_rubric" varchar
  );
  
  CREATE TABLE "studio"."agents" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"agent_id" varchar NOT NULL,
  	"name" varchar NOT NULL,
  	"description" varchar NOT NULL,
  	"owner" varchar NOT NULL,
  	"instructions" varchar NOT NULL,
  	"instructions_class" "studio"."enum_agents_instructions_class" DEFAULT 'D1',
  	"model_endpoint_id" varchar NOT NULL,
  	"model_model_id" varchar NOT NULL,
  	"model_params_temperature" numeric DEFAULT 0,
  	"model_params_max_output_tokens" numeric DEFAULT 1024,
  	"model_params_seed" numeric,
  	"model_params_top_p" numeric,
  	"read_cap_tokens" numeric,
  	"audience_t" "studio"."enum_agents_audience_t" DEFAULT 'lab',
  	"audience_study_id" varchar,
  	"auto_respond" boolean DEFAULT false,
  	"routable" boolean DEFAULT true,
  	"sandbox_enabled" boolean DEFAULT false,
  	"sandbox_mount_ceiling" "studio"."enum_agents_sandbox_mount_ceiling",
  	"kind" "studio"."enum_agents_kind" DEFAULT 'interactive',
  	"limits_max_steps" numeric,
  	"limits_max_tokens" numeric,
  	"limits_max_wall_ms" numeric,
  	"schedule_cron" varchar,
  	"schedule_prompt" varchar,
  	"ceiling" "studio"."enum_agents_ceiling" NOT NULL,
  	"provenance_policy_numbers_must_trace" boolean DEFAULT false,
  	"provenance_policy_claims_link_evidence" boolean DEFAULT false,
  	"irb_protocol" varchar,
  	"consent_purpose" varchar,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "studio"."agents_texts" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer NOT NULL,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"text" varchar
  );
  
  CREATE TABLE "studio"."_agents_v_version_models_by_class" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" serial PRIMARY KEY NOT NULL,
  	"up_to" "studio"."enum__agents_v_version_models_by_class_up_to",
  	"model_endpoint_id" varchar,
  	"model_model_id" varchar,
  	"model_params_temperature" numeric DEFAULT 0,
  	"model_params_max_output_tokens" numeric DEFAULT 1024,
  	"model_params_seed" numeric,
  	"model_params_top_p" numeric,
  	"_uuid" varchar
  );
  
  CREATE TABLE "studio"."_agents_v_version_tools" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" serial PRIMARY KEY NOT NULL,
  	"name" varchar,
  	"_uuid" varchar
  );
  
  CREATE TABLE "studio"."_agents_v_version_evals" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" serial PRIMARY KEY NOT NULL,
  	"question" varchar,
  	"expect_t" "studio"."enum__agents_v_version_evals_expect_t",
  	"expect_text" varchar,
  	"expect_rubric" varchar,
  	"_uuid" varchar
  );
  
  CREATE TABLE "studio"."_agents_v" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"parent_id" integer,
  	"version_agent_id" varchar NOT NULL,
  	"version_name" varchar NOT NULL,
  	"version_description" varchar NOT NULL,
  	"version_owner" varchar NOT NULL,
  	"version_instructions" varchar NOT NULL,
  	"version_instructions_class" "studio"."enum__agents_v_version_instructions_class" DEFAULT 'D1',
  	"version_model_endpoint_id" varchar NOT NULL,
  	"version_model_model_id" varchar NOT NULL,
  	"version_model_params_temperature" numeric DEFAULT 0,
  	"version_model_params_max_output_tokens" numeric DEFAULT 1024,
  	"version_model_params_seed" numeric,
  	"version_model_params_top_p" numeric,
  	"version_read_cap_tokens" numeric,
  	"version_audience_t" "studio"."enum__agents_v_version_audience_t" DEFAULT 'lab',
  	"version_audience_study_id" varchar,
  	"version_auto_respond" boolean DEFAULT false,
  	"version_routable" boolean DEFAULT true,
  	"version_sandbox_enabled" boolean DEFAULT false,
  	"version_sandbox_mount_ceiling" "studio"."enum__agents_v_version_sandbox_mount_ceiling",
  	"version_kind" "studio"."enum__agents_v_version_kind" DEFAULT 'interactive',
  	"version_limits_max_steps" numeric,
  	"version_limits_max_tokens" numeric,
  	"version_limits_max_wall_ms" numeric,
  	"version_schedule_cron" varchar,
  	"version_schedule_prompt" varchar,
  	"version_ceiling" "studio"."enum__agents_v_version_ceiling" NOT NULL,
  	"version_provenance_policy_numbers_must_trace" boolean DEFAULT false,
  	"version_provenance_policy_claims_link_evidence" boolean DEFAULT false,
  	"version_irb_protocol" varchar,
  	"version_consent_purpose" varchar,
  	"version_updated_at" timestamp(3) with time zone,
  	"version_created_at" timestamp(3) with time zone,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "studio"."_agents_v_texts" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer NOT NULL,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"text" varchar
  );
  
  CREATE TABLE "studio"."knowledge_bases_sources" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"source_id" varchar,
  	"kind" "studio"."enum_knowledge_bases_sources_kind",
  	"location" varchar,
  	"cls" "studio"."enum_knowledge_bases_sources_cls",
  	"licence" "studio"."enum_knowledge_bases_sources_licence"
  );
  
  CREATE TABLE "studio"."knowledge_bases" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"kb_id" varchar NOT NULL,
  	"title" varchar NOT NULL,
  	"purpose" varchar NOT NULL,
  	"compiler_endpoint_id" varchar NOT NULL,
  	"compiler_model_id" varchar NOT NULL,
  	"compiler_params_temperature" numeric DEFAULT 0,
  	"compiler_params_max_output_tokens" numeric DEFAULT 8192,
  	"compiler_params_seed" numeric,
  	"irb_protocol" varchar,
  	"consent_scope" varchar,
  	"definition_class" "studio"."enum_knowledge_bases_definition_class",
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "studio"."knowledge_bases_texts" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer NOT NULL,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"text" varchar
  );
  
  CREATE TABLE "studio"."_knowledge_bases_v_version_sources" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" serial PRIMARY KEY NOT NULL,
  	"source_id" varchar,
  	"kind" "studio"."enum__knowledge_bases_v_version_sources_kind",
  	"location" varchar,
  	"cls" "studio"."enum__knowledge_bases_v_version_sources_cls",
  	"licence" "studio"."enum__knowledge_bases_v_version_sources_licence",
  	"_uuid" varchar
  );
  
  CREATE TABLE "studio"."_knowledge_bases_v" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"parent_id" integer,
  	"version_kb_id" varchar NOT NULL,
  	"version_title" varchar NOT NULL,
  	"version_purpose" varchar NOT NULL,
  	"version_compiler_endpoint_id" varchar NOT NULL,
  	"version_compiler_model_id" varchar NOT NULL,
  	"version_compiler_params_temperature" numeric DEFAULT 0,
  	"version_compiler_params_max_output_tokens" numeric DEFAULT 8192,
  	"version_compiler_params_seed" numeric,
  	"version_irb_protocol" varchar,
  	"version_consent_scope" varchar,
  	"version_definition_class" "studio"."enum__knowledge_bases_v_version_definition_class",
  	"version_updated_at" timestamp(3) with time zone,
  	"version_created_at" timestamp(3) with time zone,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "studio"."_knowledge_bases_v_texts" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer NOT NULL,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"text" varchar
  );
  
  CREATE TABLE "studio"."payload_kv" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"key" varchar NOT NULL,
  	"data" jsonb NOT NULL
  );
  
  CREATE TABLE "studio"."payload_locked_documents" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"global_slug" varchar,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "studio"."payload_locked_documents_rels" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"users_id" integer
  );
  
  CREATE TABLE "studio"."payload_preferences" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"key" varchar,
  	"value" jsonb,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "studio"."payload_preferences_rels" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"users_id" integer
  );
  
  CREATE TABLE "studio"."payload_migrations" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"name" varchar,
  	"batch" numeric,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  ALTER TABLE "studio"."users_sessions" ADD CONSTRAINT "users_sessions_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "studio"."users"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "studio"."agents_models_by_class" ADD CONSTRAINT "agents_models_by_class_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "studio"."agents"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "studio"."agents_tools" ADD CONSTRAINT "agents_tools_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "studio"."agents"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "studio"."agents_evals" ADD CONSTRAINT "agents_evals_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "studio"."agents"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "studio"."agents_texts" ADD CONSTRAINT "agents_texts_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "studio"."agents"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "studio"."_agents_v_version_models_by_class" ADD CONSTRAINT "_agents_v_version_models_by_class_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "studio"."_agents_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "studio"."_agents_v_version_tools" ADD CONSTRAINT "_agents_v_version_tools_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "studio"."_agents_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "studio"."_agents_v_version_evals" ADD CONSTRAINT "_agents_v_version_evals_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "studio"."_agents_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "studio"."_agents_v" ADD CONSTRAINT "_agents_v_parent_id_agents_id_fk" FOREIGN KEY ("parent_id") REFERENCES "studio"."agents"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "studio"."_agents_v_texts" ADD CONSTRAINT "_agents_v_texts_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "studio"."_agents_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "studio"."knowledge_bases_sources" ADD CONSTRAINT "knowledge_bases_sources_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "studio"."knowledge_bases"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "studio"."knowledge_bases_texts" ADD CONSTRAINT "knowledge_bases_texts_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "studio"."knowledge_bases"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "studio"."_knowledge_bases_v_version_sources" ADD CONSTRAINT "_knowledge_bases_v_version_sources_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "studio"."_knowledge_bases_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "studio"."_knowledge_bases_v" ADD CONSTRAINT "_knowledge_bases_v_parent_id_knowledge_bases_id_fk" FOREIGN KEY ("parent_id") REFERENCES "studio"."knowledge_bases"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "studio"."_knowledge_bases_v_texts" ADD CONSTRAINT "_knowledge_bases_v_texts_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "studio"."_knowledge_bases_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "studio"."payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "studio"."payload_locked_documents"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "studio"."payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_users_fk" FOREIGN KEY ("users_id") REFERENCES "studio"."users"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "studio"."payload_preferences_rels" ADD CONSTRAINT "payload_preferences_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "studio"."payload_preferences"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "studio"."payload_preferences_rels" ADD CONSTRAINT "payload_preferences_rels_users_fk" FOREIGN KEY ("users_id") REFERENCES "studio"."users"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "users_sessions_order_idx" ON "studio"."users_sessions" USING btree ("_order");
  CREATE INDEX "users_sessions_parent_id_idx" ON "studio"."users_sessions" USING btree ("_parent_id");
  CREATE INDEX "users_updated_at_idx" ON "studio"."users" USING btree ("updated_at");
  CREATE INDEX "users_created_at_idx" ON "studio"."users" USING btree ("created_at");
  CREATE UNIQUE INDEX "users_email_idx" ON "studio"."users" USING btree ("email");
  CREATE INDEX "agents_models_by_class_order_idx" ON "studio"."agents_models_by_class" USING btree ("_order");
  CREATE INDEX "agents_models_by_class_parent_id_idx" ON "studio"."agents_models_by_class" USING btree ("_parent_id");
  CREATE INDEX "agents_tools_order_idx" ON "studio"."agents_tools" USING btree ("_order");
  CREATE INDEX "agents_tools_parent_id_idx" ON "studio"."agents_tools" USING btree ("_parent_id");
  CREATE INDEX "agents_evals_order_idx" ON "studio"."agents_evals" USING btree ("_order");
  CREATE INDEX "agents_evals_parent_id_idx" ON "studio"."agents_evals" USING btree ("_parent_id");
  CREATE UNIQUE INDEX "agents_agent_id_idx" ON "studio"."agents" USING btree ("agent_id");
  CREATE INDEX "agents_updated_at_idx" ON "studio"."agents" USING btree ("updated_at");
  CREATE INDEX "agents_created_at_idx" ON "studio"."agents" USING btree ("created_at");
  CREATE INDEX "agents_texts_order_parent" ON "studio"."agents_texts" USING btree ("order","parent_id");
  CREATE INDEX "_agents_v_version_models_by_class_order_idx" ON "studio"."_agents_v_version_models_by_class" USING btree ("_order");
  CREATE INDEX "_agents_v_version_models_by_class_parent_id_idx" ON "studio"."_agents_v_version_models_by_class" USING btree ("_parent_id");
  CREATE INDEX "_agents_v_version_tools_order_idx" ON "studio"."_agents_v_version_tools" USING btree ("_order");
  CREATE INDEX "_agents_v_version_tools_parent_id_idx" ON "studio"."_agents_v_version_tools" USING btree ("_parent_id");
  CREATE INDEX "_agents_v_version_evals_order_idx" ON "studio"."_agents_v_version_evals" USING btree ("_order");
  CREATE INDEX "_agents_v_version_evals_parent_id_idx" ON "studio"."_agents_v_version_evals" USING btree ("_parent_id");
  CREATE INDEX "_agents_v_parent_idx" ON "studio"."_agents_v" USING btree ("parent_id");
  CREATE INDEX "_agents_v_version_version_agent_id_idx" ON "studio"."_agents_v" USING btree ("version_agent_id");
  CREATE INDEX "_agents_v_version_version_updated_at_idx" ON "studio"."_agents_v" USING btree ("version_updated_at");
  CREATE INDEX "_agents_v_version_version_created_at_idx" ON "studio"."_agents_v" USING btree ("version_created_at");
  CREATE INDEX "_agents_v_created_at_idx" ON "studio"."_agents_v" USING btree ("created_at");
  CREATE INDEX "_agents_v_updated_at_idx" ON "studio"."_agents_v" USING btree ("updated_at");
  CREATE INDEX "_agents_v_texts_order_parent" ON "studio"."_agents_v_texts" USING btree ("order","parent_id");
  CREATE INDEX "knowledge_bases_sources_order_idx" ON "studio"."knowledge_bases_sources" USING btree ("_order");
  CREATE INDEX "knowledge_bases_sources_parent_id_idx" ON "studio"."knowledge_bases_sources" USING btree ("_parent_id");
  CREATE UNIQUE INDEX "knowledge_bases_kb_id_idx" ON "studio"."knowledge_bases" USING btree ("kb_id");
  CREATE INDEX "knowledge_bases_updated_at_idx" ON "studio"."knowledge_bases" USING btree ("updated_at");
  CREATE INDEX "knowledge_bases_created_at_idx" ON "studio"."knowledge_bases" USING btree ("created_at");
  CREATE INDEX "knowledge_bases_texts_order_parent" ON "studio"."knowledge_bases_texts" USING btree ("order","parent_id");
  CREATE INDEX "_knowledge_bases_v_version_sources_order_idx" ON "studio"."_knowledge_bases_v_version_sources" USING btree ("_order");
  CREATE INDEX "_knowledge_bases_v_version_sources_parent_id_idx" ON "studio"."_knowledge_bases_v_version_sources" USING btree ("_parent_id");
  CREATE INDEX "_knowledge_bases_v_parent_idx" ON "studio"."_knowledge_bases_v" USING btree ("parent_id");
  CREATE INDEX "_knowledge_bases_v_version_version_kb_id_idx" ON "studio"."_knowledge_bases_v" USING btree ("version_kb_id");
  CREATE INDEX "_knowledge_bases_v_version_version_updated_at_idx" ON "studio"."_knowledge_bases_v" USING btree ("version_updated_at");
  CREATE INDEX "_knowledge_bases_v_version_version_created_at_idx" ON "studio"."_knowledge_bases_v" USING btree ("version_created_at");
  CREATE INDEX "_knowledge_bases_v_created_at_idx" ON "studio"."_knowledge_bases_v" USING btree ("created_at");
  CREATE INDEX "_knowledge_bases_v_updated_at_idx" ON "studio"."_knowledge_bases_v" USING btree ("updated_at");
  CREATE INDEX "_knowledge_bases_v_texts_order_parent" ON "studio"."_knowledge_bases_v_texts" USING btree ("order","parent_id");
  CREATE UNIQUE INDEX "payload_kv_key_idx" ON "studio"."payload_kv" USING btree ("key");
  CREATE INDEX "payload_locked_documents_global_slug_idx" ON "studio"."payload_locked_documents" USING btree ("global_slug");
  CREATE INDEX "payload_locked_documents_updated_at_idx" ON "studio"."payload_locked_documents" USING btree ("updated_at");
  CREATE INDEX "payload_locked_documents_created_at_idx" ON "studio"."payload_locked_documents" USING btree ("created_at");
  CREATE INDEX "payload_locked_documents_rels_order_idx" ON "studio"."payload_locked_documents_rels" USING btree ("order");
  CREATE INDEX "payload_locked_documents_rels_parent_idx" ON "studio"."payload_locked_documents_rels" USING btree ("parent_id");
  CREATE INDEX "payload_locked_documents_rels_path_idx" ON "studio"."payload_locked_documents_rels" USING btree ("path");
  CREATE INDEX "payload_locked_documents_rels_users_id_idx" ON "studio"."payload_locked_documents_rels" USING btree ("users_id");
  CREATE INDEX "payload_preferences_key_idx" ON "studio"."payload_preferences" USING btree ("key");
  CREATE INDEX "payload_preferences_updated_at_idx" ON "studio"."payload_preferences" USING btree ("updated_at");
  CREATE INDEX "payload_preferences_created_at_idx" ON "studio"."payload_preferences" USING btree ("created_at");
  CREATE INDEX "payload_preferences_rels_order_idx" ON "studio"."payload_preferences_rels" USING btree ("order");
  CREATE INDEX "payload_preferences_rels_parent_idx" ON "studio"."payload_preferences_rels" USING btree ("parent_id");
  CREATE INDEX "payload_preferences_rels_path_idx" ON "studio"."payload_preferences_rels" USING btree ("path");
  CREATE INDEX "payload_preferences_rels_users_id_idx" ON "studio"."payload_preferences_rels" USING btree ("users_id");
  CREATE INDEX "payload_migrations_updated_at_idx" ON "studio"."payload_migrations" USING btree ("updated_at");
  CREATE INDEX "payload_migrations_created_at_idx" ON "studio"."payload_migrations" USING btree ("created_at");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   DROP TABLE "studio"."users_sessions" CASCADE;
  DROP TABLE "studio"."users" CASCADE;
  DROP TABLE "studio"."agents_models_by_class" CASCADE;
  DROP TABLE "studio"."agents_tools" CASCADE;
  DROP TABLE "studio"."agents_evals" CASCADE;
  DROP TABLE "studio"."agents" CASCADE;
  DROP TABLE "studio"."agents_texts" CASCADE;
  DROP TABLE "studio"."_agents_v_version_models_by_class" CASCADE;
  DROP TABLE "studio"."_agents_v_version_tools" CASCADE;
  DROP TABLE "studio"."_agents_v_version_evals" CASCADE;
  DROP TABLE "studio"."_agents_v" CASCADE;
  DROP TABLE "studio"."_agents_v_texts" CASCADE;
  DROP TABLE "studio"."knowledge_bases_sources" CASCADE;
  DROP TABLE "studio"."knowledge_bases" CASCADE;
  DROP TABLE "studio"."knowledge_bases_texts" CASCADE;
  DROP TABLE "studio"."_knowledge_bases_v_version_sources" CASCADE;
  DROP TABLE "studio"."_knowledge_bases_v" CASCADE;
  DROP TABLE "studio"."_knowledge_bases_v_texts" CASCADE;
  DROP TABLE "studio"."payload_kv" CASCADE;
  DROP TABLE "studio"."payload_locked_documents" CASCADE;
  DROP TABLE "studio"."payload_locked_documents_rels" CASCADE;
  DROP TABLE "studio"."payload_preferences" CASCADE;
  DROP TABLE "studio"."payload_preferences_rels" CASCADE;
  DROP TABLE "studio"."payload_migrations" CASCADE;
  DROP TYPE "studio"."enum_users_role";
  DROP TYPE "studio"."enum_agents_models_by_class_up_to";
  DROP TYPE "studio"."enum_agents_evals_expect_t";
  DROP TYPE "studio"."enum_agents_instructions_class";
  DROP TYPE "studio"."enum_agents_audience_t";
  DROP TYPE "studio"."enum_agents_sandbox_mount_ceiling";
  DROP TYPE "studio"."enum_agents_kind";
  DROP TYPE "studio"."enum_agents_ceiling";
  DROP TYPE "studio"."enum__agents_v_version_models_by_class_up_to";
  DROP TYPE "studio"."enum__agents_v_version_evals_expect_t";
  DROP TYPE "studio"."enum__agents_v_version_instructions_class";
  DROP TYPE "studio"."enum__agents_v_version_audience_t";
  DROP TYPE "studio"."enum__agents_v_version_sandbox_mount_ceiling";
  DROP TYPE "studio"."enum__agents_v_version_kind";
  DROP TYPE "studio"."enum__agents_v_version_ceiling";
  DROP TYPE "studio"."enum_knowledge_bases_sources_kind";
  DROP TYPE "studio"."enum_knowledge_bases_sources_cls";
  DROP TYPE "studio"."enum_knowledge_bases_sources_licence";
  DROP TYPE "studio"."enum_knowledge_bases_definition_class";
  DROP TYPE "studio"."enum__knowledge_bases_v_version_sources_kind";
  DROP TYPE "studio"."enum__knowledge_bases_v_version_sources_cls";
  DROP TYPE "studio"."enum__knowledge_bases_v_version_sources_licence";
  DROP TYPE "studio"."enum__knowledge_bases_v_version_definition_class";`)
}
