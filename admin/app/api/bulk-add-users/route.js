import { NextResponse } from "next/server";
import dbConnect from "@/lib/dbConnect";
import User from "@/lib/models/User";
import { requireAdmin } from "@/lib/auth";

export async function POST(req) {
  const { response } = await requireAdmin(req);
  if (response) return response;
  await dbConnect();

  const { users } = await req.json();

  if (!Array.isArray(users) || users.length === 0) {
    return NextResponse.json({ message: "No users provided" }, { status: 400 });
  }

  const results = { inserted: 0, skipped: 0, errors: [] };

  for (const u of users) {
    try {
      const normalizedName = u.name?.trim().toLowerCase();
      const normalizedEmail = u.email?.trim().toLowerCase();
      const normalizedPrn = u.prn?.trim() || null;

      // Skip if email already exists
      const existing = await User.findOne({ email: normalizedEmail });
      if (existing) {
        results.skipped++;
        continue;
      }

      await User.create({
        id: u.id,
        name: normalizedName,
        prn: normalizedPrn,
        email: normalizedEmail,
        ticketType: u.ticketType,
        registeredEvent: u.registeredEvent,
      });

      results.inserted++;
    } catch (error) {
      results.errors.push(`${u.email}: ${error.message}`);
    }
  }

  return NextResponse.json({
    message: `Done! Inserted: ${results.inserted}, Skipped (already exist): ${results.skipped}${results.errors.length > 0 ? `, Errors: ${results.errors.length}` : ""}`,
    results,
  });
}
