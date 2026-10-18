import mongoose from "mongoose";
import { NextResponse } from "next/server";
import dbConnect from "@/lib/dbConnect";
import AccessRequest from "@/lib/models/AccessRequest";
import Admin from "@/lib/models/Admin";
import { requireSuperAdmin } from "@/lib/auth";
import { isAdminRole } from "@/lib/rolePolicy";

export async function PATCH(req, { params }) {
  const { admin: reviewer, response } = await requireSuperAdmin(req);
  if (response) return response;

  const { requestId } = await params;
  if (!mongoose.isValidObjectId(requestId)) {
    return NextResponse.json({ message: "Access request not found." }, { status: 404 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ message: "A valid JSON request body is required." }, { status: 400 });
  }

  if (!["approve", "reject"].includes(body?.action)) {
    return NextResponse.json({ message: "Choose approve or reject." }, { status: 400 });
  }
  if (body.action === "approve" && !isAdminRole(body.role)) {
    return NextResponse.json({ message: "Assign a valid account role." }, { status: 400 });
  }

  let session;
  try {
    await dbConnect();
    session = await mongoose.startSession();
    let result;
    await session.withTransaction(async () => {
      const accessRequest = await AccessRequest.findOne({
        _id: requestId,
        status: "pending",
      }).select("+passwordHash").session(session);
      if (!accessRequest) {
        throw Object.assign(new Error("This access request has already been reviewed or does not exist."), { status: 409 });
      }

      if (body.action === "reject") {
        accessRequest.status = "rejected";
        accessRequest.passwordHash = "";
        accessRequest.reviewedBy = reviewer._id;
        accessRequest.reviewedAt = new Date();
        await accessRequest.save({ session });
        result = { status: "rejected" };
        return;
      }

      if (await Admin.exists({ email: accessRequest.email }).session(session)) {
        throw Object.assign(new Error("An account already exists for this request."), { status: 409 });
      }

      const [account] = await Admin.create([{
        name: accessRequest.name,
        email: accessRequest.email,
        password: accessRequest.passwordHash,
        role: body.role,
        active: true,
      }], { session });
      accessRequest.status = "approved";
      accessRequest.assignedRole = body.role;
      accessRequest.reviewedBy = reviewer._id;
      accessRequest.reviewedAt = new Date();
      accessRequest.passwordHash = "";
      await accessRequest.save({ session });
      result = { status: "approved", account: { id: account._id, email: account.email, role: account.role } };
    });

    return NextResponse.json(result);
  } catch (error) {
    if (error?.code === 11000) {
      return NextResponse.json({ message: "An account or reviewed request already exists for this email." }, { status: 409 });
    }
    if (error?.status) {
      return NextResponse.json({ message: error.message }, { status: error.status });
    }
    console.error("Access request review failed:", error?.name || "unknown error");
    return NextResponse.json({ message: "Unable to review the access request." }, { status: 503 });
  } finally {
    await session?.endSession();
  }
}
