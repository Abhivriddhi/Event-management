import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import dbConnect from "@/lib/dbConnect";
import Admin from "@/lib/models/Admin";
import { requireSuperAdmin } from "@/lib/auth";
import { isAdminRole } from "@/lib/rolePolicy";

export async function GET(req) {
  const { response } = await requireSuperAdmin(req);
  if (response) return response;

  try {
    await dbConnect();
    const accounts = await Admin.find({})
      .select("name email role active createdAt")
      .sort({ createdAt: 1 })
      .lean();
    return NextResponse.json({ accounts });
  } catch (error) {
    console.error("Account listing failed:", error?.name || "unknown error");
    return NextResponse.json({ message: "Unable to load accounts." }, { status: 503 });
  }
}

export async function POST(req) {
  const { response } = await requireSuperAdmin(req);
  if (response) return response;

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ message: "A valid JSON request body is required." }, { status: 400 });
  }

  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body?.password === "string" ? body.password : "";
  if (!name || name.length > 100
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254
    || password.length < 12 || password.length > 1024
    || !isAdminRole(body?.role)) {
    return NextResponse.json({
      message: "Provide a name, valid email, password of 12–1024 characters, and valid role.",
    }, { status: 400 });
  }

  try {
    await dbConnect();
    const account = await Admin.create({
      name,
      email,
      password: await bcrypt.hash(password, 12),
      role: body.role,
      active: true,
    });
    return NextResponse.json({
      account: { id: account._id, name: account.name, email: account.email, role: account.role, active: account.active },
    }, { status: 201 });
  } catch (error) {
    if (error?.code === 11000) {
      return NextResponse.json({ message: "An account already exists for this email." }, { status: 409 });
    }
    console.error("Account creation failed:", error?.name || "unknown error");
    return NextResponse.json({ message: "Unable to create the account." }, { status: 503 });
  }
}
