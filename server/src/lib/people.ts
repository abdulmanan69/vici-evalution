import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { companyMemberships, roles, users } from '../db/schema.js';

/** Someone who works in a company — its own user, or one given access from another company. */
export interface CompanyPerson {
  id: string;
  name: string;
  email: string;
  status: 'active' | 'disabled';
  lastLoginAt: Date | null;
  createdAt: Date;
  /** the person's own company */
  homeCompanyId: string | null;
  /** role and limits in THIS company */
  roleId: string;
  roleName: string;
  permissions: string[];
  allowedFormIds: string[] | null;
  /** true = works here through a membership; their account belongs to another company */
  shared: boolean;
}

const personColumns = {
  id: users.id,
  name: users.name,
  email: users.email,
  status: users.status,
  lastLoginAt: users.lastLoginAt,
  createdAt: users.createdAt,
  homeCompanyId: users.companyId,
  roleId: roles.id,
  roleName: roles.name,
  permissions: roles.permissions,
};

/** Everyone who works in the company: its own users first, then shared people, by name. */
export async function companyPeople(companyId: string): Promise<CompanyPerson[]> {
  const own = await db
    .select({ ...personColumns, allowedFormIds: users.allowedFormIds })
    .from(users)
    .innerJoin(roles, eq(users.roleId, roles.id))
    .where(eq(users.companyId, companyId));
  const shared = await db
    .select({ ...personColumns, allowedFormIds: companyMemberships.allowedFormIds })
    .from(companyMemberships)
    .innerJoin(users, eq(companyMemberships.userId, users.id))
    .innerJoin(roles, eq(companyMemberships.roleId, roles.id))
    .where(eq(companyMemberships.companyId, companyId));
  return [...own.map((p) => ({ ...p, shared: false })), ...shared.map((p) => ({ ...p, shared: true }))].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}

/** The person as they work in this company, or null when they have no access to it. */
export async function personInCompany(userId: string, companyId: string): Promise<CompanyPerson | null> {
  const [own] = await db
    .select({ ...personColumns, allowedFormIds: users.allowedFormIds })
    .from(users)
    .innerJoin(roles, eq(users.roleId, roles.id))
    .where(and(eq(users.id, userId), eq(users.companyId, companyId)));
  if (own) return { ...own, shared: false };
  const [member] = await db
    .select({ ...personColumns, allowedFormIds: companyMemberships.allowedFormIds })
    .from(companyMemberships)
    .innerJoin(users, eq(companyMemberships.userId, users.id))
    .innerJoin(roles, eq(companyMemberships.roleId, roles.id))
    .where(and(eq(companyMemberships.userId, userId), eq(companyMemberships.companyId, companyId)));
  return member ? { ...member, shared: true } : null;
}
