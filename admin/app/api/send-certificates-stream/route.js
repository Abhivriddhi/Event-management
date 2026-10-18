import { NextResponse } from "next/server";
import dbConnect from "@/lib/dbConnect";
import User from "@/lib/models/User";
import AttendanceDAY1 from "@/lib/models/AttendanceDAY1";
import AttendanceDAY2 from "@/lib/models/AttendanceDAY2";
import AttendanceCOMBO from "@/lib/models/AttendanceCOMBO";
import CertificateSent from "@/lib/models/CertificateSent";
import nodemailer from "nodemailer";
import sharp from "sharp";
import { requireAdmin } from "@/lib/auth";

export async function POST(req) {
  const { response } = await requireAdmin(req);
  if (response) return response;
  await dbConnect();

  const formData = await req.formData();
  const ticketType = formData.get("ticketType");
  const event = formData.get("event");
  const nameX = parseInt(formData.get("nameX"));
  const nameY = parseInt(formData.get("nameY"));
  const fontSize = parseInt(formData.get("fontSize"));
  const fontColor = formData.get("fontColor") || "#000000";
  const fontWeight = formData.get("fontWeight") || "bold";
  const fontStyleVal = formData.get("fontStyle") || "normal";
  const fontFamily = formData.get("fontFamily") || "Arial, Helvetica, sans-serif";
  const emailSubject = formData.get("emailSubject");
  const emailBody = formData.get("emailBody");
  const certFile = formData.get("certFile");

  if (!certFile) {
    return NextResponse.json({ message: "Certificate file is required" }, { status: 400 });
  }

  const certBuffer = Buffer.from(await certFile.arrayBuffer());

  const [day1, day2, combo] = await Promise.all([
    AttendanceDAY1.find({}).lean(),
    AttendanceDAY2.find({}).lean(),
    AttendanceCOMBO.find({}).lean(),
  ]);

  let allAttendance = [
    ...day1.map((r) => ({ ...r, ticketType: "DAY1" })),
    ...day2.map((r) => ({ ...r, ticketType: "DAY2" })),
    ...combo.map((r) => ({ ...r, ticketType: "COMBO" })),
  ];

  if (ticketType !== "ALL") allAttendance = allAttendance.filter((r) => r.ticketType === ticketType);
  if (event !== "ALL") allAttendance = allAttendance.filter((r) => r.registeredEvent === event);

  if (allAttendance.length === 0) {
    return NextResponse.json({ message: "No attendance records found for the selected filters." }, { status: 400 });
  }

  const allUsers = await User.find({}).lean();
  const imgMeta = await sharp(certBuffer).metadata();
  const imgWidth = imgMeta.width;
  const imgHeight = imgMeta.height;

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: process.env.EMAIL, pass: process.env.EMAIL_PASSWORD },
  });

  const hexToRgb = (hex) => ({
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  });
  const { r, g, b } = hexToRgb(fontColor);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      let sent = 0;
      let failed = 0;
      let skipped = 0;
      const failedList = [];
      const processedEmails = new Set();
      const total = allAttendance.length;

      send({ type: "total", total });

      for (const record of allAttendance) {
        try {
          let user = allUsers.find((u) => u.id === record.userId);
          if (!user) {
            const lines = record.userId?.split("\n") || [];
            const parsedData = {};
            lines.forEach((line) => {
              const [key, ...valueParts] = line.split(":");
              if (key && valueParts.length > 0) parsedData[key.trim()] = valueParts.join(":").trim();
            });
            const emailFromQR = parsedData["Email"]?.trim().toLowerCase();
            if (emailFromQR) user = allUsers.find((u) => u.email === emailFromQR);
          }

          if (!user) {
            failed++;
            failedList.push({ email: "Unknown", reason: "User not found in database" });
            send({ type: "progress", sent, failed, skipped, total, email: "Unknown", status: "failed", reason: "User not found" });
            continue;
          }

          if (processedEmails.has(user.email)) continue;
          processedEmails.add(user.email);

          const eventLabel = record.registeredEvent;
          const alreadySent = await CertificateSent.findOne({ email: user.email, registeredEvent: eventLabel });
          if (alreadySent) {
            skipped++;
            send({ type: "progress", sent, failed, skipped, total, email: user.email, status: "skipped" });
            continue;
          }

          const displayName = user.name.split(" ").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");

          const svgText = `<svg width="${imgWidth}" height="${imgHeight}" xmlns="http://www.w3.org/2000/svg">
  <text x="${nameX}" y="${nameY}" font-size="${fontSize}" font-family="${fontFamily}, Arial, sans-serif" font-weight="${fontWeight}" font-style="${fontStyleVal}" fill="rgb(${r},${g},${b})">${displayName}</text>
</svg>`;

          const certWithName = await sharp(certBuffer)
            .composite([{ input: Buffer.from(svgText), top: 0, left: 0 }])
            .png().toBuffer();

          const personalizedBody = emailBody
            .replace(/{name}/g, displayName)
            .replace(/{event}/g, eventLabel);

          await transporter.sendMail({
            from: process.env.EMAIL,
            to: user.email,
            subject: emailSubject,
            html: personalizedBody.replace(/\n/g, "<br>"),
            attachments: [{ filename: "certificate.png", content: certWithName, contentType: "image/png" }],
          });

          await CertificateSent.create({ email: user.email, registeredEvent: eventLabel });
          sent++;
          send({ type: "progress", sent, failed, skipped, total, email: user.email, status: "success" });
        } catch (err) {
          failed++;
          failedList.push({ email: record.userId?.slice(0, 30), reason: err.message });
          send({ type: "progress", sent, failed, skipped, total, email: record.userId?.slice(0, 30), status: "failed", reason: err.message });
        }
      }

      send({ type: "done", sent, failed, skipped, total, failedList });
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
