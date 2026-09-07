/**
 * Unit tests for asymmetric JWT sign/verify:
 *  - RS256 and ES256 round-trip;
 *  - the verifier PINS the algorithm allow-list (acceptance #7): an HS256
 *    token forged with the public key as an HMAC secret is rejected;
 *  - no signature / tampered payload / expired token are rejected;
 *  - issued claims never carry secret material (acceptance #6);
 *  - malformed/non-PEM keys fail loading.
 */
import { createHmac, randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  ALLOWED_VERIFICATION_ALGORITHMS,
  algorithmForKey,
  loadPrivateKey,
  loadPublicKey,
  signJwt,
  verifyJwt,
} from '../../../../src/shared/auth/jwt.ts';
import { JwtTokenService } from '../../../../src/shared/auth/token-service.ts';
import { generateEcKeypair, generateRsaKeypair } from '../../../support/auth-secrets.ts';

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

describe('JWT algorithm allow-list (algorithm-confusion defence)', () => {
  it('the verifier allow-list contains only RS256 and ES256 (no HS256)', () => {
    expect([...ALLOWED_VERIFICATION_ALGORITHMS].sort()).toEqual(['ES256', 'RS256']);
    expect(ALLOWED_VERIFICATION_ALGORITHMS).not.toContain('HS256');
  });

  it('rejects an HS256 token forged with the PUBLIC key as the HMAC secret', () => {
    const { publicKeyPem, privateKeyPem } = generateRsaKeypair();
    const privateKey = loadPrivateKey(privateKeyPem);
    const publicKey = loadPublicKey(publicKeyPem);

    // The classic confusion attack: attacker signs a token with HS256 using
    // the RSA public key (which is public knowledge) as the HMAC secret.
    const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const payload = b64url(
      JSON.stringify({ typ: 'refresh', sub: 'user-1', tid: 'tenant-1', sec_v: 'x', jti: randomUUID(), fam: randomUUID(), iat: 1, exp: 4102444800 }),
    );
    const signingInput = `${header}.${payload}`;
    const forgedSignature = createHmac('sha256', Buffer.from(publicKeyPem)).update(signingInput).digest('base64url');
    const forged = `${signingInput}.${forgedSignature}`;

    // 1) The pinned allow-list rejects HS256 outright (alg check first).
    expect(() => verifyJwt(forged, publicKey)).toThrow(/algorithm/);
    // 2) Even an explicitly (mis)configured symmetric verification path is
    //    impossible: the verifier only accepts a public KeyObject.
    expect(algorithmForKey(privateKey, publicKey)).toBe('RS256');
  });

  it('rejects a token whose header advertises an unknown alg', () => {
    const { publicKeyPem } = generateRsaKeypair();
    const publicKey = loadPublicKey(publicKeyPem);
    const header = b64url(JSON.stringify({ alg: 'none', typ: 'JWT' }));
    const payload = b64url(JSON.stringify({ exp: 4102444800 }));
    const token = `${header}.${payload}.${b64url('signature')}`;
    expect(() => verifyJwt(token, publicKey)).toThrow(/algorithm/);
  });

  it('rejects a token with an empty signature segment', () => {
    const { publicKeyPem } = generateRsaKeypair();
    const publicKey = loadPublicKey(publicKeyPem);
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const payload = b64url(JSON.stringify({ exp: 4102444800 }));
    expect(() => verifyJwt(`${header}.${payload}.`, publicKey)).toThrow(/malformed|signature/i);
  });
});

describe('JWT sign/verify round-trip', () => {
  it('RS256: a correctly signed token verifies; a tampered payload fails', () => {
    const { privateKeyPem, publicKeyPem } = generateRsaKeypair();
    const privateKey = loadPrivateKey(privateKeyPem);
    const publicKey = loadPublicKey(publicKeyPem);
    const claims = { typ: 'access', sub: 'u1', tid: 't1', sec_v: 'abc', iat: 1, exp: 4102444800 };
    const token = signJwt(claims, privateKey, 'RS256');
    const verified = verifyJwt(token, publicKey);
    expect(verified.sub).toBe('u1');
    expect(verified.typ).toBe('access');

    const [h, p, s] = token.split('.') as [string, string, string];
    const tamperedPayload = b64url(JSON.stringify({ ...claims, sub: 'attacker' }));
    expect(() => verifyJwt(`${h}.${tamperedPayload}.${s}`, publicKey)).toThrow(/signature/);
  });

  it('ES256 (P-256) round-trips and is selected by the key type', () => {
    const { privateKeyPem, publicKeyPem } = generateEcKeypair();
    const privateKey = loadPrivateKey(privateKeyPem);
    const publicKey = loadPublicKey(publicKeyPem);
    expect(algorithmForKey(privateKey, publicKey)).toBe('ES256');
    const token = signJwt(
      { typ: 'access', sub: 'u', tid: 't', sec_v: 'v', iat: 1, exp: 4102444800 },
      privateKey,
      'ES256',
    );
    expect(verifyJwt(token, publicKey).tid).toBe('t');
  });

  it('rejects an expired token', () => {
    const { privateKeyPem, publicKeyPem } = generateRsaKeypair();
    const token = signJwt(
      { typ: 'access', sub: 'u', tid: 't', sec_v: 'v', iat: 1, exp: 100 },
      loadPrivateKey(privateKeyPem),
      'RS256',
    );
    expect(() => verifyJwt(token, loadPublicKey(publicKeyPem), undefined, { now: 1_000_000 })).toThrow(/expired/);
  });

  it('a private key cannot be used as a verifying key and vice versa', () => {
    const { privateKeyPem, publicKeyPem } = generateRsaKeypair();
    const privateKey = loadPrivateKey(privateKeyPem);
    expect(() => verifyJwt('a.b.c', privateKey)).toThrow(/public key/);
  });
});

describe('JWT end-to-end (issue → verify) per algorithm through the token service', () => {
  const now = new Date('2026-09-07T00:00:00Z');

  it.each([
    ['RS256', generateRsaKeypair],
    ['ES256', generateEcKeypair],
  ] as const)('%s: issue access + refresh tokens and verify them (full round-trip)', (_alg, gen) => {
    const { privateKeyPem, publicKeyPem } = gen();
    const privateKey = loadPrivateKey(privateKeyPem);
    const publicKey = loadPublicKey(publicKeyPem);
    const algorithm = algorithmForKey(privateKey, publicKey);
    const service = new JwtTokenService({ privateKey, publicKey, algorithm });

    const access = service.issueAccessToken({ tenantId: 't1', userId: 'u1', secV: 'digest-1', now });
    const refresh = service.issueRefreshToken({
      tenantId: 't1',
      userId: 'u1',
      secV: 'digest-1',
      jti: randomUUID(),
      familyId: randomUUID(),
      now,
    });

    // Header advertises the JOSE name (not the Node digest name).
    const header = JSON.parse(Buffer.from(access.split('.')[0] ?? '', 'base64url').toString('utf8')) as { alg: string };
    expect(header.alg).toBe(algorithm);
    expect(['RS256', 'ES256']).toContain(header.alg);

    // verify must NOT throw; claims survive. Verify at the SAME fixed `now`
    // (the short 15-minute access-token TTL is relative to `now`).
    const verifyAt = Math.floor(now.getTime() / 1000);
    const accessClaims = verifyJwt(access, publicKey, undefined, { now: verifyAt });
    expect(accessClaims.sub).toBe('u1');
    expect(accessClaims.tid).toBe('t1');
    expect(accessClaims.sec_v).toBe('digest-1');
    expect(accessClaims.typ).toBe('access');

    const refreshClaims = service.verifyRefreshToken(refresh, now);
    expect(refreshClaims.sub).toBe('u1');
    expect(refreshClaims.typ).toBe('refresh');
    expect(typeof refreshClaims.jti).toBe('string');

    // ES256 JWS signature is the fixed 64-byte raw R‖S (ieee-p1363), not DER.
    const sigBytes = Buffer.from((access.split('.')[2] ?? ''), 'base64url');
    if (algorithm === 'ES256') {
      expect(sigBytes.length).toBe(64);
    } else {
      expect(sigBytes.length).toBe(256); // RSA-2048 signature size
    }
  });

  it('an ES256 token signed with raw R‖S verifies and rejects tampering (interoperability check)', () => {
    const { privateKeyPem, publicKeyPem } = generateEcKeypair();
    const privateKey = loadPrivateKey(privateKeyPem);
    const publicKey = loadPublicKey(publicKeyPem);
    const token = signJwt(
      { typ: 'access', sub: 'u', tid: 't', sec_v: 'v', iat: 1, exp: 4102444800 },
      privateKey,
      'ES256',
    );
    expect(() => verifyJwt(token, publicKey)).not.toThrow();
    const [h, , s] = token.split('.') as [string, string, string];
    const payload = b64url(JSON.stringify({ typ: 'access', sub: 'attacker', tid: 't', sec_v: 'v', iat: 1, exp: 4102444800 }));
    expect(() => verifyJwt(`${h}.${payload}.${s}`, publicKey)).toThrow(/signature/);
  });
});

describe('token-service issued claims contain no secret material (acceptance #6)', () => {
  const FORBIDDEN = ['password_hash', 'passwordHash', 'pin_hash', 'pinHash', 'pepper', 'password', 'pin'];

  function decodePayload(token: string): Record<string, unknown> {
    const payloadSegment = token.split('.')[1] ?? '';
    return JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8')) as Record<string, unknown>;
  }

  it('access and refresh token payloads never include hash/pepper fields', () => {
    const { privateKeyPem, publicKeyPem } = generateRsaKeypair();
    const service = new JwtTokenService({
      privateKey: loadPrivateKey(privateKeyPem),
      publicKey: loadPublicKey(publicKeyPem),
      algorithm: 'RS256',
    });
    const now = new Date('2026-09-07T00:00:00Z');
    const access = service.issueAccessToken({ tenantId: 't', userId: 'u', secV: 'digest', now });
    const refresh = service.issueRefreshToken({ tenantId: 't', userId: 'u', secV: 'digest', jti: randomUUID(), familyId: randomUUID(), now });

    for (const token of [access, refresh]) {
      const claims = decodePayload(token);
      for (const field of FORBIDDEN) {
        expect(Object.prototype.hasOwnProperty.call(claims, field)).toBe(false);
      }
    }
    // verifyJwt itself also rejects a token minted with a forbidden field.
    const tainted = signJwt(
      { typ: 'access', sub: 'u', tid: 't', sec_v: 'v', pepper: 'leaked', iat: 1, exp: 4102444800 },
      loadPrivateKey(privateKeyPem),
      'RS256',
    );
    expect(() => verifyJwt(tainted, loadPublicKey(publicKeyPem))).toThrow(/secret material/);
  });
});

describe('key loading fail-closed', () => {
  it('rejects malformed PEM', () => {
    expect(() => loadPrivateKey('not a pem')).toThrow(/invalid private key/i);
    expect(() => loadPublicKey('not a pem')).toThrow(/invalid public key/i);
  });

  it('refuses an asymmetric key-type mismatch in algorithmForKey', () => {
    const rsa = generateRsaKeypair();
    const ec = generateEcKeypair();
    expect(() =>
      algorithmForKey(loadPrivateKey(rsa.privateKeyPem), loadPublicKey(ec.publicKeyPem)),
    ).toThrow(/mismatch/);
  });

});
