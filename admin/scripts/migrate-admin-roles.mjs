import { createRequire } from "node:module";
import mongoose from "mongoose";
import Admin from "../lib/models/Admin.js";
import RefreshToken from "../lib/models/RefreshToken.js";
import dbConnect from "../lib/dbConnect.js";
import { ADMIN_ROLES } from "../lib/rolePolicy.js";

const require = createRequire(import.meta.url);
require("@next/env").loadEnvConfig(process.cwd());

const targetArgument = process.argv[2];
if (!targetArgument || (targetArgument !== "--sole-existing-admin" && targetArgument.startsWith("--"))) {
  console.error("Usage: node scripts/migrate-admin-roles.mjs <super-admin-email>");
  console.error("       node scripts/migrate-admin-roles.mjs --sole-existing-admin");
  process.exit(1);
}

let session;
try {
  await dbConnect();
  session = await mongoose.startSession();
  let changedAccountCount = 0;

  await session.withTransaction(async () => {
    const admins = await Admin.find({}, "email role active").session(session).lean();
    if (!admins.length) {
      throw new Error("No existing admin account was found; this migration never creates accounts.");
    }

    let target;
    if (targetArgument === "--sole-existing-admin") {
      if (admins.length !== 1) {
        throw new Error("Expected exactly one existing admin account; supply its email explicitly when multiple accounts exist.");
      }
      target = admins[0];
    } else {
      const email = targetArgument.trim().toLowerCase();
      target = admins.find((admin) => admin.email === email);
      if (!target) throw new Error("The specified existing admin account was not found.");
    }

    const changedIds = [];
    for (const admin of admins) {
      const role = String(admin._id) === String(target._id)
        ? "super_admin"
        : ADMIN_ROLES.includes(admin.role) ? admin.role : "admin";
      const active = typeof admin.active === "boolean" ? admin.active : true;
      if (admin.active === false && String(admin._id) === String(target._id)) {
        throw new Error("The selected existing account is inactive. Reactivate it through an approved account-management action before migration.");
      }

      if (admin.role !== role || typeof admin.active !== "boolean") {
        await Admin.updateOne(
          { _id: admin._id },
          { $set: { role, active } },
          { session, runValidators: true }
        );
        changedIds.push(admin._id);
      }
    }

    if (changedIds.length) {
      await RefreshToken.deleteMany({ adminId: { $in: changedIds } }, { session });
    }
    changedAccountCount = changedIds.length;
  });

  console.log(`Admin role migration completed. Existing accounts updated: ${changedAccountCount}. Passwords were not changed.`);
} catch (error) {
  console.error(`Admin role migration failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await session?.endSession();
  await mongoose.disconnect();
}
