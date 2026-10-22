import nodemailer from "nodemailer";
import EmailRateLimit from "@/lib/models/EmailRateLimit";
import EmailUsage from "@/lib/models/EmailUsage";
import { renderTemplate } from "@/lib/services/templateEngine";

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderHtmlTemplate(template, context) {
  return String(template || "").replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (token, path) => {
    const value = path.split(".").reduce((current, key) => current?.[key], context);
    if (value === undefined || value === null) throw new Error(`Missing email template value: ${path}`);
    return escapeHtml(value);
  });
}

let cachedTransporter;
let cachedTransporterConfig;
function getTransporter() {
  const email = process.env.EMAIL;
  const user = process.env.SMTP_USER || email;
  const password = process.env.EMAIL_PASSWORD;
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const secure = process.env.SMTP_SECURE === "true";
  const transportConfig = { user, password, host, port, secure };
  if (!email || !user || !password) {
    throw new Error("Configure EMAIL and EMAIL_PASSWORD on the server; SMTP_USER is optional.");
  }

  const configChanged = !cachedTransporterConfig
    || Object.keys(transportConfig).some((key) => cachedTransporterConfig[key] !== transportConfig[key]);
  if (!cachedTransporter || configChanged) {
    if (host) {
      cachedTransporter = nodemailer.createTransport({
        host,
        port,
        secure,
        auth: { user, pass: password },
      });
    } else {
      cachedTransporter = nodemailer.createTransport({
        service: "gmail",
        auth: { user, pass: password },
      });
    }
    cachedTransporterConfig = transportConfig;
  }
  return cachedTransporter;
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

async function reserveDailySlot(limit) {
  const dateKey = todayKey();
  const existing = await EmailUsage.findOneAndUpdate(
    { dateKey, reserved: { $lt: limit } },
    { $inc: { reserved: 1 } },
    { new: true }
  );
  if (existing) return dateKey;

  try {
    await EmailUsage.create({ dateKey, reserved: 1 });
    return dateKey;
  } catch (error) {
    if (error.code !== 11000) throw error;
    const retry = await EmailUsage.findOneAndUpdate(
      { dateKey, reserved: { $lt: limit } },
      { $inc: { reserved: 1 } },
      { new: true }
    );
    if (!retry) {
      const error = new Error(`Daily email limit of ${limit} has been reached.`);
      const nextDay = Date.parse(`${dateKey}T00:00:00.000Z`) + 86_400_000;
      error.status = 429;
      error.retryAfterMs = Math.max(0, nextDay - Date.now());
      throw error;
    }
    return dateKey;
  }
}

async function acquireGlobalRateSlot(delayMs) {
  if (delayMs <= 0) return;
  await EmailRateLimit.updateOne({ _id: "smtp" }, { $setOnInsert: { nextAllowedAt: null } }, { upsert: true });
  while (true) {
    const now = new Date();
    const lock = await EmailRateLimit.findOneAndUpdate(
      { _id: "smtp", $or: [{ nextAllowedAt: null }, { nextAllowedAt: { $lte: now } }] },
      { $set: { nextAllowedAt: new Date(now.getTime() + delayMs) } },
      { new: true }
    );
    if (lock) return;
    const current = await EmailRateLimit.findById("smtp").lean();
    const waitMs = Math.max(50, (current?.nextAllowedAt?.getTime() || Date.now()) - Date.now());
    await new Promise((resolve) => setTimeout(resolve, Math.min(waitMs, 2000)));
  }
}

export async function sendPersonalizedEmail({
  to,
  subject,
  html,
  context,
  attachments = [],
  dailyLimit,
  delayMs,
  onDeliveryStart = async () => {},
}) {
  const limit = Number(process.env.EMAIL_DAILY_LIMIT || dailyLimit || 1500);
  const delay = Number(process.env.EMAIL_DELAY_MS ?? delayMs ?? 1000);
  const dateKey = await reserveDailySlot(limit);
  try {
    await acquireGlobalRateSlot(delay);
    const renderedSubject = renderTemplate(subject, context);
    const renderedHtml = renderHtmlTemplate(html, context);
    const transporter = getTransporter();
    await onDeliveryStart();
    await transporter.sendMail({
      from: `"${process.env.EMAIL_FROM_NAME || "Abhivriddhi Admin"}" <${process.env.SENDER_EMAIL || process.env.EMAIL}>`,
      to,
      subject: renderedSubject,
      html: renderedHtml,
      attachments,
    });
  } catch (error) {
    const networkOutcomeUnknown = !error.responseCode
      && ["ECONNECTION", "ECONNRESET", "ETIMEDOUT", "ESOCKET", "UND_ERR_SOCKET"].includes(
        String(error.code || error.cause?.code || "").toUpperCase()
      );
    if (!networkOutcomeUnknown) {
      await EmailUsage.updateOne({ dateKey }, { $inc: { reserved: -1 } });
    }
    throw error;
  }
}

export async function sendTestEmail({ to, subject, html, context }) {
  const renderedSubject = renderTemplate(subject, context);
  const renderedHtml = renderHtmlTemplate(html, context);
  await getTransporter().sendMail({
    from: `"${process.env.EMAIL_FROM_NAME || "Abhivriddhi Admin"}" <${process.env.SENDER_EMAIL || process.env.EMAIL}>`,
    to,
    subject: renderedSubject,
    html: renderedHtml,
  });
}
