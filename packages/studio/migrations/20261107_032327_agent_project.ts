import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "studio"."agents" ADD COLUMN "project" varchar;
  ALTER TABLE "studio"."_agents_v" ADD COLUMN "version_project" varchar;`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "studio"."agents" DROP COLUMN "project";
  ALTER TABLE "studio"."_agents_v" DROP COLUMN "version_project";`)
}
