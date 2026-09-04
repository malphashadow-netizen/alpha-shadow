/**
 * ESLint-independent AST scanner for hard-coded role-name comparisons.
 *
 * Why a second implementation next to the ESLint rule?
 *   The governing principle ("no static role-name checks") is a security
 *   invariant, not a style preference. A developer can disable an ESLint rule
 *   inline (`// eslint-disable-next-line`) or drop the plugin from a config
 *   override; this scanner ignores such comments entirely and is wired into CI
 *   as a separate mandatory step. Two independent guards, one invariant.
 *
 * Detection mirrors `eslint-rules/no-role-name-compare.ts` exactly:
 *   1. `<roleLike> (===|!==|==|!=) '<string>'` (either side)
 *   2. `switch (<roleLike>) { case '<string>': … }`
 *   3. `['A','B'].includes(<roleLike>)` and `<roleLike>.includes('<string>')`
 *
 * "roleLike" = an identifier / property access / element access / call /
 * non-null / as / await / parenthesized expression whose terminal identifier
 * name matches /role/i (role, roleName, user.role, getRole(), roles[0], …).
 */
import ts from 'typescript';

export interface Finding {
  readonly file: string;
  /** 1-based line. */
  readonly line: number;
  /** 1-based column. */
  readonly column: number;
  readonly kind: 'comparison' | 'switch' | 'includes';
  readonly code: string;
}

const ROLE_NAME_PATTERN = /role/i;

const COMPARISON_KINDS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);

function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  // Peel syntactic wrappers that do not change what is being compared.
  for (;;) {
    if (ts.isParenthesizedExpression(current)) current = current.expression;
    else if (ts.isNonNullExpression(current)) current = current.expression;
    else if (ts.isAsExpression(current)) current = current.expression;
    else if (ts.isTypeAssertionExpression(current)) current = current.expression;
    else if (ts.isSatisfiesExpression(current)) current = current.expression;
    else if (ts.isAwaitExpression(current)) current = current.expression;
    else return current;
  }
}

function isStringLiteral(node: ts.Expression | undefined): boolean {
  if (!node) return false;
  const inner = unwrap(node);
  return ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner);
}

function isArrayOfStringLiterals(node: ts.Expression): boolean {
  const inner = unwrap(node);
  if (!ts.isArrayLiteralExpression(inner)) return false;
  if (inner.elements.length === 0) return false;
  return inner.elements.every((el) => isStringLiteral(el));
}

function terminalName(node: ts.Expression): string | null {
  const inner = unwrap(node);
  if (ts.isIdentifier(inner)) return inner.text;
  if (ts.isPropertyAccessExpression(inner)) return inner.name.text;
  if (ts.isElementAccessExpression(inner)) return terminalName(inner.expression);
  if (ts.isCallExpression(inner)) return terminalName(inner.expression);
  return null;
}

function isRoleLike(node: ts.Expression | undefined): boolean {
  if (!node) return false;
  const name = terminalName(node);
  return name !== null && ROLE_NAME_PATTERN.test(name);
}

function position(sourceFile: ts.SourceFile, node: ts.Node): { line: number; column: number } {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { line: line + 1, column: character + 1 };
}

/**
 * Scan a single source text. `fileName` is used for diagnostics and to choose
 * the script kind (TS vs TSX).
 */
export function scanSource(fileName: string, sourceText: string): Finding[] {
  const scriptKind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, scriptKind);
  const findings: Finding[] = [];

  const report = (node: ts.Node, kind: Finding['kind']): void => {
    const { line, column } = position(sourceFile, node);
    findings.push({ file: fileName, line, column, kind, code: node.getText(sourceFile) });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && COMPARISON_KINDS.has(node.operatorToken.kind)) {
      const { left, right } = node;
      if ((isStringLiteral(left) && isRoleLike(right)) || (isStringLiteral(right) && isRoleLike(left))) {
        report(node, 'comparison');
      }
    } else if (ts.isSwitchStatement(node) && isRoleLike(node.expression)) {
      const hasStringCase = node.caseBlock.clauses.some(
        (clause) => ts.isCaseClause(clause) && isStringLiteral(clause.expression),
      );
      if (hasStringCase) report(node.expression, 'switch');
    } else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const callee = node.expression;
      const firstArg = node.arguments[0];
      if (callee.name.text === 'includes' && firstArg !== undefined) {
        const receiver = callee.expression;
        if (
          (isArrayOfStringLiterals(receiver) && isRoleLike(firstArg)) ||
          (isRoleLike(receiver) && isStringLiteral(firstArg))
        ) {
          report(node, 'includes');
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return findings;
}

export function formatFinding(f: Finding): string {
  const label = f.kind === 'comparison' ? 'role compared to string literal' : f.kind === 'switch' ? 'switch on role with string cases' : 'role membership test against string literals';
  return `${f.file}:${String(f.line)}:${String(f.column)}  ${label}  →  ${f.code}`;
}
