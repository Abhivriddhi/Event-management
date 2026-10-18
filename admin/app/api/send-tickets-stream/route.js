import { NextResponse } from "next/server";
import dbConnect from "@/lib/dbConnect";
import User from "@/lib/models/User";
import nodemailer from "nodemailer";
import sharp from "sharp";
import { requireAdmin } from "@/lib/auth";

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

  const formData = await req.formData();
  const ticketType = formData.get("ticketType");
  const event = formData.get("event");
  const qrX = parseInt(formData.get("qrX"));
  const qrY = parseInt(formData.get("qrY"));
  const qrSize = parseInt(formData.get("qrSize"));
  const emailSubject = formData.get("emailSubject");
  const emailBody = formData.get("emailBody");
  const ticketFile = formData.get("ticketFile");

  if (!ticketFile) {
    return NextResponse.json({ message: "Ticket file is required" }, { status: 400 });
  }

  const ticketBuffer = Buffer.from(await ticketFile.arrayBuffer());

  const query = {};
  if (ticketType !== "ALL") query.ticketType = ticketType;
  if (event !== "ALL") query.registeredEvent = event;
  const users = await User.find(query).lean();

  if (users.length === 0) {
    return NextResponse.json({ message: "No users found matching the selected filters." }, { status: 400 });
  }

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: process.env.EMAIL, pass: process.env.EMAIL_PASSWORD },
  });

  // SSE stream
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      let sent = 0;
      let failed = 0;
      const failedList = [];
      const total = users.length;

      send({ type: "total", total });

      for (const user of users) {
        try {
          const qrData = `Name:${user.name}\nPRN:${user.prn || ""}\nEmail:${user.email}\nTicketType:${user.ticketType}`;
          const qrBuffer = await generateQRBuffer(qrData, qrSize);
          const ticketWithQR = await sharp(ticketBuffer)
            .composite([{ input: await sharp(qrBuffer).resize(qrSize, qrSize).toBuffer(), left: qrX, top: qrY }])
            .png().toBuffer();

          const personalizedBody = emailBody
            .replace(/{name}/g, user.name)
            .replace(/{event}/g, event === "ALL" ? user.registeredEvent?.join(", ") : event)
            .replace(/{ticketType}/g, user.ticketType);

          await transporter.sendMail({
            from: process.env.EMAIL,
            to: user.email,
            subject: emailSubject,
            html: personalizedBody.replace(/\n/g, "<br>"),
            attachments: [{ filename: "ticket.png", content: ticketWithQR, contentType: "image/png" }],
          });

          sent++;
          send({ type: "progress", sent, failed, total, email: user.email, status: "success" });
        } catch (err) {
          failed++;
          failedList.push({ email: user.email, reason: err.message });
          send({ type: "progress", sent, failed, total, email: user.email, status: "failed", reason: err.message });
        }
      }

      send({ type: "done", sent, failed, total, failedList });
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}
