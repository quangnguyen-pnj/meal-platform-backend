/**
 * DTO-shaped views returned by the organizations endpoints. The service maps
 * Prisma rows to these so responses never leak columns the API has not
 * committed to (and the shape stays stable if the schema grows).
 */
export interface FactoryView {
  id: string;
  organizationId: string;
  code: string;
  name: string;
}

export interface DepartmentView {
  id: string;
  organizationId: string;
  factoryId: string;
  code: string;
  name: string;
}

export interface TeamView {
  id: string;
  organizationId: string;
  factoryId: string;
  departmentId: string;
  code: string;
  name: string;
}

/**
 * The tenant subtree a principal may see, filtered to its granted scope. Used
 * by `GET /scope-tree` so the frontend can render navigation without a second
 * round of per-level requests.
 */
export interface ScopeTreeView {
  organizationId: string;
  factories: Array<
    FactoryView & {
      departments: Array<
        DepartmentView & {
          teams: TeamView[];
        }
      >;
    }
  >;
}
