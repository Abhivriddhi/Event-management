import { NextResponse } from "next/server";
import dbConnect from "@/lib/dbConnect";
import { requireAdmin } from "@/lib/auth";
import { createLegacyTicketJob } from "@/lib/services/jobService";
import { DEFAULT_BATCH_SIZE, parseBatchSize } from "@/lib/services/jobQueueUtils";

export async function POST(req) {
  const { response } = await requireAdmin(req);
  if (response) return response;
  await dbConnect();

  try {
    const formData = await req.formData();
    const ticketFile = formData.get("ticketFile");
    if (!ticketFile || typeof ticketFile.arrayBuffer !== "function") {
      return NextResponse.json({ message: "Ticket file is required." }, { status: 400 });
    }
    const idempotencyKey = String(formData.get("idempotencyKey") || "").trim();
    if (!idempotencyKey || idempotencyKey.length > 100) {
      return NextResponse.json({ message: "A valid request id is required." }, { status: 400 });
    }

    const batchSize = parseBatchSize(formData.get("batchSize") || DEFAULT_BATCH_SIZE);
    const [qrX, qrY, qrSize] = ["qrX", "qrY", "qrSize"].map((key) => Number(formData.get(key)));
    const ticketImage = Buffer.from(await ticketFile.arrayBuffer());
    const job = await createLegacyTicketJob({
      ticketType: String(formData.get("ticketType") || "ALL"),
      eventFilter: String(formData.get("event") || "ALL"),
      qrX,
      qrY,
      qrSize,
      subject: String(formData.get("emailSubject") || ""),
      body: String(formData.get("emailBody") || ""),
      ticketImage,
      imageType: ticketFile.type,
      batchSize,
      idempotencyKey,
    });
    return NextResponse.json({
      message: "Ticket sending job queued.",
      job: {
        _id: job._id,
        type: job.type,
        status: job.status,
        recipientCount: job.recipientCount,
        batchSize: job.batchSize,
        processedCount: job.processedCount,
        successfulCount: job.successfulCount,
        failedCount: job.failedCount,
        pendingCount: job.pendingCount,
        processingCount: job.processingCount,
        unknownCount: job.unknownCount,
      },
    }, { status: 201 });
  } catch (error) {
    console.error("Create ticket sending job failed:", error?.name || "unknown error");
    return NextResponse.json({ message: error.message || "Unable to queue ticket sending." }, { status: 400 });
  }
}
