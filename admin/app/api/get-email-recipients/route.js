import { NextResponse } from "next/server";
import dbConnect from "@/lib/dbConnect";
import User from "@/lib/models/User";
import { requireAdmin } from "@/lib/auth";

export async function GET(req) {
  const { response } = await requireAdmin(req);
  if (response) return response;
  await dbConnect();

  try {
    const { searchParams } = new URL(req.url);
    const ticketType = searchParams.get("ticketType") || "ALL";
    const event = searchParams.get("event") || "ALL";

    const query = {};
    if (ticketType !== "ALL") query.ticketType = ticketType;
    if (event !== "ALL") query.registeredEvent = event;

    const users = await User.find(query, {
      name: 1,
      email: 1,
      prn: 1,
      ticketType: 1,
      registeredEvent: 1,
    })
      .sort({ name: 1 })
      .lean();

    return NextResponse.json({
      count: users.length,
      users: users.slice(0, 100), // Preview up to 100
      totalCount: users.length,
    });
  } catch (error) {
    console.error("Error fetching email recipients:", error);
    return NextResponse.json(
      { message: "Failed to fetch recipients", error: error.message },
      { status: 500 }
    );
  }
}
