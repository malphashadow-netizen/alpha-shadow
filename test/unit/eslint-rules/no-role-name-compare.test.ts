/**
 * Behavioural tests for the custom ESLint rule `alpha-shadow/no-role-name-compare`.
 *
 * Uses @typescript-eslint/rule-tester wired to Vitest's describe/it/afterAll.
 */
import { RuleTester } from '@typescript-eslint/rule-tester';
import { afterAll, describe, it } from 'vitest';

import { noRoleNameCompare, RULE_NAME } from '../../../eslint-rules/no-role-name-compare.ts';

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester();

ruleTester.run(RULE_NAME, noRoleNameCompare, {
  valid: [
    // Permission-key checks are the sanctioned pattern.
    { code: "hasPermission('order:void');" },
    { code: "if (await authz.can(user, 'order:void')) {}" },
    // Comparing non-role things to strings is fine.
    { code: "status === 'ACTIVE';" },
    { code: "order.state !== 'PAID';" },
    { code: "['a', 'b'].includes(kind);" },
    { code: "switch (status) { case 'OPEN': break; default: break; }" },
    // Comparing role-like values to non-literals is fine (e.g. ids from DB).
    { code: 'role === expectedRole;' },
    { code: 'user.roleId === assignment.roleId;' },
    { code: 'roles.includes(roleIdFromDb);' },
    // Role compared to a template WITH substitutions is not a hard-coded literal.
    { code: 'role === `${prefix}_ADMIN`;' },
    // `.includes` on an empty array is not a role allow-list.
    { code: '[].includes(role);' },
    // Membership test of a non-literal array is fine.
    { code: 'allowedRoles.includes(role);' },
  ],
  invalid: [
    {
      code: "if (role === 'ADMIN') {}",
      errors: [{ messageId: 'noRoleNameCompare' }],
    },
    {
      code: "if ('ADMIN' === role) {}",
      errors: [{ messageId: 'noRoleNameCompare' }],
    },
    {
      code: 'const ok = roleName == "MANAGER";',
      errors: [{ messageId: 'noRoleNameCompare' }],
    },
    {
      code: "const denied = user.role !== 'OWNER';",
      errors: [{ messageId: 'noRoleNameCompare' }],
    },
    {
      code: "if (ctx.actor.roleName != 'CASHIER') {}",
      errors: [{ messageId: 'noRoleNameCompare' }],
    },
    {
      code: "if (roles[0] === 'ADMIN') {}",
      errors: [{ messageId: 'noRoleNameCompare' }],
    },
    {
      code: "if (getRole() === 'ADMIN') {}",
      errors: [{ messageId: 'noRoleNameCompare' }],
    },
    {
      code: "if (user.getRoleName() === 'ADMIN') {}",
      errors: [{ messageId: 'noRoleNameCompare' }],
    },
    {
      code: "if (user?.role === 'ADMIN') {}",
      errors: [{ messageId: 'noRoleNameCompare' }],
    },
    {
      code: "if (role! === 'ADMIN') {}",
      errors: [{ messageId: 'noRoleNameCompare' }],
    },
    {
      code: "if ((role as string) === 'ADMIN') {}",
      errors: [{ messageId: 'noRoleNameCompare' }],
    },
    {
      code: 'if (role === `ADMIN`) {}',
      errors: [{ messageId: 'noRoleNameCompare' }],
    },
    {
      code: "switch (role) { case 'ADMIN': break; default: break; }",
      errors: [{ messageId: 'noRoleNameSwitch' }],
    },
    {
      code: "switch (user.roleName) { case 'ADMIN': case 'MANAGER': break; default: break; }",
      errors: [{ messageId: 'noRoleNameSwitch' }],
    },
    {
      code: "if (['ADMIN', 'MANAGER'].includes(role)) {}",
      errors: [{ messageId: 'noRoleNameIncludes' }],
    },
    {
      code: "if (roles.includes('ADMIN')) {}",
      errors: [{ messageId: 'noRoleNameIncludes' }],
    },
    {
      code: "if (user.roleNames.includes('ADMIN')) {}",
      errors: [{ messageId: 'noRoleNameIncludes' }],
    },
    {
      // Multiple violations in one file are all reported.
      code: "const a = role === 'A'; const b = role === 'B';",
      errors: [{ messageId: 'noRoleNameCompare' }, { messageId: 'noRoleNameCompare' }],
    },
  ],
});
