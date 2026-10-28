import { mayManageAccounts, ROLES } from "@labh/core/studio";
import { APIError, type Access, type CollectionConfig, type FieldAccess } from "payload";
import { roleOf } from "../core.ts";

/**
 * Studio accounts. A lab member signs in here with no repository access.
 * Roles are core's (roles.ts): core enforces who may publish, and this file
 * only stores the role and keeps people from raising their own. The PI
 * manages accounts. The email is the member id core records on every publish
 * and test (core.ts actorOf), so only the PI changes it.
 */

const LABELS: Record<(typeof ROLES)[number], string> = { member: "Member", author: "Author", publisher: "Publisher", steward: "Data steward", pi: "PI" };

const managesAccounts = (user: unknown) => {
  const role = roleOf(user);
  return role !== null && mayManageAccounts(role);
};
const isManager: Access = ({ req }) => managesAccounts(req.user);
const managerField: FieldAccess = ({ req }) => managesAccounts(req.user);
const selfOrManager: Access = ({ req }) => (managesAccounts(req.user) ? true : req.user ? { id: { equals: req.user.id } } : false);

export const Users: CollectionConfig = {
  slug: "users",
  auth: true,
  admin: { useAsTitle: "email", defaultColumns: ["email", "role"] },
  access: { create: isManager, read: selfOrManager, update: selfOrManager, delete: isManager },
  hooks: {
    // The first account is the PI. Without this, a fresh studio has no one who can grant roles.
    beforeChange: [
      async ({ data, operation, req }) => (operation === "create" && (await req.payload.count({ collection: "users", req })).totalDocs === 0 ? { ...data, role: "pi" } : data),
      ({ data, operation, originalDoc, req }) => {
        if (operation === "update" && data.email !== undefined && data.email !== originalDoc?.email && !managesAccounts(req.user)) throw new APIError("Only the PI changes an email: it is the id your publishes are recorded under.", 403, null, true);
        return data;
      },
    ],
  },
  fields: [
    {
      name: "role",
      type: "select",
      required: true,
      defaultValue: "member",
      options: ROLES.map((r) => ({ value: r, label: LABELS[r] })),
      access: { create: managerField, update: managerField },
      saveToJWT: true,
    },
  ],
};
