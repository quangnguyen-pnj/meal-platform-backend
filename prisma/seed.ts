/**
 * Phase 0 seed: fictional PNJP tenant tree, roles, permissions, and people.
 *
 * The seed is idempotent. Every row is upserted on its natural key so the
 * script can be re-run without creating duplicates. Seeded account passwords
 * come from the SEED_PASSWORD environment variable and are hashed with
 * Argon2id; no password is ever hard-coded here.
 *
 * All data is invented. Emails mimic the pnj.com.vn format for realism only;
 * they are written as literal seed values and are never derived from names.
 *
 * Run with: SEED_PASSWORD=... npx tsx prisma/seed.ts
 */
import * as argon2 from 'argon2';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';

const ORG_CODE = 'PNJP';

const PERMISSIONS: ReadonlyArray<{ code: string; description: string }> = [
  { code: 'organization:read', description: 'View organization tree' },
  { code: 'organization:manage', description: 'Create and edit factories, departments, teams' },
  { code: 'employee:read', description: 'View employees in scope' },
  { code: 'employee:manage', description: 'Create and edit employees in scope' },
  { code: 'employee:import', description: 'Upload and apply employee imports' },
  { code: 'role:assign', description: 'Grant and revoke roles in scope' },
  { code: 'audit:read', description: 'View audit logs in scope' },
  { code: 'menu:manage', description: 'Create and publish menus' },
  { code: 'meal-session:manage', description: 'Create and run meal sessions' },
  { code: 'registration:self', description: 'Manage own meal registration' },
  { code: 'registration:bulk', description: 'Enter registrations for others in scope' },
  { code: 'registration:adjust', description: 'Adjust registrations after cutoff' },
  { code: 'reserve:manage', description: 'Configure and allocate reserve pools' },
  { code: 'report:read', description: 'View session summary reports in scope' },
];

const ROLES: ReadonlyArray<{
  code: string;
  name: string;
  permissions: ReadonlyArray<string>;
}> = [
  {
    code: 'OrganizationAdmin',
    name: 'Organization Admin',
    permissions: PERMISSIONS.map((permission) => permission.code),
  },
  {
    code: 'FactoryAdmin',
    name: 'Factory Admin',
    permissions: [
      'organization:read',
      'employee:read',
      'employee:manage',
      'employee:import',
      'role:assign',
      'audit:read',
      'menu:manage',
      'meal-session:manage',
      'registration:bulk',
      'registration:adjust',
      'reserve:manage',
      'report:read',
    ],
  },
  {
    code: 'TeamRepresentative',
    name: 'Team Representative',
    permissions: [
      'organization:read',
      'employee:read',
      'registration:bulk',
      'report:read',
    ],
  },
  {
    code: 'Employee',
    name: 'Employee',
    permissions: ['registration:self'],
  },
];

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required to run the seed.');
  }

  const seedPassword = process.env.SEED_PASSWORD;
  if (!seedPassword) {
    throw new Error(
      'SEED_PASSWORD is required. Set it locally (never commit a secret) before seeding.',
    );
  }

  const passwordHash = await argon2.hash(seedPassword, { type: argon2.argon2id });

  const adapter = new PrismaPg({ connectionString: databaseUrl });
  const prisma = new PrismaClient({ adapter });

  try {
    // --- Organization -------------------------------------------------------
    const organization = await prisma.organization.upsert({
      where: { code: ORG_CODE },
      update: { name: 'PNJP (giả lập)' },
      create: { code: ORG_CODE, name: 'PNJP (giả lập)' },
    });

    // --- Permissions --------------------------------------------------------
    for (const permission of PERMISSIONS) {
      await prisma.permission.upsert({
        where: { code: permission.code },
        update: { description: permission.description },
        create: permission,
      });
    }
    const permissionsByCode = new Map(
      (await prisma.permission.findMany()).map((p) => [p.code, p.id]),
    );

    // --- Roles + role permissions ------------------------------------------
    const roleIdByCode = new Map<string, string>();
    for (const role of ROLES) {
      const created = await prisma.role.upsert({
        where: { organizationId_code: { organizationId: organization.id, code: role.code } },
        update: { name: role.name },
        create: { organizationId: organization.id, code: role.code, name: role.name },
      });
      roleIdByCode.set(role.code, created.id);

      for (const permissionCode of role.permissions) {
        const permissionId = permissionsByCode.get(permissionCode);
        if (!permissionId) {
          throw new Error(`Unknown permission code in role table: ${permissionCode}`);
        }
        await prisma.rolePermission.upsert({
          where: { roleId_permissionId: { roleId: created.id, permissionId } },
          update: {},
          create: { roleId: created.id, permissionId },
        });
      }
    }

    // --- Tenant tree: factory -> departments -> teams ----------------------
    const factory = await prisma.factory.upsert({
      where: { organizationId_code: { organizationId: organization.id, code: 'PNJP-F1' } },
      update: { name: 'Nhà máy PNJP 1' },
      create: { organizationId: organization.id, code: 'PNJP-F1', name: 'Nhà máy PNJP 1' },
    });

    const departmentDefs: ReadonlyArray<{ code: string; name: string }> = [
      { code: 'SAN-XUAT', name: 'San xuat' },
      { code: 'VAN-HANH', name: 'Van hanh' },
      { code: 'BAO-TRI', name: 'Bao tri' },
    ];
    const departmentIdByCode = new Map<string, string>();
    for (const def of departmentDefs) {
      const department = await prisma.department.upsert({
        where: { organizationId_code: { organizationId: organization.id, code: def.code } },
        update: { name: def.name, factoryId: factory.id },
        create: {
          organizationId: organization.id,
          factoryId: factory.id,
          code: def.code,
          name: def.name,
        },
      });
      departmentIdByCode.set(def.code, department.id);
    }

    // Teams Cat, Lap rap, QC live under the San xuat department.
    const productionDepartmentId = departmentIdByCode.get('SAN-XUAT')!;
    const teamDefs: ReadonlyArray<{ code: string; name: string }> = [
      { code: 'CAT', name: 'Cat' },
      { code: 'LAP-RAP', name: 'Lap rap' },
      { code: 'QC', name: 'QC' },
    ];
    const teamIdByCode = new Map<string, string>();
    for (const def of teamDefs) {
      const team = await prisma.team.upsert({
        where: { organizationId_code: { organizationId: organization.id, code: def.code } },
        update: { name: def.name, factoryId: factory.id, departmentId: productionDepartmentId },
        create: {
          organizationId: organization.id,
          factoryId: factory.id,
          departmentId: productionDepartmentId,
          code: def.code,
          name: def.name,
        },
      });
      teamIdByCode.set(def.code, team.id);
    }

    // --- People -------------------------------------------------------------
    // Each person below is a fictional employee. Those who need to log in get a
    // linked UserAccount with the same Argon2id hash of SEED_PASSWORD.
    //
    // All three teams (Cat, Lap rap, QC) live under the San xuat department, so
    // every seeded employee sits in San xuat with a team under it. The employee
    // list in the live API filters by scope, so spreading people across the
    // three teams makes scope visible: the OrganizationAdmin sees all of them,
    // while the TeamRepresentative scoped to team Cat sees only team Cat.
    const cutTeamId = teamIdByCode.get('CAT')!;
    const assemblyTeamId = teamIdByCode.get('LAP-RAP')!;
    const qcTeamId = teamIdByCode.get('QC')!;

    type SeedPerson = {
      employeeCode: string;
      fullName: string;
      email: string;
      hasPersonalDevice: boolean;
      departmentId: string;
      teamId: string;
      account?: { email: string; role: string; scope: ScopeTarget };
    };

    type ScopeTarget =
      | { level: 'organization' }
      | { level: 'factory' }
      | { level: 'department'; departmentId: string }
      | { level: 'team'; departmentId: string; teamId: string };

    const people: ReadonlyArray<SeedPerson> = [
      {
        employeeCode: 'PNJP-0001',
        fullName: 'Tran Thi Lan',
        email: 'lan.tt01@pnj.com.vn',
        hasPersonalDevice: true,
        departmentId: productionDepartmentId,
        teamId: assemblyTeamId,
        account: {
          email: 'lan.tt01@pnj.com.vn',
          role: 'OrganizationAdmin',
          scope: { level: 'organization' },
        },
      },
      {
        employeeCode: 'PNJP-0002',
        fullName: 'Le Van Hung',
        email: 'hung.lv02@pnj.com.vn',
        hasPersonalDevice: true,
        departmentId: productionDepartmentId,
        teamId: assemblyTeamId,
        account: {
          email: 'hung.lv02@pnj.com.vn',
          role: 'FactoryAdmin',
          scope: { level: 'factory' },
        },
      },
      {
        employeeCode: 'PNJP-0003',
        fullName: 'Nguyen Minh Quang',
        email: 'quang.nm03@pnj.com.vn',
        hasPersonalDevice: true,
        departmentId: productionDepartmentId,
        teamId: cutTeamId,
        account: {
          email: 'quang.nm03@pnj.com.vn',
          role: 'TeamRepresentative',
          scope: { level: 'team', departmentId: productionDepartmentId, teamId: cutTeamId },
        },
      },
      {
        employeeCode: 'PNJP-0004',
        fullName: 'Pham Thu Ha',
        email: 'ha.pt04@pnj.com.vn',
        hasPersonalDevice: true,
        departmentId: productionDepartmentId,
        teamId: cutTeamId,
        account: {
          email: 'ha.pt04@pnj.com.vn',
          role: 'Employee',
          // The Employee role is self-scoped: it targets the holder's own team
          // (Cat), matching the self-scope rule the grant API enforces.
          scope: { level: 'team', departmentId: productionDepartmentId, teamId: cutTeamId },
        },
      },
      {
        // Production worker without a personal device and without an account.
        employeeCode: 'PNJP-0005',
        fullName: 'Vo Van Tam',
        email: 'tam.vv05@pnj.com.vn',
        hasPersonalDevice: false,
        departmentId: productionDepartmentId,
        teamId: cutTeamId,
      },
      {
        // A second account-less worker in team Cat, so the team-scoped view has
        // more than the representative alone.
        employeeCode: 'PNJP-0006',
        fullName: 'Dang Thi Mai',
        email: 'mai.dt06@pnj.com.vn',
        hasPersonalDevice: false,
        departmentId: productionDepartmentId,
        teamId: cutTeamId,
      },
      {
        // Team Lap rap member, outside the Cat representative's scope.
        employeeCode: 'PNJP-0007',
        fullName: 'Bui Van Son',
        email: 'son.bv07@pnj.com.vn',
        hasPersonalDevice: true,
        departmentId: productionDepartmentId,
        teamId: assemblyTeamId,
      },
      {
        // Team QC member, outside the Cat representative's scope.
        employeeCode: 'PNJP-0008',
        fullName: 'Do Thi Hoa',
        email: 'hoa.dt08@pnj.com.vn',
        hasPersonalDevice: false,
        departmentId: productionDepartmentId,
        teamId: qcTeamId,
      },
    ];

    for (const person of people) {
      let userAccountId: string | undefined;

      if (person.account) {
        const account = await prisma.userAccount.upsert({
          where: { email: person.account.email },
          update: { passwordHash, isActive: true },
          create: { email: person.account.email, passwordHash, isActive: true },
        });
        userAccountId = account.id;

        const roleId = roleIdByCode.get(person.account.role);
        if (!roleId) {
          throw new Error(`Unknown role for ${person.account.email}: ${person.account.role}`);
        }

        const scope = person.account.scope;
        const grant = {
          userAccountId: account.id,
          roleId,
          organizationId: organization.id,
          factoryId: scope.level === 'organization' ? null : factory.id,
          departmentId:
            scope.level === 'department' || scope.level === 'team'
              ? scope.departmentId
              : null,
          teamId: scope.level === 'team' ? scope.teamId : null,
        };

        // The compound unique on user_role includes nullable scope columns,
        // which Prisma's compound-unique `where` input cannot match on null.
        // Look the grant up explicitly, then create it only if absent, so the
        // seed stays idempotent.
        const existingGrant = await prisma.userRole.findFirst({ where: grant });
        if (!existingGrant) {
          await prisma.userRole.create({ data: grant });
        }
      }

      await prisma.employee.upsert({
        where: {
          organizationId_employeeCode: {
            organizationId: organization.id,
            employeeCode: person.employeeCode,
          },
        },
        update: {
          fullName: person.fullName,
          email: person.email,
          hasPersonalDevice: person.hasPersonalDevice,
          factoryId: factory.id,
          departmentId: person.departmentId,
          teamId: person.teamId,
          userAccountId: userAccountId ?? null,
        },
        create: {
          organizationId: organization.id,
          factoryId: factory.id,
          departmentId: person.departmentId,
          teamId: person.teamId,
          employeeCode: person.employeeCode,
          fullName: person.fullName,
          email: person.email,
          hasPersonalDevice: person.hasPersonalDevice,
          userAccountId: userAccountId ?? null,
        },
      });
    }

    const counts = {
      organizations: await prisma.organization.count(),
      factories: await prisma.factory.count(),
      departments: await prisma.department.count(),
      teams: await prisma.team.count(),
      employees: await prisma.employee.count(),
      userAccounts: await prisma.userAccount.count(),
      roles: await prisma.role.count(),
      permissions: await prisma.permission.count(),
      userRoles: await prisma.userRole.count(),
    };

    console.log('Seed complete. Row counts:');
    console.table(counts);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
