/**
 * TENANT_SUPER_ADMIN protection — shared, pure rule for both the InMemory and
 * Postgres write repositories (single source of truth, no duplicated logic).
 *
 * A removal/disable is refused exactly when the target is itself an ACTIVE
 * member of the protected set AND it is the last one. The FOR UPDATE lock is
 * the Postgres adapter's concern; this function is the decision both adapters
 * apply after locking.
 */
export function isLastActiveMember(activeMemberIds: readonly string[], targetId: string): boolean {
  const isMember = activeMemberIds.includes(targetId);
  return isMember && activeMemberIds.length === 1;
}
