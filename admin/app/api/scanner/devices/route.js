import crypto from "crypto";
import { NextResponse } from "next/server";
import dbConnect from "@/lib/dbConnect";
import Event from "@/lib/models/Event";
import ScannerDevice from "@/lib/models/ScannerDevice";
import { requireAdmin } from "@/lib/auth";
import { createPairingCode } from "@/lib/services/scannerService";

function hashToken(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export async function GET(req) {
  const { response } = await requireAdmin(req);
  if (response) return response;
  await dbConnect();
  const eventId = new URL(req.url).searchParams.get("eventId")?.toLowerCase();
  const devices = await ScannerDevice.find(eventId ? { eventId } : {})
    .select("-tokenHash -pairingCodeHash")
    .sort({ createdAt: -1 })
    .lean();
  return NextResponse.json({ devices });
}

export async function POST(req) {
  const { response } = await requireAdmin(req);
  if (response) return response;
  await dbConnect();
  try {
    const { eventId, color, name } = await req.json();
    const normalizedEventId = String(eventId || "").toLowerCase();
    if (!["red", "blue"].includes(color)) return NextResponse.json({ message: "Scanner color must be red or blue." }, { status: 400 });
    const event = await Event.findOne({ eventId: normalizedEventId });
    if (!event) return NextResponse.json({ message: "Event not found." }, { status: 404 });

    const pairingCode = createPairingCode();
    const device = await ScannerDevice.create({
      eventId: normalizedEventId,
      color,
      name: String(name || `${color.toUpperCase()} counter`).trim(),
      pairingCodeHash: hashToken(pairingCode),
      pairingExpiresAt: new Date(Date.now() + 30 * 60 * 1000),
    });
    return NextResponse.json({
      device: { _id: device._id, name: device.name, color: device.color, eventId: device.eventId },
      pairingCode,
      expiresInMinutes: 30,
    }, { status: 201 });
  } catch (error) {
    console.error("Create scanner device error:", error);
    return NextResponse.json({ message: error.message || "Unable to create scanner device." }, { status: 400 });
  }
}

export async function PATCH(req) {
  const { response } = await requireAdmin(req);
  if (response) return response;
  await dbConnect();
  const { deviceId, active } = await req.json();
  const device = await ScannerDevice.findByIdAndUpdate(
    deviceId,
    { $set: { active: Boolean(active), tokenHash: "", pairingCodeHash: "", pairingExpiresAt: null } },
    { new: true }
  ).select("-tokenHash -pairingCodeHash");
  if (!device) return NextResponse.json({ message: "Scanner device not found." }, { status: 404 });
  return NextResponse.json({ device });
}
