import { NextResponse } from "next/server";
import dbConnect from "@/lib/dbConnect";
import Admin from "@/lib/models/Admin";
import RefreshToken from "@/lib/models/RefreshToken";
import { getJwtSecret } from "@/lib/auth";
import jwt from "jsonwebtoken";

export async function POST(req) {
  const jwtSecret = getJwtSecret();
  if (!jwtSecret) {
    console.error("Refresh failed: JWT_SECRET is missing or shorter than 32 bytes.");
    return NextResponse.json({ message: "Authentication is not securely configured." }, { status: 500 });
  }

  let refreshToken;
  let stored;
  let admin;
  try {
    await dbConnect();
    refreshToken = req.cookies.get("refreshToken")?.value;
    if (!refreshToken) {
      return NextResponse.json({ message: "No refresh token." }, { status: 401 });
    }

    stored = await RefreshToken.findOne({ token: refreshToken });
    if (!stored) {
      return NextResponse.json({ message: "Invalid or revoked refresh token." }, { status: 401 });
    }

    admin = await Admin.findById(stored.adminId);
    if (!admin) {
      await RefreshToken.deleteOne({ token: refreshToken });
      return NextResponse.json({ message: "Admin not found." }, { status: 401 });
    }
  } catch (error) {
    console.error("Refresh database operation failed:", error?.name || "unknown error");
    return NextResponse.json({ message: "Database unavailable." }, { status: 503 });
  }

  try {
    // Issue new access token
    const newAccessToken = jwt.sign(
      { id: admin._id, email: admin.email, name: admin.name },
      jwtSecret,
      { expiresIn: "15m" }
    );

    const response = NextResponse.json({
      admin: { name: admin.name, email: admin.email },
    });

    response.cookies.set("token", newAccessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 60 * 15,
      path: "/",
    });

    return response;
  } catch (error) {
    console.error("Refresh operation failed:", error?.name || "unknown error");
    return NextResponse.json({ message: "Server error." }, { status: 500 });
  }
}
