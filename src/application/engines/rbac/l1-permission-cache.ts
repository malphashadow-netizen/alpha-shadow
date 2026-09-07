/**
 * L1 permission-check cache — LRU with a 1-minute TTL.
 *
 * Used by the authorization engine to memoise the Permission-Check stage for
 * NON-sensitive permissions. The sensitive bypass is enforced by the ENGINE,
 * which never calls `get`/`set` when `is_sensitive = true` (both grants and
 * denials are excluded — the spec's "both directions" rule).
 */

import { ValidationError } from '../../../shared/errors.ts';
import type { PermissionCheckOutcome } from '../../../domain/contracts/permission-repository.ts';

interface CacheNode {
  readonly value: PermissionCheckOutcome;
  readonly storedAt: number;
}

export interface L1PermissionCacheOptions {
  /** Maximum number of entries before LRU eviction. */
  readonly maxEntries?: number;
  /** Entry lifetime in milliseconds. */
  readonly ttlMs?: number;
  /** Clock (injectable for tests). */
  readonly now?: () => number;
}

const DEFAULT_MAX_ENTRIES = 1024;
const DEFAULT_TTL_MS = 60_000; // 1 minute, per the spec

export class L1PermissionCache {
  private readonly entries = new Map<string, CacheNode>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: L1PermissionCacheOptions = {}) {
    const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
      throw new ValidationError('maxEntries must be a positive integer', 'maxEntries');
    }
    if (!Number.isInteger(ttlMs) || ttlMs <= 0) {
      throw new ValidationError('ttlMs must be a positive integer', 'ttlMs');
    }
    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs;
    this.now = options.now ?? Date.now;
  }

  /** Returns the cached outcome, or undefined on miss / TTL expiry. */
  get(key: string): PermissionCheckOutcome | undefined {
    const node = this.entries.get(key);
    if (node === undefined) return undefined;
    if (this.now() - node.storedAt >= this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    // Refresh recency for LRU.
    this.entries.delete(key);
    this.entries.set(key, node);
    return node.value;
  }

  /** Stores the outcome, evicting the least-recently-used entry if needed. */
  set(key: string, value: PermissionCheckOutcome): void {
    if (this.entries.has(key)) {
      this.entries.delete(key);
    }
    this.entries.set(key, { value, storedAt: this.now() });
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) break;
      this.entries.delete(oldestKey);
    }
  }
}
