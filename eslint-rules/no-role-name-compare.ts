/**
 * Custom ESLint rule: `alpha-shadow/no-role-name-compare`
 *
 * Governing architectural principle (spec, "المبدأ الحاكم"):
 *   Authorization is ALWAYS checked against an atomic permission key such as
 *   `order:void`. Hard-coding role names anywhere in `src/` is forbidden.
 *
 * This rule turns that principle into a build-breaking constraint. It reports:
 *
 *   1. Binary comparisons (`===`, `!==`, `==`, `!=`) where one operand is a
 *      string literal / no-substitution template literal and the other operand
 *      "looks like a role" — i.e. is an identifier or member expression whose
 *      final name matches /role/i (role, roleName, user.role, ctx.roleName,
 *      roles[0], …), or a call expression whose callee name matches /role/i
 *      (getRole(), user.getRoleName()).
 *
 *   2. `switch (role) { case 'ADMIN': … }` — the switch discriminant is a
 *      role-like expression and at least one `case` test is a string literal.
 *
 *   3. `['ADMIN', 'MANAGER'].includes(role)` / `roles.includes('ADMIN')` —
 *      `.includes(...)` where one side is a role-like expression and the other
 *      is a string literal or an array literal containing string literals.
 *
 * This rule is intentionally syntactic (no type information required) so it can
 * run fast on every file in CI and on pre-commit hooks. It is complemented by
 * `tools/check-role-compare.ts`, which uses the TypeScript compiler API to walk
 * the AST independently of ESLint as a second, ESLint-free safety net.
 */
import { AST_NODE_TYPES, ESLintUtils, type TSESTree } from '@typescript-eslint/utils';

const ROLE_NAME_PATTERN = /role/i;
const COMPARISON_OPERATORS: ReadonlySet<string> = new Set(['===', '!==', '==', '!=']);

export const RULE_NAME = 'no-role-name-compare';

export type MessageIds = 'noRoleNameCompare' | 'noRoleNameSwitch' | 'noRoleNameIncludes';

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/malphashadow-netizen/alpha-shadow/blob/main/eslint-rules/${name}.ts`,
);

function isStringLiteral(node: TSESTree.Node | null | undefined): boolean {
  if (!node) return false;
  if (node.type === AST_NODE_TYPES.Literal) return typeof node.value === 'string';
  if (node.type === AST_NODE_TYPES.TemplateLiteral) return node.expressions.length === 0;
  return false;
}

function isArrayOfStringLiterals(node: TSESTree.Node | null | undefined): boolean {
  if (node?.type !== AST_NODE_TYPES.ArrayExpression) return false;
  if (node.elements.length === 0) return false;
  return node.elements.every((el) => el !== null && isStringLiteral(el));
}

/** Returns the trailing identifier name of an expression, if any. */
function terminalName(node: TSESTree.Node): string | null {
  if (node.type === AST_NODE_TYPES.Identifier) return node.name;
  if (node.type === AST_NODE_TYPES.MemberExpression) {
    if (!node.computed && node.property.type === AST_NODE_TYPES.Identifier) {
      return node.property.name;
    }
    // roles[0], roles[i] → fall back to the object's terminal name
    return terminalName(node.object);
  }
  if (node.type === AST_NODE_TYPES.CallExpression) return terminalName(node.callee);
  if (node.type === AST_NODE_TYPES.AwaitExpression) return terminalName(node.argument);
  if (
    node.type === AST_NODE_TYPES.ChainExpression ||
    node.type === AST_NODE_TYPES.TSNonNullExpression ||
    node.type === AST_NODE_TYPES.TSAsExpression ||
    node.type === AST_NODE_TYPES.TSTypeAssertion ||
    node.type === AST_NODE_TYPES.TSSatisfiesExpression
  ) {
    return terminalName(node.expression);
  }
  return null;
}

function isRoleLike(node: TSESTree.Node | null | undefined): boolean {
  if (!node) return false;
  const name = terminalName(node);
  return name !== null && ROLE_NAME_PATTERN.test(name);
}

export const noRoleNameCompare = createRule<[], MessageIds>({
  name: RULE_NAME,
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow comparing role names against string literals. Authorization must be checked via atomic permission keys (e.g. `order:void`), never via hard-coded role names.',
    },
    schema: [],
    messages: {
      noRoleNameCompare:
        'Hard-coded role comparison is forbidden ({{ code }}). Check an atomic permission (e.g. `order:void`) through the RBAC engine instead.',
      noRoleNameSwitch:
        'Switching on a role name with string cases is forbidden. Check an atomic permission through the RBAC engine instead.',
      noRoleNameIncludes:
        'Membership test of a role name against string literals is forbidden ({{ code }}). Check an atomic permission through the RBAC engine instead.',
    },
  },
  defaultOptions: [],
  create(context) {
    const sourceCode = context.sourceCode;

    return {
      BinaryExpression(node): void {
        if (!COMPARISON_OPERATORS.has(node.operator)) return;
        const { left, right } = node;
        const violates =
          (isStringLiteral(left) && isRoleLike(right)) || (isStringLiteral(right) && isRoleLike(left));
        if (!violates) return;
        context.report({
          node,
          messageId: 'noRoleNameCompare',
          data: { code: sourceCode.getText(node) },
        });
      },

      SwitchStatement(node): void {
        if (!isRoleLike(node.discriminant)) return;
        const hasStringCase = node.cases.some((c) => isStringLiteral(c.test));
        if (!hasStringCase) return;
        context.report({ node: node.discriminant, messageId: 'noRoleNameSwitch' });
      },

      CallExpression(node): void {
        const callee = node.callee;
        if (callee.type !== AST_NODE_TYPES.MemberExpression) return;
        if (callee.computed || callee.property.type !== AST_NODE_TYPES.Identifier) return;
        if (callee.property.name !== 'includes') return;
        const [firstArg] = node.arguments;
        if (!firstArg) return;

        const receiver = callee.object;
        const violates =
          // ['ADMIN', 'MANAGER'].includes(role)
          (isArrayOfStringLiterals(receiver) && isRoleLike(firstArg)) ||
          // roles.includes('ADMIN')  /  user.roleNames.includes('ADMIN')
          (isRoleLike(receiver) && isStringLiteral(firstArg));
        if (!violates) return;

        context.report({
          node,
          messageId: 'noRoleNameIncludes',
          data: { code: sourceCode.getText(node) },
        });
      },
    };
  },
});

export default noRoleNameCompare;
