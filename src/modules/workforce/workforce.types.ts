/**
 * DTO-shaped views returned by the workforce endpoints. The service maps
 * Prisma rows to these so responses never leak columns the API has not
 * committed to. In particular, a `UserAccount`'s `passwordHash` is never part
 * of any view.
 */
export interface EmployeeView {
  id: string;
  organizationId: string;
  factoryId: string;
  departmentId: string;
  teamId: string;
  employeeCode: string;
  fullName: string;
  email: string | null;
  hasPersonalDevice: boolean;
  userAccountId: string | null;
}

/**
 * The safe projection of a login account: identity and status only. There is
 * deliberately no password field so a hash can never reach a response.
 */
export interface UserAccountView {
  id: string;
  email: string;
  isActive: boolean;
}

/**
 * A role grant held by an account at one scope level. The null tenant ids
 * describe the level: all null is organization scope, `factoryId` set is
 * factory scope, and so on.
 */
export interface RoleGrantView {
  id: string;
  userAccountId: string;
  roleId: string;
  organizationId: string;
  factoryId: string | null;
  departmentId: string | null;
  teamId: string | null;
}
