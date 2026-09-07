/**
 * Test-only generation of auth secrets — created AT RUNTIME, never committed
 * plaintext (the zero-plaintext rule applies to tests too: there are no
 * hard-coded passwords, PINs, peppers or keys anywhere in the tree).
 */
import { generateKeyPairSync, randomBytes } from 'node:crypto';

export interface GeneratedKeypair {
  readonly privateKeyPem: string;
  readonly publicKeyPem: string;
}

/** Generates an RSA 2048 keypair in PEM (RS256). */
export function generateRsaKeypair(): GeneratedKeypair {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }) as string,
  };
}

/** Generates an EC P-256 keypair in PEM (ES256). */
export function generateEcKeypair(): GeneratedKeypair {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }) as string,
  };
}

/** A valid pepper: base64 of exactly 32 random bytes. */
export function generatePepper(bytes = 32): string {
  return randomBytes(bytes).toString('base64');
}

/** A random credential value (password or PIN) generated at runtime. */
export function generatePassword(): string {
  return randomBytes(18).toString('base64url');
}

export function generatePin(digits = 4): string {
  // Uniform numeric PIN of the requested length, never a fixed literal.
  let pin = '';
  const bytes = randomBytes(digits);
  for (let i = 0; i < digits; i += 1) {
    pin += String((bytes[i] ?? 0) % 10);
  }
  return pin;
}
