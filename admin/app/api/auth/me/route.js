import { NextResponse } from "next/server";
import { getAuthenticatedAdmin } from "@/lib/auth";

export async function GET(req) {
  const { admin, response } = await getAuthenticatedAdmin(req);
  if (response) return response;
  return NextResponse.json({
    admin: { id: admin._id, name: admin.name, email: admin.email, role: admin.role },
  });
}
