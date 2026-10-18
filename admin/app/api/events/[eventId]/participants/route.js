import { NextResponse } from "next/server";
import dbConnect from "@/lib/dbConnect";
import Event from "@/lib/models/Event";
import EventParticipant from "@/lib/models/EventParticipant";
import OperationJob from "@/lib/models/OperationJob";
import ScannerDevice from "@/lib/models/ScannerDevice";
import Ticket from "@/lib/models/Ticket";
import User from "@/lib/models/User";
import { requireAdmin } from "@/lib/auth";
import { getSpreadsheetRows } from "@/lib/services/googleApi";
import { mapParticipant } from "@/lib/services/templateEngine";

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalized(value) {
  return String(value || "").trim().toLowerCase();
}

function mapStoredExcelRow(row, mappings) {
  return mapParticipant(row, mappings);
}

function prnMembership(fieldPath, prns, negate = false) {
  const normalizedPrn = {
    $toUpper: {
      $trim: {
        input: { $ifNull: [`$${fieldPath}`, ""] },
      },
    },
  };
  const membership = { $in: [normalizedPrn, prns] };
  return { $expr: negate ? { $not: [membership] } : membership };
}

function redactFailure(value) {
  let message = String(value || "");
  const secrets = Object.entries(process.env)
    .filter(([name, secret]) =>
      secret && /(password|pass|secret|token|private|credential|api.?key|sauce|smtp|email|service.account|script.*url)/i.test(name)
    )
    .map(([, secret]) => secret);
  for (const secret of secrets) {
    if (secret) message = message.replaceAll(secret, "[redacted]");
  }
  return message.replace(
    /(password|private[_ -]?key|client[_ -]?secret|token|api[_ -]?key)\s*[:=]\s*["']?[^,\s"']+/gi,
    "$1=[redacted]"
  );
}

async function readEventParticipants(event) {
  const sourceType = event.participantSource?.type || "mongodb";
  const mappings = event.fieldMappings instanceof Map
    ? Object.fromEntries(event.fieldMappings.entries())
    : event.fieldMappings || {};

  if (sourceType === "mongodb") {
    const users = await User.find({ registeredEvent: event.name }).lean();
    return users.map((user) => ({
      key: `user:${user._id}`,
      sourceId: String(user._id),
      participant: mapParticipant({
        name: user.name,
        email: user.email,
        prn: user.prn || "",
        ticketType: user.ticketType,
      }, mappings),
    }));
  }

  if (sourceType === "excel") {
    const rows = await EventParticipant.find({
      eventId: event.eventId,
      version: event.participantSource?.excelVersion,
    }).sort({ index: 1 }).select("row").lean();
    return rows.map((item) => {
      const participant = mapStoredExcelRow(item.row, mappings);
      return {
        key: `excel:${item._id}`,
        sourceId: String(item._id),
        participant,
      };
    });
  }

  if (!event.participantSource?.spreadsheetUrl) {
    throw new Error("Configure a Google Sheets URL for this event.");
  }
  const rows = await getSpreadsheetRows(
    event.participantSource.spreadsheetUrl,
    event.participantSource.worksheet
  );
  return rows.map((row, index) => {
    const participant = mapParticipant(row, mappings);
    return {
      key: `sheet:${normalized(participant.email)}:${String(participant.prn || "").trim().toUpperCase()}:${index}`,
      sourceId: "",
      participant,
    };
  });
}

async function joinTrackingRows(event, participants) {
  const prns = [...new Set(participants.map(({ participant }) => String(participant.prn || "").trim().toUpperCase()).filter(Boolean))];
  const emails = [...new Set(participants.map(({ participant }) => normalized(participant.email)).filter(Boolean))];

  const [tickets, jobs] = await Promise.all([
    prns.length ? Ticket.find({ eventId: event.eventId, prn: { $in: prns } }).lean() : [],
    emails.length ? OperationJob.aggregate([
      { $match: { eventId: event.eventId, $or: [{ type: "ticket" }, { type: "email", attachmentKind: "ticket" }] } },
      { $unwind: "$recipients" },
      { $match: { "recipients.email": { $in: emails } } },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: "$recipients.email",
          latest: {
            $first: {
              status: "$recipients.status",
              sentAt: "$recipients.sentAt",
              lastError: "$recipients.lastError",
              ticketId: "$recipients.ticketId",
              ticketColor: "$recipients.ticketColor",
              templateUrl: "$recipients.templateUrl",
            },
          },
        },
      },
    ]) : [],
  ]);
  const ticketByPrn = new Map(tickets.map((ticket) => [String(ticket.prn || "").toUpperCase(), ticket]));
  const jobByEmail = new Map(jobs.map((job) => [normalized(job._id), job.latest]));
  const deviceIds = [...new Set(tickets.filter((ticket) => ticket.usedBy).map((ticket) => String(ticket.usedBy)))];
  const devices = deviceIds.length
    ? await ScannerDevice.find({ eventId: event.eventId, _id: { $in: deviceIds } })
      .select("name color")
      .lean()
    : [];
  const deviceById = new Map(devices.map((device) => [String(device._id), device]));

  return participants.map(({ key, sourceId, participant }) => {
    const ticket = ticketByPrn.get(String(participant.prn || "").trim().toUpperCase()) || null;
    const email = normalized(participant.email);
    const delivery = jobByEmail.get(email) || null;
    const emailStatus = delivery?.status || "NOT SENT";
    const scanner = ticket?.usedBy ? deviceById.get(String(ticket.usedBy)) || null : null;
    return {
      key,
      sourceId,
      name: participant.name || "",
      prn: participant.prn || "",
      email: participant.email || "",
      ticketId: ticket?.ticketId || delivery?.ticketId || "",
      color: ticket?.color || delivery?.ticketColor || "",
      ticketStatus: ticket ? "GENERATED" : "NOT GENERATED",
      emailStatus,
      sentAt: delivery?.sentAt || null,
      failureReason: emailStatus === "FAILED" ? redactFailure(delivery?.lastError) : "",
      templateUrl: delivery?.templateUrl ||
        (ticket ? event.ticketTemplates?.[ticket.color] || event.ticketTemplateUrl || "" : ""),
      scanned: Boolean(ticket?.usedAt),
      scannedAt: ticket?.usedAt || null,
      scanner: scanner ? { name: scanner.name, color: scanner.color } : null,
    };
  });
}

async function getTrackingRows(event) {
  return joinTrackingRows(event, await readEventParticipants(event));
}

async function latestEmailStates(event) {
  const jobs = await OperationJob.aggregate([
    { $match: { eventId: event.eventId, $or: [{ type: "ticket" }, { type: "email", attachmentKind: "ticket" }] } },
    { $unwind: "$recipients" },
    { $sort: { createdAt: -1 } },
    {
      $group: {
        _id: "$recipients.email",
        latest: {
          $first: {
            status: "$recipients.status",
            sentAt: "$recipients.sentAt",
          },
        },
      },
    },
  ]);
  return new Map(jobs.map((job) => [normalized(job._id), job.latest]));
}

async function getSummaryCounts(event) {
  const sourceType = event.participantSource?.type || "mongodb";
  let totalParticipants;
  let participantEmails;
  if (sourceType === "mongodb") {
    const query = { registeredEvent: event.name };
    [totalParticipants, participantEmails] = await Promise.all([
      User.countDocuments(query),
      User.distinct("email", query),
    ]);
  } else if (sourceType === "excel") {
    const query = { eventId: event.eventId, version: event.participantSource?.excelVersion };
    [totalParticipants, participantEmails] = await Promise.all([
      EventParticipant.countDocuments(query),
      EventParticipant.distinct("row.email", query),
    ]);
  } else {
    const rows = await getTrackingRows(event);
    return safeCounts(rows);
  }
  const [ticketGroups, emailStates] = await Promise.all([
    Ticket.aggregate([
      { $match: { eventId: event.eventId } },
      {
        $group: {
          _id: "$color",
          count: { $sum: 1 },
          scanned: { $sum: { $cond: [{ $ne: ["$usedAt", null] }, 1, 0] } },
        },
      },
    ]),
    latestEmailStates(event),
  ]);
  const participantEmailSet = new Set(participantEmails.map(normalized));
  let ticketsSent = 0;
  let failed = 0;
  for (const [email, state] of emailStates) {
    if (!participantEmailSet.has(email)) continue;
    if (state.status === "SENT") ticketsSent++;
    if (state.status === "FAILED") failed++;
  }
  const counts = {
    totalParticipants,
    ticketsGenerated: 0,
    ticketsSent,
    redTickets: 0,
    blueTickets: 0,
    scanned: 0,
    notScanned: 0,
    failed,
  };
  for (const group of ticketGroups) {
    counts.ticketsGenerated += group.count;
    counts.scanned += group.scanned;
    if (group._id === "red") counts.redTickets = group.count;
    if (group._id === "blue") counts.blueTickets = group.count;
  }
  counts.notScanned = Math.max(0, totalParticipants - counts.scanned);
  return counts;
}

async function getFilteredPage(event, { search, ticketStatus, emailStatus, color, scanStatus, page, limit }) {
  const sourceType = event.participantSource?.type || "mongodb";
  if (sourceType === "googleSheets") {
    const allRows = await getTrackingRows(event);
    const filtered = filterRows(allRows, search, ticketStatus, emailStatus, color, scanStatus);
    return {
      rows: filtered.slice((page - 1) * limit, page * limit),
      total: filtered.length,
    };
  }

  const isMongoSource = sourceType === "mongodb";
  const baseQuery = isMongoSource
    ? { registeredEvent: event.name }
    : { eventId: event.eventId, version: event.participantSource?.excelVersion };
  const participantField = (field) => isMongoSource ? field : `row.${field}`;
  const clauses = [baseQuery];
  const allTicketPrns = ticketStatus === "NOT GENERATED"
    ? await Ticket.distinct("prn", { eventId: event.eventId })
    : null;
  const relevantTicketQuery = { eventId: event.eventId };
  if (color) relevantTicketQuery.color = color;
  if (scanStatus === "SCANNED") relevantTicketQuery.usedAt = { $ne: null };
  if (scanStatus === "NOT SCANNED" && (color || ticketStatus === "GENERATED")) relevantTicketQuery.usedAt = null;
  const relevantTicketPrns = (color || ticketStatus === "GENERATED" || scanStatus === "SCANNED" ||
    (scanStatus === "NOT SCANNED" && ticketStatus === "GENERATED"))
    ? await Ticket.distinct("prn", relevantTicketQuery)
    : null;

  if (ticketStatus === "GENERATED" || color) {
    clauses.push(prnMembership(participantField("prn"), relevantTicketPrns || []));
  } else if (ticketStatus === "NOT GENERATED") {
    clauses.push(prnMembership(participantField("prn"), allTicketPrns || [], true));
  }
  if (scanStatus === "SCANNED") {
    clauses.push(prnMembership(participantField("prn"), relevantTicketPrns || []));
  } else if (scanStatus === "NOT SCANNED") {
    if (color || ticketStatus === "GENERATED") {
      clauses.push(prnMembership(participantField("prn"), relevantTicketPrns || []));
    } else {
      const scannedPrns = await Ticket.distinct("prn", { eventId: event.eventId, usedAt: { $ne: null } });
      clauses.push(prnMembership(participantField("prn"), scannedPrns, true));
    }
  }

  if (emailStatus) {
    const participantEmails = isMongoSource
      ? await User.distinct("email", baseQuery)
      : await EventParticipant.distinct("row.email", baseQuery);
    const states = await latestEmailStates(event);
    const matchingEmails = participantEmails.map(normalized).filter((email) =>
      (states.get(email)?.status || "NOT SENT") === emailStatus
    );
    clauses.push({ [participantField("email")]: { $in: matchingEmails } });
  }

  const queryText = String(search || "").trim();
  if (queryText) {
    const expression = new RegExp(escapeRegex(queryText), "i");
    const matchingTickets = await Ticket.find(
      { eventId: event.eventId, ticketId: expression },
      { prn: 1 }
    ).lean();
    const alternatives = ["name", "email", "prn"].map((field) => ({
      [participantField(field)]: expression,
    }));
    const ticketPrns = [...new Set(matchingTickets.map((ticket) => ticket.prn))];
    if (ticketPrns.length) alternatives.push(prnMembership(participantField("prn"), ticketPrns));
    clauses.push({ $or: alternatives });
  }

  const query = { $and: clauses };
  const [total, sourceRows] = isMongoSource
    ? await Promise.all([
      User.countDocuments(query),
      User.find(query).sort({ name: 1, _id: 1 }).skip((page - 1) * limit).limit(limit).lean(),
    ])
    : await Promise.all([
      EventParticipant.countDocuments(query),
      EventParticipant.find(query).sort({ index: 1 }).skip((page - 1) * limit).limit(limit).select("row").lean(),
    ]);
  const mappings = event.fieldMappings instanceof Map
    ? Object.fromEntries(event.fieldMappings.entries())
    : event.fieldMappings || {};
  const participants = sourceRows.map((sourceRow) => {
    const participant = isMongoSource
      ? mapParticipant({
        name: sourceRow.name,
        email: sourceRow.email,
        prn: sourceRow.prn || "",
        ticketType: sourceRow.ticketType,
      }, mappings)
      : mapStoredExcelRow(sourceRow.row, mappings);
    return {
      key: `${isMongoSource ? "user" : "excel"}:${sourceRow._id}`,
      sourceId: String(sourceRow._id),
      participant,
    };
  });
  return { rows: await joinTrackingRows(event, participants), total };
}

function filterRows(rows, search, ticketStatus, emailStatus, color, scanStatus) {
  const query = normalized(search);
  const expression = query ? new RegExp(escapeRegex(query), "i") : null;
  return rows.filter((row) => {
    if (expression && ![row.name, row.prn, row.email, row.ticketId].some((value) => expression.test(String(value || "")))) return false;
    if (ticketStatus && row.ticketStatus !== ticketStatus) return false;
    if (emailStatus && row.emailStatus !== emailStatus) return false;
    if (color && row.color !== color) return false;
    if (scanStatus === "SCANNED" && !row.scanned) return false;
    if (scanStatus === "NOT SCANNED" && row.scanned) return false;
    return true;
  });
}

function csvCell(value) {
  let text = value instanceof Date ? value.toISOString() : String(value ?? "");
  if (/^\s*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function toCsv(rows) {
  const columns = [
    ["Name", "name"],
    ["PRN", "prn"],
    ["Email", "email"],
    ["Ticket ID", "ticketId"],
    ["Color", "color"],
    ["Ticket Status", "ticketStatus"],
    ["Email Status", "emailStatus"],
    ["Sent At", "sentAt"],
    ["Scanned", "scanned"],
    ["Scanned At", "scannedAt"],
  ];
  return [
    columns.map(([label]) => csvCell(label)).join(","),
    ...rows.map((row) => columns.map(([, key]) => csvCell(key === "scanned" ? (row[key] ? "Yes" : "No") : row[key])).join(",")),
  ].join("\r\n");
}

function safeCounts(rows) {
  return {
    totalParticipants: rows.length,
    ticketsGenerated: rows.filter((row) => row.ticketStatus === "GENERATED").length,
    ticketsSent: rows.filter((row) => row.emailStatus === "SENT").length,
    redTickets: rows.filter((row) => row.color === "red").length,
    blueTickets: rows.filter((row) => row.color === "blue").length,
    scanned: rows.filter((row) => row.scanned).length,
    notScanned: rows.filter((row) => !row.scanned).length,
    failed: rows.filter((row) => row.emailStatus === "FAILED").length,
  };
}

async function loadEvent(eventId) {
  return Event.findOne({ eventId: String(eventId || "").trim().toLowerCase() });
}

export async function GET(req, { params }) {
  const { response } = await requireAdmin(req);
  if (response) return response;
  await dbConnect();
  const { eventId } = await params;
  const event = await loadEvent(eventId);
  if (!event) return NextResponse.json({ message: "Event not found." }, { status: 404 });

  try {
    const url = new URL(req.url);
    const page = Math.max(1, Number.parseInt(url.searchParams.get("page") || "1", 10) || 1);
    const requestedLimit = Number.parseInt(url.searchParams.get("limit") || "20", 10);
    const limit = [20, 50, 100].includes(requestedLimit) ? requestedLimit : 20;
    const filters = {
      search: url.searchParams.get("search") || "",
      ticketStatus: url.searchParams.get("ticketStatus") || "",
      emailStatus: url.searchParams.get("emailStatus") || "",
      color: url.searchParams.get("color") || "",
      scanStatus: url.searchParams.get("scanStatus") || "",
    };

    if (url.searchParams.get("format") === "csv") {
      const rows = filterRows(await getTrackingRows(event), ...Object.values(filters));
      return new NextResponse(toCsv(rows), {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${event.eventId}-participants.csv"`,
          "Cache-Control": "no-store",
        },
      });
    }

    if (event.participantSource?.type === "googleSheets") {
      const allRows = await getTrackingRows(event);
      const filtered = filterRows(allRows, ...Object.values(filters));
      const pages = Math.max(1, Math.ceil(filtered.length / limit));
      return NextResponse.json({
        participants: filtered.slice((page - 1) * limit, page * limit),
        counts: safeCounts(allRows),
        pagination: { page, limit, total: filtered.length, pages },
      });
    }

    const [{ rows, total }, counts] = await Promise.all([
      getFilteredPage(event, { ...filters, page, limit }),
      getSummaryCounts(event),
    ]);
    const pages = Math.max(1, Math.ceil(total / limit));
    return NextResponse.json({
      participants: rows,
      counts,
      pagination: { page, limit, total, pages },
    });
  } catch (error) {
    console.error("Load event participant tracking error:", error);
    return NextResponse.json({ message: error.message || "Unable to load participant tracking." }, { status: 500 });
  }
}

export async function POST(req, { params }) {
  const { response } = await requireAdmin(req);
  if (response) return response;
  await dbConnect();
  const { eventId } = await params;
  const event = await loadEvent(eventId);
  if (!event) return NextResponse.json({ message: "Event not found." }, { status: 404 });

  try {
    const body = await req.json();
    if (body.action !== "resend") return NextResponse.json({ message: "Unsupported participant action." }, { status: 400 });
    const participantKey = String(body.participantKey || "");
    const participantRow = (await readEventParticipants(event)).find((item) => item.key === participantKey);
    if (!participantRow) return NextResponse.json({ message: "Participant does not belong to this event." }, { status: 404 });
    const participant = participantRow.participant;
    const prn = String(participant.prn || "").trim().toUpperCase();
    if (!prn) return NextResponse.json({ message: "This participant has no PRN and cannot have a ticket resent." }, { status: 409 });
    const ticket = await Ticket.findOne({ eventId: event.eventId, prn });
    if (!ticket) return NextResponse.json({ message: "Generate a ticket before resending it." }, { status: 409 });
    if (!event.emailSettings?.enabled || !event.ticketSettings?.enabled) {
      return NextResponse.json({ message: "Ticket email delivery is disabled for this event." }, { status: 409 });
    }
    const templateUrl = event.ticketTemplates?.[ticket.color] || event.ticketTemplateUrl || "";
    if (!templateUrl) return NextResponse.json({ message: `No ${ticket.color} ticket template is configured.` }, { status: 409 });
    const subject = String(event.emailTemplate?.subject || "").trim();
    const html = String(event.emailTemplate?.html || "");
    if (!subject || !html) return NextResponse.json({ message: "Configure the event email subject and body before resending." }, { status: 409 });

    const job = await OperationJob.create({
      eventId: event.eventId,
      type: "email",
      status: "PENDING",
      subject,
      html,
      templateUrl: "",
      attachmentKind: "ticket",
      recipientCount: 1,
      delayMs: Number(event.emailSettings?.delayMs ?? 1000),
      recipients: [{
        email: participant.email,
        participant,
        ticketId: ticket.ticketId,
        ticketColor: ticket.color,
        templateUrl,
        status: "PENDING",
      }],
    });
    return NextResponse.json({
      message: "Ticket resend queued.",
      job: { _id: job._id, type: job.type, status: job.status, recipientCount: job.recipientCount },
    }, { status: 201 });
  } catch (error) {
    console.error("Queue ticket resend error:", error);
    return NextResponse.json({ message: error.message || "Unable to queue ticket resend." }, { status: 500 });
  }
}

export async function DELETE(req, { params }) {
  const { response } = await requireAdmin(req);
  if (response) return response;
  await dbConnect();
  const { eventId } = await params;
  const event = await loadEvent(eventId);
  if (!event) return NextResponse.json({ message: "Event not found." }, { status: 404 });

  try {
    const body = await req.json();
    const participantKey = String(body.participantKey || "");
    const sourceParticipants = await readEventParticipants(event);
    const participantRow = sourceParticipants.find((item) => item.key === participantKey);
    if (!participantRow) return NextResponse.json({ message: "Participant does not belong to this event." }, { status: 404 });
    if (event.participantSource?.type === "googleSheets") {
      return NextResponse.json({ message: "Remove this participant from the configured Google Sheet; this source is read-only here." }, { status: 409 });
    }
    const { participant } = participantRow;
    const eventIdValue = event.eventId;
    const prn = String(participant.prn || "").trim().toUpperCase();
    const ticket = prn ? await Ticket.findOne({ eventId: eventIdValue, prn }) : null;
    const duplicateIdentity = sourceParticipants.some((item) =>
      item.key !== participantKey &&
      normalized(item.participant.email) === normalized(participant.email) &&
      (prn
        ? String(item.participant.prn || "").trim().toUpperCase() === prn
        : !String(item.participant.prn || "").trim() &&
          normalized(item.participant.name) === normalized(participant.name))
    );
    if (duplicateIdentity) {
      return NextResponse.json({ message: "This participant is ambiguous in the event source; resolve duplicate email/PRN rows before deleting." }, { status: 409 });
    }

    const recipientSelector = ticket
      ? { $or: [{ ticketId: ticket.ticketId }, { email: participant.email, "participant.prn": participant.prn }] }
      : {
        email: participant.email,
        "participant.prn": participant.prn || { $in: ["", null] },
        "participant.name": participant.name,
      };
    const session = await Event.startSession();
    try {
      await session.withTransaction(async () => {
        const currentEvent = await Event.findOne({
          _id: event._id,
          eventId: eventIdValue,
          name: event.name,
          "participantSource.type": event.participantSource?.type || "mongodb",
          ...(event.participantSource?.type === "excel"
            ? { "participantSource.excelVersion": event.participantSource?.excelVersion }
            : {}),
        }).session(session);
        if (!currentEvent) {
          throw Object.assign(new Error("Event participant source changed; reload before deleting."), { status: 409 });
        }
        const activeJob = await OperationJob.exists({
          eventId: eventIdValue,
          status: { $in: ["PENDING", "RUNNING"] },
        }).session(session);
        if (activeJob) {
          throw Object.assign(new Error("Wait for active event operations to finish before deleting a participant."), { status: 409 });
        }

        if (event.participantSource?.type === "excel") {
          const deleted = await EventParticipant.deleteOne({
            _id: participantRow.sourceId,
            eventId: eventIdValue,
            version: event.participantSource.excelVersion,
          }).session(session);
          if (!deleted.deletedCount) {
            throw Object.assign(new Error("Participant record was not found for this event."), { status: 404 });
          }
        } else {
          const result = await User.updateOne(
            { _id: participantRow.sourceId, registeredEvent: event.name },
            { $pull: { registeredEvent: event.name } },
            { session }
          );
          if (!result.modifiedCount) {
            throw Object.assign(new Error("Participant is no longer registered for this event."), { status: 404 });
          }
        }
        if (ticket) await Ticket.deleteOne({ _id: ticket._id, eventId: eventIdValue }).session(session);
        await OperationJob.updateMany(
          { eventId: eventIdValue },
          { $pull: { recipients: recipientSelector } },
          { session }
        );
        await OperationJob.updateMany(
          { eventId: eventIdValue },
          [
            {
              $set: {
                recipientCount: { $size: "$recipients" },
                successfulCount: { $size: { $filter: { input: "$recipients", as: "recipient", cond: { $eq: ["$$recipient.status", "SENT"] } } } },
                failedCount: { $size: { $filter: { input: "$recipients", as: "recipient", cond: { $eq: ["$$recipient.status", "FAILED"] } } } },
                nextIndex: { $min: ["$nextIndex", { $size: "$recipients" }] },
              },
            },
            {
              $set: {
                processedCount: { $add: ["$successfulCount", "$failedCount"] },
                status: {
                  $cond: [
                    { $gte: ["$nextIndex", "$recipientCount"] },
                    {
                      $cond: [
                        { $gt: ["$failedCount", 0] },
                        { $cond: [{ $gt: ["$successfulCount", 0] }, "PARTIAL", "FAILED"] },
                        "COMPLETED",
                      ],
                    },
                    "$status",
                  ],
                },
              },
            },
          ],
          { session }
        );
      });
    } finally {
      await session.endSession();
    }
    return NextResponse.json({ message: "Participant removed from this event." });
  } catch (error) {
    if (error.status) return NextResponse.json({ message: error.message }, { status: error.status });
    console.error("Delete event participant error:", error);
    return NextResponse.json({ message: error.message || "Unable to delete participant." }, { status: 500 });
  }
}
