import { NextResponse } from "next/server";
import dbConnect from "@/lib/dbConnect";
import Event from "@/lib/models/Event";
import OperationJob from "@/lib/models/OperationJob";
import EventParticipant from "@/lib/models/EventParticipant";
import ScannerDevice from "@/lib/models/ScannerDevice";
import Ticket from "@/lib/models/Ticket";
import { requireAdmin } from "@/lib/auth";
import { mapParticipant } from "@/lib/services/templateEngine";
import crypto from "crypto";

export async function GET(req, { params }) {
  const { response } = await requireAdmin(req);
  if (response) return response;
  await dbConnect();
  const { eventId } = await params;
  const event = await Event.findOne({ eventId: eventId.toLowerCase() });
  if (!event) return NextResponse.json({ message: "Event not found." }, { status: 404 });
  const result = event.toObject({ flattenMaps: true });
  result.ticketTemplates = {
    red: result.ticketTemplates?.red || result.ticketTemplateUrl || "",
    blue: result.ticketTemplates?.blue || result.ticketTemplateUrl || "",
  };
  return NextResponse.json({ event: result });
}

export async function POST(req, { params }) {
  const { response } = await requireAdmin(req);
  if (response) return response;
  await dbConnect();
  const { eventId } = await params;
  const event = await Event.findOne({ eventId: eventId.toLowerCase() });
  if (!event) return NextResponse.json({ message: "Event not found." }, { status: 404 });

  try {
    const body = await req.json();
    if (body.action === "import-excel") {
      if (!Array.isArray(body.rows) || !body.rows.length || body.rows.length > 5000) {
        return NextResponse.json({ message: "Provide between 1 and 5000 participant rows." }, { status: 400 });
      }
      const mappings = event.fieldMappings instanceof Map
        ? Object.fromEntries(event.fieldMappings.entries())
        : event.fieldMappings || {};
      body.rows.forEach((row) => mapParticipant(row, mappings));
      const version = crypto.randomUUID();
      try {
        for (let offset = 0; offset < body.rows.length; offset += 500) {
          await EventParticipant.insertMany(
            body.rows.slice(offset, offset + 500).map((row, index) => ({
              eventId: event.eventId,
              version,
              index: offset + index,
              row,
            }))
          );
        }
      } catch (error) {
        await EventParticipant.deleteMany({ eventId: event.eventId, version });
        throw error;
      }
      const previousVersion = event.participantSource.excelVersion;
      event.participantSource.type = "excel";
      event.participantSource.excelVersion = version;
      await event.save();
      if (previousVersion) {
        await EventParticipant.deleteMany({ eventId: event.eventId, version: previousVersion });
      }
      return NextResponse.json({ imported: body.rows.length });
    }
    return NextResponse.json({ message: "Unsupported event action." }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ message: error.message || "Unable to process event data." }, { status: 400 });
  }
}

export async function DELETE(req, { params }) {
  const { response } = await requireAdmin(req);
  if (response) return response;
  await dbConnect();
  const { eventId } = await params;
  const normalizedEventId = eventId.toLowerCase();
  const body = await req.json().catch(() => ({}));
  if (body.confirmEventId !== normalizedEventId) {
    return NextResponse.json({ message: "Type the exact event ID to confirm permanent deletion." }, { status: 400 });
  }
  const event = await Event.findOne({ eventId: normalizedEventId });
  if (!event) return NextResponse.json({ message: "Event not found." }, { status: 404 });
  const running = await OperationJob.exists({ eventId: normalizedEventId, status: { $in: ["PENDING", "RUNNING"] } });
  if (running) return NextResponse.json({ message: "Cannot delete an event with an active operation." }, { status: 409 });

  const session = await Event.startSession();
  try {
    await session.withTransaction(async () => {
      const activeJob = await OperationJob.exists({
        eventId: normalizedEventId,
        status: { $in: ["PENDING", "RUNNING"] },
      }).session(session);
      if (activeJob) {
        throw Object.assign(new Error("Cannot delete an event with an active operation."), { status: 409 });
      }
      await EventParticipant.deleteMany({ eventId: normalizedEventId }).session(session);
      await Ticket.deleteMany({ eventId: normalizedEventId }).session(session);
      await OperationJob.deleteMany({ eventId: normalizedEventId }).session(session);
      await ScannerDevice.deleteMany({ eventId: normalizedEventId }).session(session);
      await Event.deleteOne({ _id: event._id, eventId: normalizedEventId }).session(session);
    });
  } catch (error) {
    if (error.status) return NextResponse.json({ message: error.message }, { status: error.status });
    console.error("Delete event transaction error:", error);
    return NextResponse.json({ message: "Unable to safely delete the event and its event-specific records." }, { status: 500 });
  } finally {
    await session.endSession();
  }
  return NextResponse.json({ message: "Event and its event-specific records deleted." });
}
