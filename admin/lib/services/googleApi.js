import crypto from "crypto";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_REQUEST_TIMEOUT_MS = 10_000;
let cachedAccessToken = null;
let cachedTokenExpiresAt = 0;

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function getServiceAccount() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not configured.");

  let account;
  try {
    account = JSON.parse(raw);
  } catch (error) {
    throw new Error(`GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON: ${error.message}`);
  }
  if (!account.client_email || !account.private_key) {
    throw new Error("Google service-account JSON must include client_email and private_key.");
  }
  return account;
}

async function getAccessToken() {
  if (cachedAccessToken && Date.now() < cachedTokenExpiresAt - 60_000) return cachedAccessToken;

  const account = getServiceAccount();
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = base64url(JSON.stringify({
    iss: account.client_email,
    scope: [
      "https://www.googleapis.com/auth/drive",
      "https://www.googleapis.com/auth/presentations",
      "https://www.googleapis.com/auth/spreadsheets.readonly",
    ].join(" "),
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  }));
  const unsigned = `${header}.${claim}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const assertion = `${unsigned}.${signer.sign(account.private_key, "base64url")}`;

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(GOOGLE_REQUEST_TIMEOUT_MS),
  });
  const result = await response.json();
  if (!response.ok || !result.access_token) {
    throw new Error(`Google authentication failed: ${result.error_description || result.error || response.statusText}`);
  }
  cachedAccessToken = result.access_token;
  cachedTokenExpiresAt = Date.now() + (Number(result.expires_in) || 3600) * 1000;
  return cachedAccessToken;
}

export async function googleRequest(url, options = {}) {
  const accessToken = await getAccessToken();
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(options.headers || {}),
    },
    cache: "no-store",
    signal: AbortSignal.timeout(GOOGLE_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    const details = await response.text();
    const error = new Error(`Google API ${response.status}: ${details.slice(0, 500)}`);
    error.status = response.status;
    error.retryAfter = response.headers.get("retry-after") || "";
    throw error;
  }
  return response;
}

export function extractGoogleId(url, resourceName) {
  const value = String(url || "").trim();
  const match = value.match(new RegExp(`/${resourceName}/d/([a-zA-Z0-9_-]+)`));
  if (match) return match[1];
  if (/^[a-zA-Z0-9_-]{20,}$/.test(value)) return value;
  throw new Error(`Provide a valid Google ${resourceName === "spreadsheets" ? "Sheets" : "Slides"} URL.`);
}

export async function getSpreadsheetRows(spreadsheetUrl, worksheet = "") {
  const spreadsheetId = extractGoogleId(spreadsheetUrl, "spreadsheets");
  let sheetName = worksheet;
  const metadataResponse = await googleRequest(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=sheets(properties(sheetId,title))`
  );
  const metadata = await metadataResponse.json();
  const sheets = metadata.sheets || [];

  if (/^\d+$/.test(sheetName)) {
    sheetName = sheets.find((sheet) => String(sheet.properties.sheetId) === sheetName)?.properties.title || "";
  }
  if (!sheetName) {
    const urlGid = String(spreadsheetUrl).match(/[?&#]gid=(\d+)/)?.[1];
    sheetName = (urlGid && sheets.find((sheet) => String(sheet.properties.sheetId) === urlGid)?.properties.title)
      || sheets[0]?.properties.title;
  }
  if (!sheetName) throw new Error("The spreadsheet does not contain a readable worksheet.");

  const range = `'${sheetName.replace(/'/g, "''")}'!A:ZZ`;
  const response = await googleRequest(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`
  );
  const data = await response.json();
  const [headers = [], ...rows] = data.values || [];
  return rows
    .filter((row) => row.some((value) => String(value || "").trim()))
    .map((row) => Object.fromEntries(headers.map((header, index) => [String(header || "").trim(), row[index] ?? ""])));
}

export async function copySlidesTemplate(templateUrl, name) {
  const fileId = extractGoogleId(templateUrl, "presentation");
  const response = await googleRequest(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/copy?fields=id`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) }
  );
  return (await response.json()).id;
}

export async function getSlidesPresentation(presentationId) {
  const response = await googleRequest(
    `https://slides.googleapis.com/v1/presentations/${encodeURIComponent(presentationId)}`
  );
  return response.json();
}

export async function updateSlides(presentationId, requests) {
  if (!requests.length) return;
  await googleRequest(
    `https://slides.googleapis.com/v1/presentations/${encodeURIComponent(presentationId)}:batchUpdate`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requests }),
    }
  );
}

export async function uploadTemporaryImage(buffer, mimeType = "image/png") {
  const boundary = `admin-upload-${crypto.randomBytes(12).toString("hex")}`;
  const metadata = JSON.stringify({ name: `temporary-qr-${crypto.randomUUID()}`, mimeType });
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`),
    buffer,
    Buffer.from(`\r\n--${boundary}--`),
  ]);
  const response = await googleRequest(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id",
    {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    }
  );
  const file = await response.json();
  try {
    await googleRequest(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}/permissions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "anyone", role: "reader" }),
      }
    );
  } catch (error) {
    try {
      await deleteDriveFile(file.id);
    } catch (cleanupError) {
      throw new Error(`${error.message} Temporary QR cleanup also failed: ${cleanupError.message}`);
    }
    throw error;
  }
  return file.id;
}

export async function exportSlidesPdf(presentationId) {
  const response = await googleRequest(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(presentationId)}/export?mimeType=application%2Fpdf`
  );
  return Buffer.from(await response.arrayBuffer());
}

export async function deleteDriveFile(fileId) {
  try {
    await googleRequest(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`, {
      method: "DELETE",
    });
  } catch (error) {
    if (error.status !== 404) throw error;
  }
}
