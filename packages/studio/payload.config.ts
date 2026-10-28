import { postgresAdapter } from "@payloadcms/db-postgres";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildConfig } from "payload";
import { Agents } from "./collections/agents.ts";
import { KnowledgeBases } from "./collections/knowledge-bases.ts";
import { Users } from "./collections/users.ts";

const dirname = path.dirname(fileURLToPath(import.meta.url));

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

export default buildConfig({
  admin: {
    user: Users.slug,
    importMap: { baseDir: dirname },
    meta: { titleSuffix: " | Lab studio" },
  },
  collections: [Users, Agents, KnowledgeBases],
  secret: required("PAYLOAD_SECRET"),
  // Payload's tables live in their own schema beside core's; core never reads them.
  db: postgresAdapter({ pool: { connectionString: required("DATABASE_URL") }, schemaName: "studio" }),
  graphQL: { disable: true },
  // With Payload drafts off, every revision is labelled "published". What is live is agent_heads, so call them revisions.
  i18n: { translations: { en: { version: { currentlyPublished: "Revision", previouslyPublished: "Revision" } } } },
  telemetry: false,
  typescript: { autoGenerate: false },
});
