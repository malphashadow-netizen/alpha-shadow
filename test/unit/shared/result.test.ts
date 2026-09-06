import { describe, expect, it } from 'vitest';

import { andThen, err, isErr, isOk, map, mapErr, ok, unwrap } from '../../../src/shared/result.ts';

describe('shared/result', () => {
  it('ok creates success', () => {
    const r = ok(42);
    expect(r.ok).toBe(true);
    expect(isOk(r)).toBe(true);
    expect(isErr(r)).toBe(false);
    if (r.ok) expect(r.value).toBe(42);
  });

  it('err creates failure', () => {
    const e = new Error('oops');
    const r = err(e);
    expect(r.ok).toBe(false);
    expect(isErr(r)).toBe(true);
    expect(isOk(r)).toBe(false);
    if (!r.ok) expect(r.error).toBe(e);
  });

  it('unwrap returns value when ok', () => {
    expect(unwrap(ok(5))).toBe(5);
  });

  it('unwrap throws when err', () => {
    const e = new Error('fail');
    expect(() => unwrap(err(e))).toThrow(e);
  });

  it('unwrap throws exactly the error object', () => {
    const e = new Error('boom');
    try {
      unwrap(err(e));
    } catch (caught) {
      expect(caught).toBe(e);
    }
  });

  it('map transforms ok', () => {
    const r = map(ok(2), (x) => x * 3);
    expect(r.ok && r.value).toBe(6);
  });

  it('map preserves err', () => {
    const e = new Error('e');
    const r = map(err(e), (x: number) => x * 3);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe(e);
  });

  it('mapErr transforms err', () => {
    const r = mapErr(err('a'), (s) => s.length);
    expect(!r.ok && r.error).toBe(1);
  });

  it('mapErr preserves ok', () => {
    const r = mapErr(ok(5), (s: string) => s.length);
    expect(r.ok && r.value).toBe(5);
  });

  it('andThen chains ok', () => {
    const r = andThen(ok(5), (x) => ok(x * 2));
    expect(r.ok && r.value).toBe(10);
  });

  it('andThen short-circuits on err', () => {
    const e = new Error('e');
    const r = andThen(err(e), (x: number) => ok(x * 2));
    expect(r.ok).toBe(false);
  });

  it('andThen can return err', () => {
    const r = andThen(ok(5), () => err(new Error('fail')));
    expect(r.ok).toBe(false);
  });
});
