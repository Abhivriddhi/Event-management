import assert from "node:assert/strict";
import { createRequire } from "node:module";
import crypto from "node:crypto";

const require = createRequire(import.meta.url);
require("@next/env").loadEnvConfig(process.cwd());

const baseUrl = process.env.ROLE_AUTH_TEST_BASE_URL;
const testSecret = process.env.ROLE_AUTH_TEST_JWT_SECRET || process.env.JWT_SECRET;
const expectedDatabase = process.env.ROLE_AUTH_TEST_CONFIRM_DATABASE;
if (!baseUrl || !testSecret || !expectedDatabase) {
  throw new Error("Set ROLE_AUTH_TEST_BASE_URL and ROLE_AUTH_TEST_CONFIRM_DATABASE, and configure JWT_SECRET to opt in.");
}

const parsedBaseUrl = new URL(baseUrl);
if (!["localhost", "127.0.0.1", "::1"].includes(parsedBaseUrl.hostname)) {
  throw new Error("Role integration tests may only target a local application server.");
}
if (Buffer.byteLength(testSecret) < 32) {
  throw new Error("ROLE_AUTH_TEST_JWT_SECRET must be at least 32 bytes.");
}
process.env.JWT_SECRET = testSecret;

const jwt = require("jsonwebtoken");
const mongoose = (await import("mongoose")).default;
const { default: dbConnect } = await import("../lib/dbConnect.js");
const { default: Admin } = await import("../lib/models/Admin.js");
const { default: RefreshToken } = await import("../lib/models/RefreshToken.js");
const { default: AccessRequest } = await import("../lib/models/AccessRequest.js");

const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 14);
const requestEmails = [
  `role-qr-${suffix}@example.invalid`,
  `role-rejected-${suffix}@example.invalid`,
  `role-admin-${suffix}@example.invalid`,
];
const passwords = ["QR Integration Password 123!", "Rejected Integration Password 123!", "Admin Integration Password 123!"];
const [qrEmail, rejectedEmail, adminEmail] = requestEmails;
let failure;

function cookieFor(adminId) {
  const token = jwt.sign({ id: String(adminId) }, testSecret, { expiresIn: "10m" });
  return `token=${token}`;
}

async function callApi(path, { method = "GET", body, cookie } = {}) {
  const response = await fetch(new URL(path, baseUrl), {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { response, data: await response.json() };
}

try {
  await dbConnect();
  if (mongoose.connection.db.databaseName !== expectedDatabase) {
    throw new Error("Connected database does not match ROLE_AUTH_TEST_CONFIRM_DATABASE; refusing to write test records.");
  }

  const superAdmin = await Admin.findOne({ role: "super_admin", active: true }, "_id");
  assert.ok(superAdmin, "An active Super Admin is required for integration tests.");
  const superCookie = cookieFor(superAdmin._id);

  let result = await callApi("/api/admin/accounts", { cookie: superCookie });
  assert.equal(result.response.status, 200, "Super Admin can list accounts.");
  result = await callApi("/api/admin/access-requests", { cookie: superCookie });
  assert.equal(result.response.status, 200, "Super Admin can list access requests.");

  result = await callApi("/api/auth/request-access", {
    method: "POST",
    body: { name: "QR Integration", email: qrEmail, password: passwords[0], role: "super_admin" },
  });
  assert.equal(result.response.status, 202, "Applicant can submit a role-free access request.");
  result = await callApi("/api/auth/request-access", {
    method: "POST",
    body: { name: "Duplicate", email: qrEmail, password: passwords[0] },
  });
  assert.equal(result.response.status, 409, "Duplicate access requests are rejected.");
  result = await callApi("/api/auth/login", {
    method: "POST",
    body: { email: qrEmail, password: passwords[0] },
  });
  assert.equal(result.response.status, 401, "Pending request cannot log in.");

  result = await callApi("/api/auth/request-access", {
    method: "POST",
    body: { name: "Rejected Integration", email: rejectedEmail, password: passwords[1] },
  });
  assert.equal(result.response.status, 202);
  const requests = await AccessRequest.find({ email: { $in: [qrEmail, rejectedEmail] } }, "_id email").lean();
  const qrRequest = requests.find((request) => request.email === qrEmail);
  const rejectedRequest = requests.find((request) => request.email === rejectedEmail);
  assert.ok(qrRequest && rejectedRequest, "Requests were persisted.");

  result = await callApi(`/api/admin/access-requests/${rejectedRequest._id}`, {
    method: "PATCH",
    cookie: superCookie,
    body: { action: "reject" },
  });
  assert.equal(result.response.status, 200, "Super Admin can reject a pending request.");
  result = await callApi("/api/auth/login", {
    method: "POST",
    body: { email: rejectedEmail, password: passwords[1] },
  });
  assert.equal(result.response.status, 401, "Rejected request cannot log in.");

  result = await callApi(`/api/admin/access-requests/${qrRequest._id}`, {
    method: "PATCH",
    cookie: superCookie,
    body: { action: "approve", role: "qr_admin" },
  });
  assert.equal(result.response.status, 200, "Super Admin can approve and assign a role.");
  const qrAccount = await Admin.findOne({ email: qrEmail }, "_id role active");
  assert.equal(qrAccount.role, "qr_admin");

  result = await callApi("/api/auth/login", {
    method: "POST",
    body: { email: qrEmail, password: passwords[0] },
  });
  assert.equal(result.response.status, 200, "Approved applicant can log in.");
  assert.equal(result.data.admin.role, "qr_admin");
  const qrToken = /(?:^|,\s*)token=([^;,]+)/.exec(result.response.headers.get("set-cookie") || "")?.[1];
  assert.ok(qrToken, "Login sets an access cookie.");
  result = await callApi("/api/events", { cookie: `token=${qrToken}` });
  assert.equal(result.response.status, 403, "QR Admin cannot access school event APIs.");
  result = await callApi("/api/admin/accounts", { cookie: `token=${qrToken}` });
  assert.equal(result.response.status, 403, "QR Admin cannot access account management.");
  result = await callApi(`/api/admin/access-requests/${qrRequest._id}`, {
    method: "PATCH",
    cookie: `token=${qrToken}`,
    body: { action: "approve", role: "super_admin" },
  });
  assert.equal(result.response.status, 403, "QR Admin cannot approve requests or escalate roles.");

  result = await callApi("/api/admin/accounts", {
    method: "POST",
    cookie: superCookie,
    body: { name: "Admin Integration", email: adminEmail, password: passwords[2], role: "admin" },
  });
  assert.equal(result.response.status, 201, "Super Admin can create an admin account.");
  const schoolAdmin = await Admin.findOne({ email: adminEmail }, "_id role");
  assert.equal(schoolAdmin.role, "admin");
  result = await callApi("/api/admin/accounts", { cookie: cookieFor(schoolAdmin._id) });
  assert.equal(result.response.status, 403, "Admin cannot manage accounts.");
  result = await callApi("/api/admin/access-requests", { cookie: cookieFor(schoolAdmin._id) });
  assert.equal(result.response.status, 403, "Admin cannot approve requests.");
  result = await callApi("/api/admin/accounts", {
    method: "POST",
    cookie: cookieFor(schoolAdmin._id),
    body: { name: "Escalation", email: `escalation-${suffix}@example.invalid`, password: passwords[2], role: "super_admin" },
  });
  assert.equal(result.response.status, 403, "Admin cannot create or escalate roles.");
  result = await callApi("/api/events", { cookie: cookieFor(schoolAdmin._id) });
  assert.equal(result.response.status, 200, "Admin retains school administration access.");

  result = await callApi("/api/auth/login", {
    method: "POST",
    body: { email: adminEmail, password: passwords[2] },
  });
  assert.equal(result.response.status, 200, "New admin account can log in.");
  const adminCookies = result.response.headers.get("set-cookie") || "";
  const adminToken = /(?:^|,\s*)token=([^;,]+)/.exec(adminCookies)?.[1];
  const adminRefresh = /(?:^|,\s*)refreshToken=([^;,]+)/.exec(adminCookies)?.[1];
  assert.ok(adminToken && adminRefresh, "Login sets access and refresh cookies.");

  result = await callApi(`/api/admin/accounts/${schoolAdmin._id}`, {
    method: "PATCH",
    cookie: superCookie,
    body: { role: "qr_admin" },
  });
  assert.equal(result.response.status, 200, "Super Admin can change account roles.");
  assert.equal(result.data.sessionsRevoked, true, "Role changes revoke refresh tokens.");
  result = await callApi("/api/events", { cookie: `token=${adminToken}` });
  assert.equal(result.response.status, 403, "Role changes immediately restrict existing access tokens.");
  result = await callApi("/api/auth/refresh", {
    method: "POST",
    cookie: `refreshToken=${adminRefresh}`,
  });
  assert.equal(result.response.status, 401, "Revoked refresh token cannot restore access.");

  result = await callApi(`/api/admin/accounts/${superAdmin._id}`, {
    method: "PATCH",
    cookie: superCookie,
    body: { active: false },
  });
  assert.equal(result.response.status, 409, "The last active Super Admin cannot be disabled.");
  console.log("Role authorization integration tests passed.");
} catch (error) {
  failure = error;
} finally {
  try {
    await dbConnect();
    const temporaryAccounts = await Admin.find({ email: { $in: requestEmails } }, "_id").lean();
    const adminIds = temporaryAccounts.map((account) => account._id);
    if (adminIds.length) await RefreshToken.deleteMany({ adminId: { $in: adminIds } });
    await Admin.deleteMany({ email: { $in: requestEmails } });
    await AccessRequest.deleteMany({ email: { $in: requestEmails } });
    const [remainingAdmins, remainingRequests] = await Promise.all([
      Admin.countDocuments({ email: { $in: requestEmails } }),
      AccessRequest.countDocuments({ email: { $in: requestEmails } }),
    ]);
    if (remainingAdmins || remainingRequests) {
      throw new Error("Temporary role integration accounts or requests remain after cleanup.");
    }
  } catch (cleanupError) {
    failure = new AggregateError([failure, cleanupError].filter(Boolean), "Role integration cleanup failed.");
  }
  await mongoose.disconnect();
}

if (failure) {
  console.error(`Role authorization integration tests failed: ${failure.message}`);
  process.exitCode = 1;
}
