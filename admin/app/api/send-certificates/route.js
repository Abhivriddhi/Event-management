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

  try {
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

    // Read certificate image as buffer
    const certArrayBuffer = await certFile.arrayBuffer();
    const certBuffer = Buffer.from(certArrayBuffer);

    // Fetch attendance records based on filters
    const [day1, day2, combo] = await Promise.all([
      AttendanceDAY1.find({}).lean(),
      AttendanceDAY2.find({}).lean(),
      AttendanceCOMBO.find({}).lean(),
    ]);

    // Combine and tag
    let allAttendance = [
      ...day1.map((r) => ({ ...r, ticketType: "DAY1" })),
      ...day2.map((r) => ({ ...r, ticketType: "DAY2" })),
      ...combo.map((r) => ({ ...r, ticketType: "COMBO" })),
    ];

    // Filter by ticketType
    if (ticketType !== "ALL") {
      allAttendance = allAttendance.filter((r) => r.ticketType === ticketType);
    }

    // Filter by event
    if (event !== "ALL") {
      allAttendance = allAttendance.filter((r) => r.registeredEvent === event);
    }

    if (allAttendance.length === 0) {
      return NextResponse.json({ message: "No attendance records found for the selected filters." }, { status: 400 });
    }

    // Fetch all users once
    const allUsers = await User.find({}).lean();

    // Get certificate image dimensions once (same template for all)
    const imgMeta = await sharp(certBuffer).metadata();
    const imgWidth = imgMeta.width;
    const imgHeight = imgMeta.height;

    // Setup nodemailer
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.EMAIL,
        pass: process.env.EMAIL_PASSWORD,
      },
    });

    // Convert hex color to RGB for sharp
    const hexToRgb = (hex) => {
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      return { r, g, b };
    };

    const { r, g, b } = hexToRgb(fontColor);

    let sent = 0;
    let failed = 0;
    let skipped = 0;
    const errors = [];
    const processedEmails = new Set(); // prevent duplicate emails in same batch

    for (const record of allAttendance) {
      try {
        // Find user
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

        if (!user) { failed++; errors.push(`Unknown user: ${record.userId?.slice(0, 30)}`); continue; }
        if (processedEmails.has(user.email)) continue;
        processedEmails.add(user.email);

        const eventLabel = record.registeredEvent;

        // Check if certificate already sent to this user for this event
        const alreadySent = await CertificateSent.findOne({ email: user.email, registeredEvent: eventLabel });
        if (alreadySent) {
          skipped++;
          console.log(`Skipping ${user.email} - certificate already sent for ${eventLabel}`);
          continue;
        }

        // Capitalize name for certificate
        const displayName = user.name
          .split(" ")
          .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
          .join(" ");

        // Create SVG text overlay with explicit width/height matching image
        const svgText = `<svg width="${imgWidth}" height="${imgHeight}" xmlns="http://www.w3.org/2000/svg">
  <text
    x="${nameX}"
    y="${nameY}"
    font-size="${fontSize}"
    font-family="${fontFamily}, Arial, sans-serif"
    font-weight="${fontWeight}"
    font-style="${fontStyleVal}"
    fill="rgb(${r},${g},${b})"
  >${displayName}</text>
</svg>`;

        // Composite name onto certificate
        const certWithName = await sharp(certBuffer)
          .composite([{ input: Buffer.from(svgText), top: 0, left: 0 }])
          .png()
          .toBuffer();

        // Personalize email body
        const personalizedBody = emailBody
          .replace(/{name}/g, displayName)
          .replace(/{event}/g, eventLabel);

        // Send email
        await transporter.sendMail({
          from: process.env.EMAIL,
          to: user.email,
          subject: emailSubject,
          html: personalizedBody.replace(/\n/g, "<br>"),
          attachments: [
            {
              filename: "certificate.png",
              content: certWithName,
              contentType: "image/png",
            },
          ],
        });

        // Record that certificate was sent
        await CertificateSent.create({ email: user.email, registeredEvent: eventLabel });

        sent++;
      } catch (err) {
        failed++;
        errors.push(`${record.userId?.slice(0, 30)}: ${err.message}`);
        console.error("Failed to send certificate:", err.message);
      }
    }

    return NextResponse.json({
      message: `Done! Sent: ${sent}, Skipped (already sent): ${skipped}, Failed: ${failed}`,
      sent,
      skipped,
      failed,
      errors,
    });

  } catch (error) {
    console.error("Error in send-certificates:", error);
    return NextResponse.json({ message: `Error: ${error.message}` }, { status: 500 });
  }
}
