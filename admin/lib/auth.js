import jwt from "jsonwebtoken";
import { NextResponse } from "next/server";
import { getJwtSecret } from "@/lib/jwtConfig";

export { getJwtSecret };

export function verifyToken(req) {
  try {
    const token = req.cookies.get("token")?.value;
    const secret = getJwtSecret();
    if (!token || !secret) return null;
    return jwt.verify(token, secret);
  } catch {
    return null;
  }
}

export function requireAdmin(req) {
  if (!getJwtSecret()) {
    return {
      admin: null,
      response: NextResponse.json(
        { message: "Authentication is not configured." },
        { status: 500 }
      ),
    };
  }

  const admin = verifyToken(req);
  if (!admin) {
    return {
      admin: null,
      response: NextResponse.json(
        { message: "Unauthorized. Please log in as an admin." },
        { status: 401 }
      ),
    };
  }

  return { admin, response: null };
}
