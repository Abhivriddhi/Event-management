import { NextResponse } from "next/server";
import nodemailer from "nodemailer";
import * as XLSX from "xlsx";
import dbConnect from "@/lib/dbConnect";
import BulkCampaign from "@/lib/models/BulkCampaign";
import { requireAdmin } from "@/lib/auth";

const VALID_EMAIL_DOMAIN = "@vit.edu";

function normalizeText(value) {
  return String(value ?? "").trim();
}

function extractValue(row, keys) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(row, key) && row[key] !== undefined && row[key] !== null) {
      const value = row[key];
      if (value !== "") {
        return value;
      }
    }
  }
  return "";
}

function normalizeMobileNo(rawValue) {
  const normalized = String(rawValue ?? "")
    .replace(/[^\d+]/g, "")
    .trim();

  if (!normalized) return "";

  if (/^\+?\d{12}$/.test(normalized)) return normalized;
  if (/^\+?\d{10}$/.test(normalized)) return normalized;
  if (/^\+?91\d{10}$/.test(normalized)) return normalized;
  if (/^\d{10}$/.test(normalized)) return normalized;

  return normalized;
}

function isValidMobile(mobileNo) {
  const cleaned = normalizeMobileNo(mobileNo);
  if (!cleaned) return false;

  const withoutCountryCode = cleaned.replace(/^\+?91/, "");
  return /^\d{10}$/.test(withoutCountryCode) && /^[6-9]/.test(withoutCountryCode);
}

function buildSmtpTransporter() {
  const emailAddress = process.env.EMAIL;
  const smtpUser = process.env.SMTP_USER || emailAddress;
  const emailPassword = process.env.EMAIL_PASSWORD;

  if (!emailAddress || !smtpUser || !emailPassword) {
    throw new Error(
      "SMTP credentials are not configured. Set EMAIL, SMTP_USER (if required), and EMAIL_PASSWORD in the environment."
    );
  }

  const smtpHost = process.env.SMTP_HOST;
  const smtpPort = Number(process.env.SMTP_PORT || 587);
  const smtpSecure = process.env.SMTP_SECURE === "true";

  if (smtpHost) {
    return nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpSecure,
      auth: { user: smtpUser, pass: emailPassword },
      tls: { rejectUnauthorized: false },
    });
  }

  const domain = emailAddress.split("@")[1]?.toLowerCase() || "";

  if (domain.includes("gmail.com")) {
    return nodemailer.createTransport({
      service: "gmail",
      auth: { user: smtpUser, pass: emailPassword },
    });
  }

  return nodemailer.createTransport({
    host: domain ? `smtp.${domain}` : "smtp.office365.com",
    port: 587,
    secure: false,
    auth: { user: smtpUser, pass: emailPassword },
    tls: { rejectUnauthorized: false },
  });
}

function renderTemplate(template, recipient, campaignName) {
  return String(template || "")
    .replace(/\{\{name\}\}/gi, recipient.name || "")
    .replace(/\{name\}/gi, recipient.name || "")
    .replace(/\{\{email\}\}/gi, recipient.email || "")
    .replace(/\{email\}/gi, recipient.email || "")
    .replace(/\{\{mobileNo\}\}/gi, recipient.mobileNo || "")
    .replace(/\{mobileNo\}/gi, recipient.mobileNo || "")
    .replace(/\{\{campaignName\}\}/gi, campaignName || "")
    .replace(/\{campaignName\}/gi, campaignName || "");
}

function parseParticipantRows(rawRows) {
  const seenEmails = new Set();
  const validParticipants = [];
  const invalidRows = [];

  rawRows.forEach((row, index) => {
    const name = normalizeText(
      extractValue(row, ["Name", "name", "NAME", "Full Name", "Student Name", "Participant Name"])
    );
    const email = normalizeText(
      extractValue(row, ["Email", "email", "EMAIL", "Email Address", "Mail", "Email ID"])
    ).toLowerCase();
    const mobileNo = normalizeText(
      extractValue(row, ["Mobile No", "MobileNo", "mobileNo", "Mobile", "Phone", "Phone Number"])
    );

    const issues = [];

    if (!name) {
      issues.push("Missing Name");
    }
    if (!email) {
      issues.push("Missing Email");
    } else if (!email.endsWith(VALID_EMAIL_DOMAIN)) {
      issues.push(`Email must end with ${VALID_EMAIL_DOMAIN}`);
    }
    if (!mobileNo) {
      issues.push("Missing Mobile No");
    } else if (!isValidMobile(mobileNo)) {
      issues.push("Invalid Mobile No");
    }

    if (email && seenEmails.has(email)) {
      issues.push("Duplicate email");
    }

    if (!issues.length) {
      seenEmails.add(email);
      validParticipants.push({
        name,
        email,
        mobileNo: normalizeMobileNo(mobileNo),
        rowNumber: index + 2,
      });
      return;
    }

    invalidRows.push({
      rowNumber: index + 2,
      name,
      email,
      mobileNo: normalizeMobileNo(mobileNo),
      issues,
    });

    if (email) {
      seenEmails.add(email);
    }
  });

  return { validParticipants, invalidRows };
}

async function processCampaignQueue(campaignId) {
  try {
    await dbConnect();

    const campaign = await BulkCampaign.findById(campaignId);
    if (!campaign) {
      return;
    }

    campaign.status = "SENDING";
    await campaign.save();

    const transporter = buildSmtpTransporter();

    for (const recipient of campaign.recipients) {
      if (recipient.status === "SENT") {
        continue;
      }

      recipient.status = "SENDING";
      recipient.attempts = (recipient.attempts || 0) + 1;
      recipient.lastError = "";
      await campaign.save();

      try {
        const personalizedSubject = renderTemplate(campaign.subject, recipient, campaign.campaignName);
        const personalizedBody = renderTemplate(campaign.body, recipient, campaign.campaignName);

        await transporter.sendMail({
          from: process.env.EMAIL,
          to: recipient.email,
          subject: personalizedSubject,
          text: personalizedBody,
          html: `<div style="font-family: Arial, sans-serif; line-height: 1.6;">${personalizedBody.replace(/\n/g, "<br />")}</div>`,
        });

        recipient.status = "SENT";
        recipient.sentAt = new Date();
        recipient.failedAt = null;
        recipient.lastError = "";
      } catch (error) {
        recipient.status = "FAILED";
        recipient.failedAt = new Date();
        recipient.lastError = error.message || "Unknown email error";
      }

      await campaign.save();
    }

    const pendingCount = campaign.recipients.filter((recipient) => recipient.status === "PENDING").length;
    const failedCount = campaign.recipients.filter((recipient) => recipient.status === "FAILED").length;
    const sentCount = campaign.recipients.filter((recipient) => recipient.status === "SENT").length;

    campaign.pendingCount = pendingCount;
    campaign.sentCount = sentCount;
    campaign.failedCount = failedCount;
    campaign.status = pendingCount > 0 ? "PENDING" : failedCount > 0 ? "FAILED" : "SENT";
    await campaign.save();
  } catch (error) {
    console.error("Bulk email processing failed:", error);

    try {
      await dbConnect();
      const campaign = await BulkCampaign.findById(campaignId);
      if (campaign) {
        campaign.status = "FAILED";
        await campaign.save();
      }
    } catch (saveError) {
      console.error("Failed to persist bulk campaign failure state:", saveError);
    }
  }
}

export async function POST(req) {
  const { response } = await requireAdmin(req);
  if (response) return response;

  try {
    const contentType = req.headers.get("content-type") || "";
    let action = "";

    if (contentType.includes("multipart/form-data")) {
      const formData = await req.formData();
      action = String(formData.get("action") || "");

      if (action === "preview") {
        const file = formData.get("file");
        if (!file) {
          return NextResponse.json({ message: "No Excel file uploaded." }, { status: 400 });
        }

        const workbook = XLSX.read(Buffer.from(await file.arrayBuffer()), { type: "buffer" });
        const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(firstSheet, { defval: "" });

        if (!Array.isArray(rows) || rows.length === 0) {
          return NextResponse.json({ message: "No rows found in the uploaded Excel file." }, { status: 400 });
        }

        const { validParticipants, invalidRows } = parseParticipantRows(rows);

        return NextResponse.json({
          success: true,
          totalRows: rows.length,
          validCount: validParticipants.length,
          invalidCount: invalidRows.length,
          validParticipants,
          invalidRows,
        });
      }
    }

    if (contentType.includes("application/json")) {
      const body = await req.json();
      action = body?.action;

      if (action === "history") {
        await dbConnect();
        const campaigns = await BulkCampaign.find({}).sort({ createdAt: -1 }).limit(20).lean();

        return NextResponse.json({
          success: true,
          campaigns: campaigns.map((campaign) => ({
            _id: campaign._id,
            campaignName: campaign.campaignName,
            subject: campaign.subject,
            status: campaign.status,
            sentCount: campaign.sentCount || 0,
            failedCount: campaign.failedCount || 0,
            pendingCount: campaign.pendingCount || 0,
            totalRecipients: campaign.totalRecipients || 0,
            createdAt: campaign.createdAt,
          })),
        });
      }

      if (action === "create") {
        const { campaignName, subject, body: emailBody, participants } = body || {};

        if (!campaignName || !subject || !emailBody || !Array.isArray(participants) || participants.length === 0) {
          return NextResponse.json({ message: "Campaign name, subject, body, and at least one valid participant are required." }, { status: 400 });
        }

        const normalizedCampaignName = normalizeText(campaignName);
        const existingCampaign = await BulkCampaign.findOne({
          campaignName: { $regex: new RegExp(`^${normalizedCampaignName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") },
        });

        if (existingCampaign) {
          return NextResponse.json({ message: "A campaign with this name already exists. Use a new campaign name to avoid duplicate sends." }, { status: 409 });
        }

        const validParticipants = participants
          .map((participant) => ({
            name: normalizeText(participant.name),
            email: normalizeText(participant.email).toLowerCase(),
            mobileNo: normalizeMobileNo(participant.mobileNo),
          }))
          .filter(
            (participant) =>
              participant.name &&
              participant.email &&
              participant.email.endsWith(VALID_EMAIL_DOMAIN) &&
              isValidMobile(participant.mobileNo)
          );

        if (!validParticipants.length) {
          return NextResponse.json({ message: "No valid participants remain after checking email and mobile number rules." }, { status: 400 });
        }

        const campaign = await BulkCampaign.create({
          campaignName: normalizedCampaignName,
          subject: normalizeText(subject),
          body: String(emailBody),
          adminEmail: admin.email,
          status: "PENDING",
          recipients: validParticipants.map((participant) => ({
            name: participant.name,
            email: participant.email,
            mobileNo: participant.mobileNo,
            status: "PENDING",
            attempts: 0,
            lastError: "",
          })),
        });

        campaign.pendingCount = campaign.recipients.length;
        campaign.totalRecipients = campaign.recipients.length;
        await campaign.save();

        setTimeout(() => {
          processCampaignQueue(campaign._id.toString());
        }, 0);

        return NextResponse.json({
          success: true,
          message: "Bulk email campaign created and queued successfully.",
          campaignId: campaign._id.toString(),
        });
      }

      if (action === "retry") {
        const { campaignId } = body || {};
        if (!campaignId) {
          return NextResponse.json({ message: "Campaign ID is required for retrying failed emails." }, { status: 400 });
        }

        const campaign = await BulkCampaign.findById(campaignId);
        if (!campaign) {
          return NextResponse.json({ message: "Campaign not found." }, { status: 404 });
        }

        let retryCount = 0;
        campaign.recipients.forEach((recipient) => {
          if (recipient.status === "FAILED") {
            recipient.status = "PENDING";
            recipient.failedAt = null;
            recipient.lastError = "";
            retryCount += 1;
          }
        });

        if (retryCount === 0) {
          return NextResponse.json({ message: "There are no failed recipients to retry." }, { status: 400 });
        }

        campaign.status = "PENDING";
        await campaign.save();

        setTimeout(() => {
          processCampaignQueue(campaign._id.toString());
        }, 0);

        return NextResponse.json({
          success: true,
          message: `${retryCount} failed recipients have been queued for retry.`,
        });
      }
    }

    return NextResponse.json({ message: "Unsupported bulk email action." }, { status: 400 });
  } catch (error) {
    console.error("Bulk email route error:", error);
    return NextResponse.json(
      { message: error.message || "Failed to process bulk email request." },
      { status: 500 }
    );
  }
}

export async function GET(req) {
  const { response } = await requireAdmin(req);
  if (response) return response;

  try {
    await dbConnect();
    const campaigns = await BulkCampaign.find({}).sort({ createdAt: -1 }).limit(20).lean();

    return NextResponse.json({
      success: true,
      campaigns: campaigns.map((campaign) => ({
        _id: campaign._id,
        campaignName: campaign.campaignName,
        subject: campaign.subject,
        status: campaign.status,
        sentCount: campaign.sentCount || 0,
        failedCount: campaign.failedCount || 0,
        pendingCount: campaign.pendingCount || 0,
        totalRecipients: campaign.totalRecipients || 0,
        createdAt: campaign.createdAt,
      })),
    });
  } catch (error) {
    return NextResponse.json({ message: "Failed to fetch campaign history." }, { status: 500 });
  }
}
