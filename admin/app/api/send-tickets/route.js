import { NextResponse } from "next/server";
import dbConnect from "@/lib/dbConnect";
import User from "@/lib/models/User";
import nodemailer from "nodemailer";
import sharp from "sharp";
import { requireAdmin } from "@/lib/auth";

const BATCH_SIZE = 10;

async function generateQRBuffer(qrData, size) {
  const url = `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encodeURIComponent(qrData)}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`QR code generation failed (${response.status}).`);
  return Buffer.from(await response.arrayBuffer());
}

function getBatchIndex(value) {
  const batchIndex = Number(value ?? 0);
  if (!Number.isInteger(batchIndex) || batchIndex < 0) {
    const error = new Error("Batch index must be a non-negative integer.");
    error.status = 400;
    throw error;
  }
  return batchIndex;
}

function parseEmails(value, fieldName) {
  if (value == null) return null;

  let emails;
  try {
    emails = JSON.parse(value);
  } catch {
    const error = new Error(`${fieldName} must be a valid email list.`);
    error.status = 400;
    throw error;
  }

  if (!Array.isArray(emails) || emails.some((email) => typeof email !== "string" || !email.trim())) {
    const error = new Error(`${fieldName} must contain only valid email addresses.`);
    error.status = 400;
    throw error;
  }
  return [...new Set(emails.map((email) => email.trim().toLowerCase()))];
}

function getRetryEmails(value) {
  const emails = parseEmails(value, "Retry recipients");
  if (emails && (emails.length === 0 || emails.length > BATCH_SIZE)) {
    const error = new Error(`Retry between 1 and ${BATCH_SIZE} confirmed failed recipients at a time.`);
    error.status = 400;
    throw error;
  }
  return emails;
}

export async function POST(req) {
  const { response: authResponse } = await requireAdmin(req);
  if (authResponse) return authResponse;

  try {
    await dbConnect();
    const formData = await req.formData();
    const ticketType = String(formData.get("ticketType") || "ALL");
    const event = String(formData.get("event") || "ALL");
    const qrX = Number.parseInt(formData.get("qrX"), 10);
    const qrY = Number.parseInt(formData.get("qrY"), 10);
    const qrSize = Number.parseInt(formData.get("qrSize"), 10);
    const emailSubject = String(formData.get("emailSubject") || "");
    const emailBody = String(formData.get("emailBody") || "");
    const ticketFile = formData.get("ticketFile");

    if (!ticketFile || typeof ticketFile.arrayBuffer !== "function") {
      return NextResponse.json({ message: "Ticket file is required." }, { status: 400 });
    }
    if (![qrX, qrY, qrSize].every(Number.isFinite) || qrX < 0 || qrY < 0 || qrSize <= 0) {
      return NextResponse.json({ message: "QR position and size must be valid positive numbers." }, { status: 400 });
    }

    const batchIndex = getBatchIndex(formData.get("batchIndex"));
    const retryEmails = getRetryEmails(formData.get("retryEmails"));
    const attemptedEmails = parseEmails(formData.get("attemptedEmails"), "Attempted recipients");
    const query = {};
    if (ticketType !== "ALL") query.ticketType = ticketType;
    if (event !== "ALL") query.registeredEvent = event;

    const users = await User.find(query).sort({ email: 1, _id: 1 }).lean();
    if (users.length === 0) {
      return NextResponse.json({ message: "No users found matching the selected filters." }, { status: 400 });
    }

    let recipients;
    let hasMore = false;
    let nextBatchSize = 0;
    if (retryEmails) {
      const retrySet = new Set(retryEmails);
      recipients = users.filter((user) => retrySet.has(String(user.email).toLowerCase()));
      if (recipients.length !== retrySet.size) {
        return NextResponse.json({ message: "One or more retry recipients no longer match the selected filters." }, { status: 400 });
      }
    } else {
      const attemptedSet = new Set(attemptedEmails || []);
      const unattemptedRecipients = users.filter((user) => !attemptedSet.has(String(user.email).toLowerCase()));
      if (unattemptedRecipients.length === 0) {
        return NextResponse.json({ message: "There are no more recipients to send in this batch." }, { status: 400 });
      }
      recipients = unattemptedRecipients.slice(0, BATCH_SIZE);
      hasMore = unattemptedRecipients.length > recipients.length;
      nextBatchSize = Math.min(BATCH_SIZE, unattemptedRecipients.length - recipients.length);
    }

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.EMAIL,
        pass: process.env.EMAIL_PASSWORD,
      },
    });
    const ticketImage = Buffer.from(await ticketFile.arrayBuffer());
    const outcomes = [];

    for (const user of recipients) {
      try {
        const qrData = `Name:${user.name}\nPRN:${user.prn || ""}\nEmail:${user.email}\nTicketType:${user.ticketType}`;
        const qrBuffer = await generateQRBuffer(qrData, qrSize);
        const ticketWithQR = await sharp(ticketImage)
          .composite([{
            input: await sharp(qrBuffer).resize(qrSize, qrSize).toBuffer(),
            left: qrX,
            top: qrY,
          }])
          .png()
          .toBuffer();
        const personalizedBody = emailBody
          .replace(/{name}/g, user.name)
          .replace(/{event}/g, event === "ALL" ? user.registeredEvent?.join(", ") || "" : event)
          .replace(/{ticketType}/g, user.ticketType);

        await transporter.sendMail({
          from: process.env.EMAIL,
          to: user.email,
          subject: emailSubject,
          html: personalizedBody.replace(/\n/g, "<br>"),
          attachments: [{
            filename: "ticket.png",
            content: ticketWithQR,
            contentType: "image/png",
          }],
        });
        outcomes.push({ email: user.email, status: "success" });
      } catch (error) {
        console.error(`Failed to send ticket to ${user.email}:`, error.message);
        outcomes.push({ email: user.email, status: "failed", reason: error.message });
      }
    }

    const sent = outcomes.filter((recipient) => recipient.status === "success").length;
    const failed = outcomes.length - sent;
    return NextResponse.json({
      message: `Batch complete. Sent: ${sent}, Failed: ${failed}.`,
      sent,
      failed,
      totalRecipients: users.length,
      batchIndex,
      nextBatchIndex: retryEmails ? batchIndex : batchIndex + 1,
      hasMore,
      nextBatchSize,
      retried: Boolean(retryEmails),
      recipients: outcomes,
    });
  } catch (error) {
    console.error("Error in send-tickets:", error);
    return NextResponse.json(
      { message: error.message || "Unable to send tickets." },
      { status: error.status || 500 }
    );
  }
}
