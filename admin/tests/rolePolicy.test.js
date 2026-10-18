import assert from "node:assert/strict";
import test from "node:test";
import {
  canAccessSchoolAdmin,
  canManageAccounts,
  isAdminRole,
} from "../lib/rolePolicy.js";

test("all configured roles are recognized but only school roles access administration", () => {
  for (const role of ["super_admin", "admin", "qr_admin"]) {
    assert.equal(isAdminRole(role), true);
  }
  assert.equal(canAccessSchoolAdmin("super_admin"), true);
  assert.equal(canAccessSchoolAdmin("admin"), true);
  assert.equal(canAccessSchoolAdmin("qr_admin"), false);
  assert.equal(canAccessSchoolAdmin(undefined), false);
});

test("only super admins can manage accounts", () => {
  assert.equal(canManageAccounts("super_admin"), true);
  assert.equal(canManageAccounts("admin"), false);
  assert.equal(canManageAccounts("qr_admin"), false);
  assert.equal(isAdminRole("owner"), false);
});
