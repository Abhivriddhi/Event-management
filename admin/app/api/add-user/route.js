import { NextResponse } from "next/server";
import dbConnect from "@/lib/dbConnect";
import User from "@/lib/models/User";
import { requireAdmin } from "@/lib/auth";

export async function POST(req) {
  const { response } = await requireAdmin(req);
  if (response) return response;
  await dbConnect();

  const { id, name, prn, email, ticketType, registeredEvent } = await req.json();

  try {
    const normalizedName = name?.trim().toLowerCase();
    const normalizedEmail = email?.trim().toLowerCase();
    const normalizedPrn = prn?.trim() || null;
    
    const user = await User.create({ 
      id, 
      name: normalizedName, 
      prn: normalizedPrn, 
      email: normalizedEmail, 
      ticketType, 
      registeredEvent 
    });
    return NextResponse.json({ message: "User added successfully", user });
  } catch (error) {
    console.error("Error adding user:", error);
    return NextResponse.json({ message: "Error adding user" }, { status: 500 });
  }
}