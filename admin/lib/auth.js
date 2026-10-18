import jwt from "jsonwebtoken";
import { NextResponse } from "next/server";
import { getJwtSecret } from "@/lib/jwtConfig";
import dbConnect from "@/lib/dbConnect";
import Admin from "@/lib/models/Admin";
import { canAccessSchoolAdmin, isAdminRole } from "@/lib/rolePolicy";

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

async function getActiveAdmin(req) {
  if (!getJwtSecret()) {
    return {
      admin: null,
      response: NextResponse.json(
        { message: "Authentication is not configured." },
        { status: 500 }
      ),
    };
  }

  const token = verifyToken(req);
  if (!token?.id) {
    return {
      admin: null,
      response: NextResponse.json(
        { message: "Unauthorized. Please log in as an admin." },
        { status: 401 }
      ),
    };
  }

  try {
    await dbConnect();
    const admin = await Admin.findById(token.id);
    if (!admin || !admin.active) {
      return {
        admin: null,
        response: NextResponse.json(
          { message: "Unauthorized. Please log in with an active account." },
          { status: 401 }
        ),
      };
    }
    if (!canAccessSchoolAdmin(admin.role)) {
      return {
        admin: null,
        response: NextResponse.json(
          { message: "Forbidden. This account cannot access school administration." },
          { status: 403 }
        ),
      };
    }
    return { admin, response: null };
  } catch (error) {
    console.error("Administrator authorization lookup failed:", error?.name || "unknown error");
    return {
      admin: null,
      response: NextResponse.json(
        { message: "Database unavailable." },
        { status: 503 }
      ),
    };
  }
}

export async function requireAdmin(req) {
  return getActiveAdmin(req);
}

export async function requireSuperAdmin(req) {
  const result = await getActiveAdmin(req);
  if (result.response) return result;
  if (result.admin.role !== "super_admin") {
    return {
      admin: null,
      response: NextResponse.json(
        { message: "Forbidden. Super Admin access is required." },
        { status: 403 }
      ),
    };
  }
  return result;
}

export async function getAuthenticatedAdmin(req) {
  if (!getJwtSecret()) {
    return {
      admin: null,
      response: NextResponse.json(
        { message: "Authentication is not securely configured." },
        { status: 500 }
      ),
    };
  }

  const token = verifyToken(req);
  if (!token?.id) {
    return {
      admin: null,
      response: NextResponse.json({ message: "Not authenticated." }, { status: 401 }),
    };
  }

  try {
    await dbConnect();
    const admin = await Admin.findById(token.id);
    if (!admin || !admin.active || !isAdminRole(admin.role)) {
      return {
        admin: null,
        response: NextResponse.json({ message: "Account is inactive or not configured." }, { status: 401 }),
      };
    }
    return { admin, response: null };
  } catch (error) {
    console.error("Authentication account lookup failed:", error?.name || "unknown error");
    return {
      admin: null,
      response: NextResponse.json({ message: "Database unavailable." }, { status: 503 }),
    };
  }
}
