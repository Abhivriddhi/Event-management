import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import dbConnect from "@/lib/dbConnect";
import AccessRequest from "@/lib/models/AccessRequest";
import Admin from "@/lib/models/Admin";

export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ message: "A valid JSON request body is required." }, { status: 400 });
  }

  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body?.password === "string" ? body.password : "";
  const message = typeof body?.message === "string" ? body.message.trim() : "";

  if (!name || name.length > 100
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254
    || password.length < 12 || password.length > 1024 || message.length > 1000) {
    return NextResponse.json({
      message: "Provide a name, valid email, password of 12–1024 characters, and a request message under 1000 characters.",
    }, { status: 400 });
  }

  try {
    await dbConnect();
    if (await Admin.exists({ email })) {
      return NextResponse.json({ message: "An account or access request already exists for this email." }, { status: 409 });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const existing = await AccessRequest.findOne({ email }).select("+passwordHash");
    if (existing) {
      if (existing.status !== "rejected") {
        return NextResponse.json({ message: "An account or access request already exists for this email." }, { status: 409 });
      }

      const resubmitted = await AccessRequest.findOneAndUpdate(
        { _id: existing._id, status: "rejected" },
        {
          $set: {
            name,
            passwordHash,
            message,
            status: "pending",
            assignedRole: null,
            reviewedBy: null,
            reviewedAt: null,
          },
        },
        { new: true, runValidators: true }
      );
      if (!resubmitted) {
        return NextResponse.json({ message: "An account or access request already exists for this email." }, { status: 409 });
      }
    } else {
      await AccessRequest.create({ name, email, passwordHash, message });
    }

    return NextResponse.json({
      message: "Access request submitted. An administrator will review it.",
    }, { status: 202 });
  } catch (error) {
    if (error?.code === 11000) {
      return NextResponse.json({ message: "An account or access request already exists for this email." }, { status: 409 });
    }
    console.error("Access request submission failed:", error?.name || "unknown error");
    return NextResponse.json({ message: "Unable to submit the access request." }, { status: 503 });
  }
}
