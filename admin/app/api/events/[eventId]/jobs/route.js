import { NextResponse } from "next/server";
import dbConnect from "@/lib/dbConnect";
import OperationJob from "@/lib/models/OperationJob";
import { requireAdmin } from "@/lib/auth";
import { createOperationJob, previewEventEmail, testEventEmail } from "@/lib/services/jobService";

export async function GET(req, { params }) {
  const { response } = await requireAdmin(req);
  if (response) return response;
  await dbConnect();
  const { eventId } = await params;
  const jobs = await OperationJob.find({ eventId: eventId.toLowerCase() })
    .sort({ createdAt: -1 })
    .limit(30)
    .select("-recipients.participant -recipients.temporaryFileIds -otherAttachment.content")
    .lean();
  return NextResponse.json({
    jobs: jobs.map((job) => ({
      ...job,
      pendingCleanupCount: (job.recipients || []).reduce(
        (count, recipient) => count + (recipient.temporaryFileIds?.length || 0),
        0
      ),
    })),
  });
}

export async function POST(req, { params }) {
  const { response } = await requireAdmin(req);
  if (response) return response;
  await dbConnect();
  const { eventId } = await params;

  try {
    const body = await req.json();
    if (body.action === "preview-email") {
      const preview = await previewEventEmail({ eventId, subject: body.subject, html: body.html });
      return NextResponse.json({ preview });
    }
    if (body.action === "test-email") {
      const to = String(body.to || "").trim();
      if (!/\S+@\S+\.\S+/.test(to)) return NextResponse.json({ message: "Enter a valid test recipient email." }, { status: 400 });
      await testEventEmail({ eventId, to, subject: body.subject, html: body.html });
      return NextResponse.json({ message: "Test email sent." });
    }

    const encodedFile = String(body.attachment?.base64 || "");
    if (encodedFile.length > 8 * 1024 * 1024) {
      return NextResponse.json({ message: "An optional attachment must be smaller than 6 MB." }, { status: 413 });
    }
    const job = await createOperationJob({
      eventId,
      type: body.type,
      subject: body.subject,
      html: body.html,
      attachmentKind: body.attachmentKind,
      otherAttachment: body.attachment
        ? {
            filename: String(body.attachment.filename || "attachment"),
            mimeType: String(body.attachment.mimeType || "application/octet-stream"),
            content: encodedFile ? Buffer.from(encodedFile, "base64") : null,
          }
        : null,
    });
    return NextResponse.json({
      message: "Operation queued.",
      job: {
        _id: job._id,
        type: job.type,
        status: job.status,
        recipientCount: job.recipientCount,
      },
    }, { status: 201 });
  } catch (error) {
    console.error("Create event operation error:", error);
    return NextResponse.json({ message: error.message || "Unable to create operation." }, { status: 400 });
  }
}
