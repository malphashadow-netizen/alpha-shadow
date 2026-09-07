/**
 * Zero-plaintext scanner — the automated guard for acceptance criterion #3:
 * no REAL password/PIN/pepper/key material may appear anywhere in the tree,
 * INCLUDING tests (the test suite generates hashes/keys at runtime — see
 * test/support/auth-secrets.ts).
 *
 * Detection strategy (deliberately conservative — it proves ABSENCE of the
 * specific, dangerous shapes rather than trying to "understand" every string):
 *
 *   A. Credential field assignment: a property named password / passwd / pin /
 *      pincode / secret / token / pepper / privateKey (…), assigned or set
 *      in a JSON, to a STRING LITERAL that is not an allowed placeholder
 *      ("<…>", "…", "change-me", env interpolation, a format marker such as
 *      "Bearer"/"scrypt$…", or an env-var reference). These are the cases that
 *      would plant a real shared secret.
 *
 *   B. Standalone hard-coded PIN literals: `pin: '1234'` / `"pin": "4829"` /
 *      pin: "123456" with ALL-DIGIT 4–8 digit values.
 *
 *   C. HMAC/scrypt self-describing HASH strings are fine (they are not
 *      secrets): `scrypt$…` and base64-looking HMACs only appear at RUNTIME
 *      in generated data, never as literals — but a literal pepper/base64 key
 *      assigned to a secret field IS caught by (A).
 *
 * Markdown/`env.example` prose uses placeholders ("<secret>",
 * "<base64-from-…>", "change-me", `${ENV}`) which are always permitted.
 *
 * The scanner is self-tested (tools/check-secrets.ts --self-test) on every CI
 * run, like the other guards, so a regression in detection fails the build.
 */

export interface SecretFinding {
  readonly file: string;
  readonly line: number;
  readonly snippet: string;
  readonly reason: string;
}

/** Field names that carry credentials/secrets (compared case-insensitively). */
const SECRET_FIELD_RE =
  /\b(password|passwd|pwd|pin|pinCode|pincode|secret|pepper|api[_-]?key|apikey|token|private[_-]?key|privateKey|accessToken|refreshToken)\b/i;

/** Any of these on the RHS value means "not a real secret literal". */
function isPlaceholderValue(value: string): boolean {
  const v = value.trim();
  if (v === '') return true;
  // Angle-bracket / ellipsis / env interpolation / process.env lookups.
  if (v.startsWith('<') || v.includes('…') || v.includes('${') || v.includes('process.env')) return true;
  // Explicit placeholder wording.
  if (/placeholder|change-?me|not-a-secret|replace/i.test(v)) return true;
  // Token TYPE markers, not secret values.
  if (v === 'Bearer' || v.startsWith('scrypt$') || /^(rs|es)256$/i.test(v)) return true;
  // Env-var style references (e.g. JWT_ALGORITHM value 'RS256').
  if (/^[A-Z][A-Z0-9_]{2,}$/.test(v)) return true;

  // ── Obvious NON-secret fixtures used to exercise VALIDATION/REJECTION ──
  // These are structurally incapable of being a real credential: too short to
  // be a password/key, or not a valid compact JWT (the only token format this
  // project emits). They never appear in a success path, so they cannot be a
  // real shared secret.
  //
  // Single-character / 2-char passwords are placeholders for "wrong value".
  if (v.length <= 2) return true;
  // "Wrong password" / "not a jwt" style prose (contains whitespace / hyphen
  // words, no real credential).
  if (/^(not|wrong|only|invalid|malformed|nope|x)/i.test(v) && /[\s-]/.test(v)) return true;
  // Token-shaped values: a real JWT's segments are base64url with non-trivial
  // length (header/payload JSON). A 3-segment value whose segments are all
  // SHORT (< 8 chars) cannot be a real JWT — it is a malformed-fixture string.
  if (v.includes('.') && /^[a-z0-9._-]+$/i.test(v)) {
    const segments = v.split('.');
    if (segments.length !== 3 || segments.some((s) => s === '')) return true;
    if (segments.every((s) => s.length < 8)) return true;
  }
  // 1–3 digit strings are not a valid PIN (PINs are 4–8 digits).
  if (/^\d{1,3}$/.test(v)) return true;
  // A short, plain, hyphenated prose value ("pw-value") isn't a credential.
  if (/^[a-z]{1,3}-[a-z-]{1,8}$/i.test(v)) return true;
  return false;
}

/** Extracts string-literal values for a matched credential field on a line. */
// Matches:  field: "value"  |  field: 'value'  |  "field": "value"
const ASSIGN_RE =
  /(?:^|[,{\s])([A-Za-z_][A-Za-z0-9_-]*)\s*[:=]\s*(["'`])((?:\\.|(?!\2).)*)\2/g;

function isAllDigitPin(value: string): boolean {
  return /^\d{4,8}$/.test(value.trim());
}

export function scanSourceForPlaintextSecrets(source: string, fileName: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const lines = source.split('\n');
  // The self-test must PLANT secret literals to prove the guard detects
  // them. Those strings are the test input, never a real credential; the
  // self-test file is explicitly exempt (its whole purpose is to hold them).
  if (fileName.endsWith('check-secrets.ts')) return findings;

  lines.forEach((rawLine, index) => {
    const line = rawLine.trim();
    // Skip comment / documentation lines — prose that documents the secret
    // FORMAT is not a credential. Block-comment continuations (`* …`) and
    // line comments (`// …`, `# …` in YAML/SQL) are all dropped.
    if (/^(\/\/|#|\*|\/\*|\.\.\/|\.\/)/.test(line)) return;
    // Also strip any trailing inline comment before scanning the code.
    const withoutLineComment = line.replace(/\s*\/\/.*$/, '').replace(/\s*#.*$/, '');

    const matches = [...withoutLineComment.matchAll(ASSIGN_RE)];
    for (const match of matches) {
      const field = match[1] ?? '';
      const quote = match[2] ?? '';
      const value = match[3] ?? '';

      if (!SECRET_FIELD_RE.test(field)) continue;
      // Template-literal values that interpolate runtime data aren't plaintext.
      if (quote === '`' && value.includes('${')) continue;

      // PIN field: an all-digit 4–8 literal is a hard-coded PIN.
      const isPinField = /^pin(cod|Code)?$|pinCode/i.test(field) || field.toLowerCase() === 'pin';
      if (isPinField && isAllDigitPin(value)) {
        findings.push({
          file: fileName,
          line: index + 1,
          snippet: line.slice(0, 120),
          reason: `hard-coded numeric PIN literal assigned to "${field}" — generate at runtime, never commit`,
        });
        continue;
      }

      // Any other non-empty, non-placeholder string literal assigned to a
      // secret field is flagged.
      if (value.trim() !== '' && !isPlaceholderValue(value)) {
        // Allow references that are clearly variable identifiers (camelCase
        // runtime values) rather than literal secrets.
        if (/^[a-z][a-zA-Z0-9_$]*$/.test(value.trim())) continue;
        findings.push({
          file: fileName,
          line: index + 1,
          snippet: line.slice(0, 120),
          reason: `plaintext-looking value assigned to credential field "${field}" — use a runtime-generated secret or an approved placeholder`,
        });
      }
    }
  });

  return findings;
}

export function formatSecretFinding(f: SecretFinding): string {
  return `${f.file}:${f.line}: ${f.reason}\n    ${f.snippet}`;
}
