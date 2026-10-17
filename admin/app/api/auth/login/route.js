import { NextResponse } from "next/server";
import dbConnect from "@/lib/dbConnect";
import Admin from "@/lib/models/Admin";
import RefreshToken from "@/lib/models/RefreshToken";
import { getJwtSecret } from "@/lib/auth";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";

export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ message: "A valid JSON request body is required." }, { status: 400 });
  }

  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body?.password === "string" ? body.password : "";

  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    || !password || password.length > 1024) {
    return NextResponse.json({ message: "A valid email and password are required." }, { status: 400 });
  }

  const jwtSecret = getJwtSecret();
  if (!jwtSecret) {
    console.error("Login failed: JWT_SECRET is missing or shorter than 32 bytes.");
    return NextResponse.json({ message: "Authentication is not securely configured." }, { status: 500 });
  }

  let admin;
  try {
    await dbConnect();
    admin = await Admin.findOne({ email });
  } catch (error) {
    console.error("Login database operation failed:", error?.name || "unknown error");
    return NextResponse.json({ message: "Database unavailable." }, { status: 503 });
  }

  if (!admin) {
    return NextResponse.json({ message: "Invalid email or password." }, { status: 401 });
  }

  try {
    const isMatch = await bcrypt.compare(password, admin.password);
    if (!isMatch) {
      return NextResponse.json({ message: "Invalid email or password." }, { status: 401 });
    }

    const accessToken = jwt.sign(
      { id: admin._id, email: admin.email, name: admin.name },
      jwtSecret,
      { expiresIn: "15m" }
    );

    const refreshToken = crypto.randomBytes(64).toString("hex");
    await RefreshToken.create({ adminId: admin._id, token: refreshToken });

    const response = NextResponse.json({
      message: "Login successful",
      admin: { name: admin.name, email: admin.email },
    });

    const isProd = process.env.NODE_ENV === "production";

    response.cookies.set("token", accessToken, {
      httpOnly: true,
      secure: isProd,
      sameSite: "lax",
      maxAge: 60 * 15,
      path: "/",
    });

    response.cookies.set("refreshToken", refreshToken, {
      httpOnly: true,
      secure: isProd,
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * 7,
      path: "/",
    });

    return response;
  } catch (error) {
    console.error("Login authentication operation failed:", error?.name || "unknown error");
    return NextResponse.json({ message: "Server error." }, { status: 500 });
  }
}
