import { NextResponse } from "next/server";
import dbConnect from "@/lib/dbConnect";
import User from "@/lib/models/User";
import nodemailer from "nodemailer";
import { requireAdmin } from "@/lib/auth";

export async function POST(req) {
  const { response } = await requireAdmin(req);
  if (response) return response;
  await dbConnect();

  try {
    const formData = await req.formData();
    const ticketType = formData.get("ticketType") || "ALL";
    const event = formData.get("event") || "ALL";
    const emailSubject = formData.get("emailSubject") || "";
    const emailBody = formData.get("emailBody") || "";
    const customEmailsRaw = formData.get("customEmails") || "";
    const excelParticipantsRaw = formData.get("excelParticipants") || "";
    const saveToDatabase = formData.get("saveToDatabase") === "true";
    const attachmentFile = formData.get("attachment"); // Optional file

    if (!emailSubject.trim()) {
      return NextResponse.json({ message: "Email subject is required" }, { status: 400 });
    }
    if (!emailBody.trim()) {
      return NextResponse.json({ message: "Email body is required" }, { status: 400 });
    }

    const recipientMap = new Map();

    // 1. If Excel participants list is provided directly from frontend upload
    if (excelParticipantsRaw.trim()) {
      try {
        const parsedExcel = JSON.parse(excelParticipantsRaw);
        if (Array.isArray(parsedExcel)) {
          for (const row of parsedExcel) {
            const name =
              row.name || row.Name || row["NAME"] || row["Student Name"] || row["Full Name"] || "";
            const email =
              row.email || row.Email || row["EMAIL"] || row["Email Address"] || row["Mail"] || "";
            const prn = row.prn || row.PRN || row["Roll No"] || "";
            const tType = row.ticketType || row.TicketType || "General";
            const evt = row.registeredEvent || row.RegisteredEvent || "Abhivriddhi";

            const cleanEmail = String(email).trim().toLowerCase();
            if (cleanEmail && /\S+@\S+\.\S+/.test(cleanEmail)) {
              const cleanName = String(name).trim() || cleanEmail.split("@")[0];
              recipientMap.set(cleanEmail, {
                name: cleanName,
                email: cleanEmail,
                prn: String(prn).trim(),
                ticketType: String(tType).trim(),
                registeredEvent: String(evt).trim(),
              });

              // Save to MongoDB if requested
              if (saveToDatabase) {
                User.findOneAndUpdate(
                  { email: cleanEmail },
                  {
                    $set: {
                      name: cleanName,
                      prn: String(prn).trim(),
                      ticketType: String(tType).trim(),
                      registeredEvent: [String(evt).trim()],
                      id: cleanEmail,
                    },
                  },
                  { upsert: true }
                ).catch((e) => console.error("Mongo upsert error:", e));
              }
            }
          }
        }
      } catch (err) {
        console.error("Error parsing excelParticipants:", err);
      }
    }

    // 2. If no Excel list provided or in addition, query MongoDB
    if (recipientMap.size === 0) {
      const query = {};
      if (ticketType !== "ALL") query.ticketType = ticketType;
      if (event !== "ALL") query.registeredEvent = event;

      const dbUsers = await User.find(query, {
        name: 1,
        email: 1,
        prn: 1,
        ticketType: 1,
        registeredEvent: 1,
      }).lean();

      for (const u of dbUsers) {
        if (u.email && u.email.trim()) {
          recipientMap.set(u.email.trim().toLowerCase(), {
            name: u.name || "Participant",
            email: u.email.trim(),
            prn: u.prn || "",
            ticketType: u.ticketType || "General",
            registeredEvent: Array.isArray(u.registeredEvent)
              ? u.registeredEvent.join(", ")
              : u.registeredEvent || event,
          });
        }
      }
    }

    // 3. Add any custom manual emails
    if (customEmailsRaw.trim()) {
      const extraList = customEmailsRaw
        .split(/[\n,;]+/)
        .map((e) => e.trim())
        .filter((e) => e.length > 0 && /\S+@\S+\.\S+/.test(e));

      for (const rawEmail of extraList) {
        const lower = rawEmail.toLowerCase();
        if (!recipientMap.has(lower)) {
          recipientMap.set(lower, {
            name: "Recipient",
            email: rawEmail,
            prn: "",
            ticketType: "General",
            registeredEvent: "Abhivriddhi",
          });
        }
      }
    }

    const recipients = Array.from(recipientMap.values());

    if (recipients.length === 0) {
      return NextResponse.json(
        { message: "No valid participants found. Please upload an Excel sheet or select registered users." },
        { status: 400 }
      );
    }

    // 4. Process optional attachment buffer
    let attachmentObj = null;
    if (attachmentFile && typeof attachmentFile.arrayBuffer === "function") {
      const arrayBuffer = await attachmentFile.arrayBuffer();
      attachmentObj = {
        filename: attachmentFile.name || "attachment",
        content: Buffer.from(arrayBuffer),
        contentType: attachmentFile.type || "application/octet-stream",
      };
    }

    // 5. Setup Nodemailer Transporter
    const isPlaceholder =
      !process.env.EMAIL ||
      process.env.EMAIL === "your_email@gmail.com" ||
      !process.env.EMAIL_PASSWORD ||
      process.env.EMAIL_PASSWORD === "your_app_password_here";

    let transporter = null;
    if (!isPlaceholder) {
      const emailDomain = process.env.EMAIL.split("@")[1]?.toLowerCase() || "";

      const smtpUser = process.env.SMTP_USER || process.env.EMAIL;
      // Custom SMTP config via env vars takes priority
      if (process.env.SMTP_HOST) {
        transporter = nodemailer.createTransport({
          host: process.env.SMTP_HOST,
          port: parseInt(process.env.SMTP_PORT || "587"),
          secure: process.env.SMTP_SECURE === "true",
          auth: {
            user: smtpUser,
            pass: process.env.EMAIL_PASSWORD,
          },
          tls: { rejectUnauthorized: false },
        });
      } else if (emailDomain.includes("gmail.com")) {
        transporter = nodemailer.createTransport({
          service: "gmail",
          auth: {
            user: smtpUser,
            pass: process.env.EMAIL_PASSWORD,
          },
        });
      } else if (
        emailDomain.includes("outlook.com") ||
        emailDomain.includes("hotmail.com") ||
        emailDomain.includes("live.com") ||
        emailDomain.endsWith(".ac.in") ||
        emailDomain.endsWith(".edu.in") ||
        emailDomain.endsWith(".edu")
      ) {
        // Most Indian college emails (.ac.in) use Office 365 / Outlook
        transporter = nodemailer.createTransport({
          host: "smtp.office365.com",
          port: 587,
          secure: false,
          auth: {
            user: process.env.EMAIL,
            pass: process.env.EMAIL_PASSWORD,
          },
          tls: { rejectUnauthorized: false },
        });
      } else {
        // Generic fallback — try common SMTP on port 587
        transporter = nodemailer.createTransport({
          host: `smtp.${emailDomain}`,
          port: 587,
          secure: false,
          auth: {
            user: process.env.EMAIL,
            pass: process.env.EMAIL_PASSWORD,
          },
          tls: { rejectUnauthorized: false },
        });
      }
    }

    // 6. Stream response via SSE
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const send = (data) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        };

        let sent = 0;
        let failed = 0;
        const failedList = [];
        const total = recipients.length;

        send({ type: "total", total, devMode: isPlaceholder, senderEmail: process.env.EMAIL });

        for (const recipient of recipients) {
          try {
            // Personalize subject & body
            const personalizedSubject = emailSubject
              .replace(/{name}/g, recipient.name)
              .replace(/{email}/g, recipient.email)
              .replace(/{prn}/g, recipient.prn)
              .replace(/{ticketType}/g, recipient.ticketType)
              .replace(/{event}/g, recipient.registeredEvent);

            const personalizedBody = emailBody
              .replace(/{name}/g, recipient.name)
              .replace(/{email}/g, recipient.email)
              .replace(/{prn}/g, recipient.prn)
              .replace(/{ticketType}/g, recipient.ticketType)
              .replace(/{event}/g, recipient.registeredEvent);

            if (isPlaceholder) {
              console.log(`[Dev Simulation] To: ${recipient.email} | Subj: ${personalizedSubject}`);
              await new Promise((r) => setTimeout(r, 60));
            } else {
              const mailOptions = {
                from: `"Abhivriddhi" <${process.env.SENDER_EMAIL || process.env.EMAIL}>`,
                to: recipient.email,
                subject: personalizedSubject,
                html: `
                  <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #222222; max-width: 600px; margin: 0 auto; padding: 24px; border: 1px solid #e0e0e0; border-radius: 8px;">
                    <div style="border-bottom: 2px solid #b8cc8a; padding-bottom: 12px; margin-bottom: 20px;">
                      <h2 style="color: #111111; margin: 0; font-size: 20px;">Abhivriddhi</h2>
                    </div>
                    <div style="font-size: 15px; color: #333333; line-height: 1.7;">
                      ${personalizedBody.replace(/\n/g, "<br />")}
                    </div>
                    <div style="margin-top: 32px; padding-top: 16px; border-top: 1px solid #eeeeee; font-size: 12px; color: #888888;">
                      Sent via Abhivriddhi · Vishwakarma Institute of Information Technology, Pune
                    </div>
                  </div>
                `,
              };

              if (attachmentObj) {
                mailOptions.attachments = [attachmentObj];
              }

              await transporter.sendMail(mailOptions);
            }

            sent++;
            send({
              type: "progress",
              sent,
              failed,
              total,
              email: recipient.email,
              name: recipient.name,
              status: "success",
            });
          } catch (err) {
            console.error(`Failed sending to ${recipient.email}:`, err.message);
            failed++;
            failedList.push({ email: recipient.email, name: recipient.name, reason: err.message });
            send({
              type: "progress",
              sent,
              failed,
              total,
              email: recipient.email,
              name: recipient.name,
              status: "failed",
              reason: err.message,
            });
          }
        }

        send({ type: "done", sent, failed, total, failedList, devMode: isPlaceholder });
        controller.close();
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (error) {
    console.error("Error in send-email-stream:", error);
    return NextResponse.json({ message: `Error: ${error.message}` }, { status: 500 });
  }
}
