import { NextResponse } from "next/server";
import dbConnect from "@/lib/dbConnect";
import User from "@/lib/models/User";
import * as XLSX from "xlsx";
import { requireAdmin } from "@/lib/auth";

export async function POST(req) {
  const { response } = await requireAdmin(req);
  if (response) return response;
  await dbConnect();

  try {
    const contentType = req.headers.get("content-type") || "";
    let participants = [];

    if (contentType.includes("multipart/form-data")) {
      const formData = await req.formData();
      const file = formData.get("file");

      if (!file) {
        return NextResponse.json({ message: "No file uploaded." }, { status: 400 });
      }

      const buffer = Buffer.from(await file.arrayBuffer());
      const workbook = XLSX.read(buffer, { type: "buffer" });
      const firstSheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[firstSheetName];
      const rawRows = XLSX.utils.sheet_to_json(sheet);

      participants = rawRows;
    } else {
      const body = await req.json();
      participants = body.participants || [];
    }

    if (!Array.isArray(participants) || participants.length === 0) {
      return NextResponse.json(
        { message: "No participant records found in the uploaded file." },
        { status: 400 }
      );
    }

    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    const errors = [];

    for (const row of participants) {
      try {
        // Find name and email from various common column names
        const name =
          row.name ||
          row.Name ||
          row["NAME"] ||
          row["Student Name"] ||
          row["Full Name"] ||
          row["Participant Name"] ||
          "";

        const email =
          row.email ||
          row.Email ||
          row["EMAIL"] ||
          row["Email Address"] ||
          row["Email ID"] ||
          row["Mail"] ||
          "";

        const prn =
          row.prn ||
          row.PRN ||
          row["Roll No"] ||
          row["Roll Number"] ||
          row["PRN Number"] ||
          "";

        const ticketType =
          row.ticketType ||
          row.TicketType ||
          row["Ticket Type"] ||
          row["Ticket"] ||
          "General";

        const registeredEvent =
          row.registeredEvent ||
          row.RegisteredEvent ||
          row["Event"] ||
          row["Registered Event"] ||
          "Abhivriddhi";

        const cleanEmail = String(email).trim().toLowerCase();
        const cleanName = String(name).trim();

        if (!cleanEmail || !/\S+@\S+\.\S+/.test(cleanEmail)) {
          skipped++;
          continue;
        }

        const eventsList = Array.isArray(registeredEvent)
          ? registeredEvent
          : String(registeredEvent)
              .split(/[,;]+/)
              .map((e) => e.trim())
              .filter(Boolean);

        const result = await User.findOneAndUpdate(
          { email: cleanEmail },
          {
            $set: {
              name: cleanName || cleanEmail.split("@")[0],
              prn: String(prn).trim(),
              ticketType: String(ticketType).trim(),
              registeredEvent: eventsList.length > 0 ? eventsList : ["Abhivriddhi"],
              id: cleanEmail,
            },
          },
          { upsert: true, new: false }
        );

        if (result) {
          updated++;
        } else {
          inserted++;
        }
      } catch (err) {
        skipped++;
        errors.push(err.message);
      }
    }

    const totalInDb = await User.countDocuments();

    return NextResponse.json({
      success: true,
      message: `Successfully processed ${participants.length} records (${inserted} added, ${updated} updated, ${skipped} skipped).`,
      inserted,
      updated,
      skipped,
      totalInDb,
      errors: errors.slice(0, 5),
    });
  } catch (error) {
    console.error("Error importing Excel data:", error);
    return NextResponse.json(
      { message: "Failed to process file.", error: error.message },
      { status: 500 }
    );
  }
}
