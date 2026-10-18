import mongoose from "mongoose";
import { NextResponse } from "next/server";
import dbConnect from "@/lib/dbConnect";
import Admin from "@/lib/models/Admin";
import RefreshToken from "@/lib/models/RefreshToken";
import { requireSuperAdmin } from "@/lib/auth";
import { isAdminRole } from "@/lib/rolePolicy";

export async function PATCH(req, { params }) {
  const { response } = await requireSuperAdmin(req);
  if (response) return response;

  const { accountId } = await params;
  if (!mongoose.isValidObjectId(accountId)) {
    return NextResponse.json({ message: "Account not found." }, { status: 404 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ message: "A valid JSON request body is required." }, { status: 400 });
  }
  const hasRole = Object.prototype.hasOwnProperty.call(body || {}, "role");
  const hasActive = Object.prototype.hasOwnProperty.call(body || {}, "active");
  if ((!hasRole && !hasActive)
    || (hasRole && !isAdminRole(body.role))
    || (hasActive && typeof body.active !== "boolean")) {
    return NextResponse.json({ message: "Provide a valid role and/or active status." }, { status: 400 });
  }

  let session;
  try {
    await dbConnect();
    session = await mongoose.startSession();
    let account;
    let accessChanged = false;
    await session.withTransaction(async () => {
      account = await Admin.findById(accountId).session(session);
      if (!account) throw Object.assign(new Error("Account not found."), { status: 404 });

      const nextRole = hasRole ? body.role : account.role;
      const nextActive = hasActive ? body.active : account.active;
      const removingLastSuperAdmin = account.role === "super_admin" && account.active
        && (nextRole !== "super_admin" || !nextActive);
      if (removingLastSuperAdmin) {
        const otherActiveSuperAdmins = await Admin.countDocuments({
          _id: { $ne: account._id },
          role: "super_admin",
          active: true,
        }).session(session);
        if (!otherActiveSuperAdmins) {
          throw Object.assign(new Error("At least one active Super Admin account must remain."), { status: 409 });
        }
      }

      accessChanged = account.role !== nextRole || account.active !== nextActive;
      account.role = nextRole;
      account.active = nextActive;
      await account.save({ session });
      if (accessChanged) {
        await RefreshToken.deleteMany({ adminId: account._id }).session(session);
      }
    });

    return NextResponse.json({
      account: {
        id: account._id,
        name: account.name,
        email: account.email,
        role: account.role,
        active: account.active,
      },
      sessionsRevoked: accessChanged,
    });
  } catch (error) {
    if (error?.status) {
      return NextResponse.json({ message: error.message }, { status: error.status });
    }
    console.error("Account update failed:", error?.name || "unknown error");
    return NextResponse.json({ message: "Unable to update the account." }, { status: 503 });
  } finally {
    await session?.endSession();
  }
}
