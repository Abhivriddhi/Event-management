import { NextResponse } from "next/server";
import dbConnect from "@/lib/dbConnect";
import User from "@/lib/models/User";
import nodemailer from "nodemailer";
import sharp from "sharp";
import { requireAdmin } from "@/lib/auth";

// Fetch QR code image as buffer from qrserver API
async function generateQRBuffer(qrData, size) {
  const url = `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encodeURIComponent(qrData)}`;
  const res = await fetch(url);
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

export async function POST(req) {
  const { response } = await requireAdmin(req);
  if (response) return response;
  await dbConnect();

  try {
    const formData = await req.formData();

    const ticketType = formData.get("ticketType");
    const event = formData.get("event");
    const qrX = parseInt(formData.get("qrX"));
    const qrY = parseInt(formData.get("qrY"));
    const qrSize = parseInt(formData.get("qrSize"));
    const emailSubject = formData.get("emailSubject");
    const emailBody = formData.get("emailBody");
    const ticketFile = formData.get("ticketFile"); // File object

    if (!ticketFile) {
      return NextResponse.json({ message: "Ticket file is required" }, { status: 400 });
    }

    // Read ticket image as buffer
    const ticketArrayBuffer = await ticketFile.arrayBuffer();
    const ticketBuffer = Buffer.from(ticketArrayBuffer);

    // Build user query
    const query = {};
    if (ticketType !== "ALL") query.ticketType = ticketType;
    if (event !== "ALL") query.registeredEvent = event;

    const users = await User.find(query).lean();

    if (users.length === 0) {
      return NextResponse.json({ message: "No users found matching the selected filters." }, { status: 400 });
    }

    // Setup nodemailer transporter
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.EMAIL,
        pass: process.env.EMAIL_PASSWORD,
      },
    });

    let sent = 0;
    let failed = 0;
    const errors = [];

    for (const user of users) {
      try {
        // Build QR data string (same formula as Python script)
        const qrData = `Name:${user.name}\nPRN:${user.prn || ""}\nEmail:${user.email}\nTicketType:${user.ticketType}`;

        // Generate QR code buffer
        const qrBuffer = await generateQRBuffer(qrData, qrSize);

        // Place QR on ticket using sharp
        const ticketWithQR = await sharp(ticketBuffer)
          .composite([{
            input: await sharp(qrBuffer).resize(qrSize, qrSize).toBuffer(),
            left: qrX,
            top: qrY,
          }])
          .png()
          .toBuffer();

        // Replace placeholders in email body
        const personalizedBody = emailBody
          .replace(/{name}/g, user.name)
          .replace(/{event}/g, event === "ALL" ? user.registeredEvent?.join(", ") : event)
          .replace(/{ticketType}/g, user.ticketType);

        // Send email
        await transporter.sendMail({
          from: process.env.EMAIL,
          to: user.email,
          subject: emailSubject,
          html: personalizedBody.replace(/\n/g, "<br>"),
          attachments: [
            {
              filename: "ticket.png",
              content: ticketWithQR,
              contentType: "image/png",
            },
          ],
        });

        sent++;
      } catch (err) {
        failed++;
        errors.push(`${user.email}: ${err.message}`);
        console.error(`Failed to send to ${user.email}:`, err.message);
      }
    }

    return NextResponse.json({
      message: `Done! Sent: ${sent}, Failed: ${failed}`,
      sent,
      failed,
      errors,
    });

  } catch (error) {
    console.error("Error in send-tickets:", error);
    return NextResponse.json({ message: `Error: ${error.message}` }, { status: 500 });
  }
}
