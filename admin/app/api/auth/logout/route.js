import { NextResponse } from "next/server";
import dbConnect from "@/lib/dbConnect";
import RefreshToken from "@/lib/models/RefreshToken";

export async function POST(req) {
  try {
    await dbConnect();
    const refreshToken = req.cookies.get("refreshToken")?.value;

    if (refreshToken) {
      await RefreshToken.deleteOne({ token: refreshToken });
    }

    const response = NextResponse.json({ message: "Logged out successfully" });
    response.cookies.set("token", "", { httpOnly: true, maxAge: 0, path: "/" });
    response.cookies.set("refreshToken", "", { httpOnly: true, maxAge: 0, path: "/" });

    return response;
  } catch (error) {
    console.error("Logout session revocation failed:", error?.name || "unknown error");
    const response = NextResponse.json({ message: "Unable to revoke the session; retry when the database is available." }, { status: 503 });
    response.cookies.set("token", "", { httpOnly: true, maxAge: 0, path: "/" });
    response.cookies.set("refreshToken", "", { httpOnly: true, maxAge: 0, path: "/" });
    return response;
  }
}
