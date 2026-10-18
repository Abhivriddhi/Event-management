import { NextResponse } from "next/server";
import dbConnect from "@/lib/dbConnect";
import Event from "@/lib/models/Event";
import { requireAdmin } from "@/lib/auth";
import { loadEventParticipants } from "@/lib/services/participantSourceService";
import { getSpreadsheetRows } from "@/lib/services/googleApi";
import EventParticipant from "@/lib/models/EventParticipant";

export async function GET(req, { params }) {
  const { response } = await requireAdmin(req);
  if (response) return response;
  await dbConnect();
  const { eventId } = await params;
  try {
    const event = await Event.findOne({ eventId: eventId.toLowerCase() });
    if (!event) return NextResponse.json({ message: "Event not found." }, { status: 404 });
    const sourceType = event.participantSource?.type || "mongodb";
    let fields = [];
    let rowCount = 0;
    if (sourceType === "googleSheets") {
      const rows = await getSpreadsheetRows(event.participantSource.spreadsheetUrl, event.participantSource.worksheet);
      fields = Object.keys(rows[0] || {});
      rowCount = rows.length;
    } else if (sourceType === "excel") {
      const rows = await EventParticipant.find({
        eventId: event.eventId,
        version: event.participantSource.excelVersion,
      }).sort({ index: 1 }).select("row").limit(1).lean();
      fields = Object.keys(rows[0]?.row || {});
      rowCount = await EventParticipant.countDocuments({
        eventId: event.eventId,
        version: event.participantSource.excelVersion,
      });
    } else {
      const participants = await loadEventParticipants(event);
      fields = Object.keys(participants[0] || {});
      rowCount = participants.length;
    }
    return NextResponse.json({ sourceType, fields, rowCount });
  } catch (error) {
    console.error("Preview participant source error:", error);
    return NextResponse.json({ message: error.message || "Unable to preview participant source." }, { status: 400 });
  }
}
