import { NextResponse } from "next/server";
import dbConnect from "@/lib/dbConnect";
import Event from "@/lib/models/Event";
import { requireAdmin } from "@/lib/auth";
import { mapParticipant } from "@/lib/services/templateEngine";

function cleanEvent(event) {
  const result = event.toObject ? event.toObject({ flattenMaps: true }) : event;
  result.ticketTemplates = {
    red: result.ticketTemplates?.red || result.ticketTemplateUrl || "",
    blue: result.ticketTemplates?.blue || result.ticketTemplateUrl || "",
  };
  return result;
}

export async function GET(req) {
  const { response } = requireAdmin(req);
  if (response) return response;
  await dbConnect();
  const events = await Event.find({}).sort({ name: 1 });
  return NextResponse.json({ events: events.map(cleanEvent) });
}

export async function POST(req) {
  const { response } = requireAdmin(req);
  if (response) return response;
  await dbConnect();

  try {
    const body = await req.json();
    const eventId = String(body.eventId || "").trim().toLowerCase();
    const name = String(body.name || "").trim();
    if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(eventId)) {
      return NextResponse.json({ message: "Event ID must be 2-64 letters, numbers, hyphens, or underscores." }, { status: 400 });
    }
    if (!name) return NextResponse.json({ message: "Event name is required." }, { status: 400 });

    const mappings = body.fieldMappings || {};
    if (!mappings || Array.isArray(mappings) || typeof mappings !== "object") {
      return NextResponse.json({ message: "Field mappings must be a JSON object." }, { status: 400 });
    }
    for (const [sourceField, targetPath] of Object.entries(mappings)) {
      if (
        typeof targetPath !== "string" ||
        !targetPath.startsWith("participant.") ||
        targetPath === "participant." ||
        targetPath.split(".").some((key) => ["__proto__", "prototype", "constructor"].includes(key))
      ) {
        return NextResponse.json({ message: `Invalid mapping for ${sourceField}. Targets must start with participant.` }, { status: 400 });
      }
    }

    const delayMs = Number(body.emailSettings?.delayMs ?? 1000);
    const dailyLimit = Number(body.emailSettings?.dailyLimit ?? 1500);
    if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > 60_000) {
      return NextResponse.json({ message: "Email delay must be between 0 and 60000 milliseconds." }, { status: 400 });
    }
    if (!Number.isInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > 100_000) {
      return NextResponse.json({ message: "Daily email limit must be an integer between 1 and 100000." }, { status: 400 });
    }
    const legacyTicketTemplate = String(body.ticketTemplateUrl || "").trim();
    const set = {
  name,
  "participantSource.type": body.participantSource?.type || "mongodb",
  "participantSource.spreadsheetUrl": String(
    body.participantSource?.spreadsheetUrl || ""
  ).trim(),
  "participantSource.worksheet": String(
    body.participantSource?.worksheet || ""
  ).trim(),

  fieldMappings: mappings,

  "ticketTemplates.red": String(
    body.ticketTemplates?.red ?? legacyTicketTemplate
  ).trim(),

  "ticketTemplates.blue": String(
    body.ticketTemplates?.blue ?? legacyTicketTemplate
  ).trim(),

  certificateTemplateUrl: String(
    body.certificateTemplateUrl || ""
  ).trim(),

  "emailTemplate.subject": String(
    body.emailTemplate?.subject || ""
  ),

  "emailTemplate.html": String(
    body.emailTemplate?.html || ""
  ),

  "ticketSettings.enabled":
    body.ticketSettings?.enabled !== false,

  "ticketSettings.qrPlaceholder": String(
    body.ticketSettings?.qrPlaceholder || "{{ticket.qr}}"
  ).trim(),

  "emailSettings.enabled":
    body.emailSettings?.enabled !== false,

  "emailSettings.delayMs": delayMs,
  "emailSettings.dailyLimit": dailyLimit,
};

    const participantSourceType = body.participantSource?.type || "mongodb";
const participantSpreadsheetUrl = String(
  body.participantSource?.spreadsheetUrl || ""
).trim();

if (
  participantSourceType === "googleSheets" &&
  !participantSpreadsheetUrl
) {
  return NextResponse.json(
    {
      message:
        "A Google Sheets URL is required for this participant source.",
    },
    { status: 400 }
  );
}

if (!["mongodb", "excel", "googleSheets"].includes(participantSourceType)) {
  return NextResponse.json(
    { message: "Unsupported participant source." },
    { status: 400 }
  );
}

    const event = await Event.findOneAndUpdate(
      { eventId },
      { $set: set, $unset: { ticketTemplateUrl: 1 }, $setOnInsert: { eventId } },
      { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
    );
    return NextResponse.json({ event: cleanEvent(event) });
  } catch (error) {
    console.error("Save event error:", error);
    return NextResponse.json({ message: error.message || "Unable to save event." }, { status: 500 });
  }
}
