export const ADMIN_ROLES = ["super_admin", "admin", "qr_admin"];

export function isAdminRole(role) {
  return ADMIN_ROLES.includes(role);
}

export function canAccessSchoolAdmin(role) {
  return role === "super_admin" || role === "admin";
}

export function canManageAccounts(role) {
  return role === "super_admin";
}
