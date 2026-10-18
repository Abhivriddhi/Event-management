import { NextResponse } from "next/server";
import dbConnect from "@/lib/dbConnect";
import AccessRequest from "@/lib/models/AccessRequest";
import { requireSuperAdmin } from "@/lib/auth";

export async function GET(req) {
  const { response } = await requireSuperAdmin(req);
  if (response) return response;

  try {
    await dbConnect();
    const requests = await AccessRequest.find({})
      .select("-passwordHash")
      .sort({ status: 1, createdAt: -1 })
      .lean();
    return NextResponse.json({ requests });
  } catch (error) {
    console.error("Access request listing failed:", error?.name || "unknown error");
    return NextResponse.json({ message: "Unable to load access requests." }, { status: 503 });
  }
}
