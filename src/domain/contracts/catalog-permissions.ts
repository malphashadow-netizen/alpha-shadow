/**
 * Atomic catalog permission keys (`resource:action`).
 *
 * These are RBAC registry keys, not catalog content: sections, items,
 * modifiers and languages remain fully data-driven. Catalog mutations are
 * not live money movement, so every key is registered with
 * `is_sensitive = false` (see migration 0008).
 */

export const CATALOG_PERMISSION_READ = 'catalog:read' as const;
export const CATALOG_PERMISSION_WRITE = 'catalog:write' as const;
export const CATALOG_PERMISSION_ARCHIVE = 'catalog:archive' as const;
export const CATALOG_PERMISSION_CATEGORY = 'catalog' as const;

export const CATALOG_PERMISSION_KEYS = Object.freeze([
  CATALOG_PERMISSION_READ,
  CATALOG_PERMISSION_WRITE,
  CATALOG_PERMISSION_ARCHIVE,
] as const);

export type CatalogPermissionKey = (typeof CATALOG_PERMISSION_KEYS)[number];
