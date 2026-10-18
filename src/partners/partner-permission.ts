export const PARTNER_PERMISSIONS = ["disclosures:create", "requests:create", "requests:read"] as const;
export type PartnerPermission = typeof PARTNER_PERMISSIONS[number];

export function canonicalPermissions(permissions: readonly PartnerPermission[]): PartnerPermission[] {
  if (!Array.isArray(permissions) || permissions.length < 1 || permissions.length > PARTNER_PERMISSIONS.length ||
    new Set(permissions).size !== permissions.length || permissions.some((value) => !PARTNER_PERMISSIONS.includes(value))) {
    throw new Error("Invalid partner permissions.");
  }
  return [...permissions].sort();
}
