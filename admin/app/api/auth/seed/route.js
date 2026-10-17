import { NextResponse } from "next/server";
import dbConnect from "@/lib/dbConnect";
import Admin from "@/lib/models/Admin";
import bcrypt from "bcryptjs";
import { timingSafeEqual } from "node:crypto";

// POST /api/auth/seed
// Body: { name, email, password, seedKey }
// seedKey must match SEED_KEY in the server environment.

export async function POST(req) {
  if (!process.env.SEED_KEY || Buffer.byteLength(process.env.SEED_KEY) < 32) {
    console.error("Admin seed failed: SEED_KEY is missing or shorter than 32 bytes.");
    return NextResponse.json({ message: "Admin seeding is not securely configured." }, { status: 500 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ message: "A valid JSON request body is required." }, { status: 400 });
  }

  const { name, email, password, seedKey } = body || {};
  if (typeof seedKey !== "string") {
    return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
  }

  const suppliedKey = Buffer.from(seedKey);
  const configuredKey = Buffer.from(process.env.SEED_KEY);
  if (suppliedKey.length !== configuredKey.length || !timingSafeEqual(suppliedKey, configuredKey)) {
    return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
  }

  const normalizedName = typeof name === "string" ? name.trim() : "";
  const normalizedEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (!normalizedName || normalizedName.length > 100
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)
    || normalizedEmail.length > 254
    || typeof password !== "string" || password.length < 12 || password.length > 1024) {
    return NextResponse.json({
      message: "Provide a name, valid email, and password between 12 and 1024 characters.",
    }, { status: 400 });
  }

  try {
    await dbConnect();
    if (await Admin.exists({})) {
      return NextResponse.json({ message: "An admin already exists; seeding will not create or replace one." }, { status: 409 });
    }
  } catch (error) {
    console.error("Admin seed database check failed:", error?.name || "unknown error");
    return NextResponse.json({ message: "Database unavailable." }, { status: 503 });
  }

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const admin = await Admin.create({
      name: normalizedName,
      email: normalizedEmail,
      password: hashedPassword,
    });

    return NextResponse.json({
      message: `Admin "${admin.name}" created successfully.`,
      email: admin.email,
    });
  } catch (error) {
    console.error("Admin seed operation failed:", error?.name || "unknown error");
    if (error?.code === 11000) {
      return NextResponse.json({ message: "An admin already exists; seeding will not create or replace one." }, { status: 409 });
    }
    return NextResponse.json({ message: "Server error." }, { status: 500 });
  }
}
