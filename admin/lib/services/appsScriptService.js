export async function generatePdfWithAppsScript({
  templateUrl,
  context,
  qrPlaceholder = "",
  requireTicketId = true,
}) {
  const url =
    process.env.GOOGLE_APPS_SCRIPT_URL;

  const secret =
    process.env.GOOGLE_APPS_SCRIPT_SECRET;

  if (!url) {
    throw new Error(
      "GOOGLE_APPS_SCRIPT_URL is not configured."
    );
  }

  if (!secret) {
    throw new Error(
      "GOOGLE_APPS_SCRIPT_SECRET is not configured."
    );
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      secret,
      templateUrl,
      context,
      qrPlaceholder,
      requireTicketId,
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });

  let result;

  try {
    result = await response.json();
  } catch {
    const error = new Error(
      `Apps Script returned an invalid response. HTTP ${response.status}.`
    );
    error.status = response.status;
    error.retryAfter = response.headers.get("retry-after") || "";
    throw error;
  }

  if (!response.ok || !result.ok) {
    const error = new Error(
      result.error ||
        `Apps Script request failed with status ${response.status}.`
    );
    error.status = response.status;
    error.retryAfter = response.headers.get("retry-after") || "";
    error.retryAfterMs = Number(result.retryAfterMs) || 0;
    error.retryable = result.retryable === true;
    throw error;
  }

  if (!result.pdfBase64) {
    throw new Error(
      "Apps Script returned no PDF."
    );
  }

  return {
    pdf: Buffer.from(
      result.pdfBase64,
      "base64"
    ),
    fileName:
      result.fileName ||
      "ticket.pdf",
  };
}