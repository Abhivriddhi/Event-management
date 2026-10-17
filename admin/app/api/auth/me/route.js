import { NextResponse } from "next/server";
import jwt from "jsonwebtoken";
import { getJwtSecret } from "@/lib/auth";

export async function GET(req) {
  const jwtSecret = getJwtSecret();
  if (!jwtSecret) {
    console.error("Authentication check failed: JWT_SECRET is missing or shorter than 32 bytes.");
    return NextResponse.json({ message: "Authentication is not securely configured." }, { status: 500 });
  }

  try {
    const token = req.cookies.get("token")?.value;

    if (!token) {
      return NextResponse.json({ message: "Not authenticated" }, { status: 401 });
    }

    const decoded = jwt.verify(token, jwtSecret);
    return NextResponse.json({ admin: { name: decoded.name, email: decoded.email } });
  } catch (error) {
    return NextResponse.json({ message: "Invalid or expired token" }, { status: 401 });
  }
}
