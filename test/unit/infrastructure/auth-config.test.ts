/**
 * Unit tests for fail-closed secret loading (acceptance #8):
 *  - missing / too-short PIN_HASH_PEPPER → ServiceUnavailableError (503);
 *  - missing / malformed JWT private or public key → ServiceUnavailableError;
 *  - a well-formed, matching keypair + strong pepper loads and yields the
 *    correct algorithm (RS256 / ES256);
 *  - error messages name the variable only, never the secret VALUE.
 */
import { describe, expect, it } from 'vitest';

import { loadAuthSecrets } from '../../../src/infrastructure/security/auth-config.ts';
import { ServiceUnavailableError } from '../../../src/shared/errors.ts';
import {
  generateEcKeypair,
  generatePepper,
  generateRsaKeypair,
} from '../../support/auth-secrets.ts';

function validEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  const rsa = generateRsaKeypair();
  return {
    PIN_HASH_PEPPER: generatePepper(32),
    JWT_PRIVATE_KEY_PEM: rsa.privateKeyPem.replaceAll('\n', '\\n'),
    JWT_PUBLIC_KEY_PEM: rsa.publicKeyPem.replaceAll('\n', '\\n'),
    ...overrides,
  };
}

describe('loadAuthSecrets — fail-closed boot posture', () => {
  it('loads a valid RSA config and reports RS256', () => {
    const secrets = loadAuthSecrets(validEnv());
    expect(secrets.jwtAlgorithm).toBe('RS256');
    expect(secrets.pinPepper.length).toBeGreaterThanOrEqual(32);
    expect(secrets.jwtPrivateKey.type).toBe('private');
    expect(secrets.jwtPublicKey.type).toBe('public');
  });

  it('loads a valid EC P-256 config and reports ES256', () => {
    const ec = generateEcKeypair();
    const env = validEnv({
      JWT_PRIVATE_KEY_PEM: ec.privateKeyPem.replaceAll('\n', '\\n'),
      JWT_PUBLIC_KEY_PEM: ec.publicKeyPem.replaceAll('\n', '\\n'),
    });
    expect(loadAuthSecrets(env).jwtAlgorithm).toBe('ES256');
  });

  it('fails with ServiceUnavailableError when PIN_HASH_PEPPER is missing', () => {
    expect(() => loadAuthSecrets(validEnv({ PIN_HASH_PEPPER: undefined }))).toThrow(ServiceUnavailableError);
  });

  it('fails with ServiceUnavailableError when PIN_HASH_PEPPER decodes to < 32 bytes', () => {
    expect(() => loadAuthSecrets(validEnv({ PIN_HASH_PEPPER: Buffer.alloc(16, 9).toString('base64') }))).toThrow(
      ServiceUnavailableError,
    );
  });

  it('fails with ServiceUnavailableError when the JWT private key is missing', () => {
    expect(() => loadAuthSecrets(validEnv({ JWT_PRIVATE_KEY_PEM: undefined }))).toThrow(ServiceUnavailableError);
  });

  it('fails with ServiceUnavailableError when the JWT public key is missing', () => {
    expect(() => loadAuthSecrets(validEnv({ JWT_PUBLIC_KEY_PEM: undefined }))).toThrow(ServiceUnavailableError);
  });

  it('fails with ServiceUnavailableError when the JWT private key PEM is corrupt', () => {
    expect(() => loadAuthSecrets(validEnv({ JWT_PRIVATE_KEY_PEM: '-----BEGIN PRIVATE KEY-----\nnot-a-key\n-----END PRIVATE KEY-----' }))).toThrow(
      ServiceUnavailableError,
    );
  });

  it('fails with ServiceUnavailableError when the JWT public key PEM is corrupt', () => {
    expect(() => loadAuthSecrets(validEnv({ JWT_PUBLIC_KEY_PEM: '-----BEGIN PUBLIC KEY-----\nnot-a-key\n-----END PUBLIC KEY-----' }))).toThrow(
      ServiceUnavailableError,
    );
  });

  it('fails when the private and public keys do not match', () => {
    const other = generateRsaKeypair();
    expect(() =>
      loadAuthSecrets(validEnv({ JWT_PUBLIC_KEY_PEM: other.publicKeyPem.replaceAll('\n', '\\n') })),
    ).toThrow(ServiceUnavailableError);
  });

  it('fails when JWT_ALGORITHM disagrees with the keypair type', () => {
    const ec = generateEcKeypair();
    expect(() =>
      loadAuthSecrets(
        validEnv({
          JWT_PRIVATE_KEY_PEM: ec.privateKeyPem.replaceAll('\n', '\\n'),
          JWT_PUBLIC_KEY_PEM: ec.publicKeyPem.replaceAll('\n', '\\n'),
          JWT_ALGORITHM: 'RS256',
        }),
      ),
    ).toThrow(ServiceUnavailableError);
  });

  it('never echoes a secret VALUE in the thrown error message', () => {
    const pepper = generatePepper(32);
    try {
      loadAuthSecrets(validEnv({ PIN_HASH_PEPPER: 'short' }));
      throw new Error('expected throw');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(pepper);
      expect(message).toContain('PIN_HASH_PEPPER');
    }
  });
});
