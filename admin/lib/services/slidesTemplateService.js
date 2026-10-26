import {
  generatePdfWithAppsScript,
} from "@/lib/services/appsScriptService";
import crypto from "crypto";
import QRCode from "qrcode";
import {
  copySlidesTemplate,
  deleteDriveFile,
  exportSlidesPdf,
  getSlidesPresentation,
  updateSlides,
  uploadTemporaryImage,
  extractGoogleId,
} from "@/lib/services/googleApi";
import {
  getTemplateTokens,
  renderTemplate,
} from "@/lib/services/templateEngine";

function getElementText(element) {
  return (
    element.shape?.text?.textElements
      ?.map((item) => item.textRun?.content || "")
      .join("") || ""
  );
}

function getElementAltText(element) {
  return String(
    element.title || element.description || ""
  ).trim();
}

function getQrPlaceholder(presentation, placeholder) {
  const found = [];

  for (const slide of presentation.slides || []) {
    for (const element of slide.pageElements || []) {
      const title = String(element.title || "").trim();
      const description = String(element.description || "").trim();

      // QR placeholder must be an actual image element.
      const isImage =
        Boolean(element.image) ||
        Boolean(element.shape?.shapeType === "RECTANGLE");

      const hasMarker =
        title === placeholder ||
        description === placeholder;

      if (isImage && hasMarker) {
        found.push({
          slide,
          element,
          isAltTextPlaceholder: true,
          text: "",
          altText: description || title,
        });
      }
    }
  }

  if (found.length !== 1) {
    throw new Error(
      `Expected exactly one image QR placeholder ${placeholder}, found ${found.length}.`
    );
  }

  return found[0];
}

function getPresentationText(presentation) {
  return (presentation.slides || [])
    .flatMap((slide) =>
      (slide.pageElements || []).map((element) =>
        getElementText(element)
      )
    )
    .join("\n");
}

export async function validateSlidesTemplate(
  templateUrl,
  context,
  requiredTokens,
  qrPlaceholder = ""
) {
  if (!templateUrl) {
    throw new Error("Configure a Google Slides template URL.");
  }

  const presentation = await getSlidesPresentation(
    extractGoogleId(templateUrl, "presentation")
  );

  const allText = getPresentationText(presentation);
  const tokens = getTemplateTokens(allText);

  // QR can live in shape alt text instead of visible text.
  let qrMarker = null;

  if (qrPlaceholder) {
    qrMarker = getQrPlaceholder(
      presentation,
      qrPlaceholder
    );
  }

  // ticket.qr is satisfied by the QR shape's alt text.
  const missing = requiredTokens.filter((token) => {
    if (token === "ticket.qr" && qrPlaceholder && qrMarker) {
      return false;
    }

    return !tokens.includes(token);
  });

  if (missing.length) {
    throw new Error(
      `Google Slides template is missing required placeholders: ${missing.join(
        ", "
      )}`
    );
  }

  if (
    !qrPlaceholder &&
    tokens.includes("ticket.qr")
  ) {
    throw new Error(
      "Certificate templates must not contain QR placeholders."
    );
  }

  const collectParticipantPaths = (
    value,
    prefix = "participant"
  ) => {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value)
    ) {
      return [prefix];
    }

    return Object.entries(value).flatMap(
      ([key, child]) =>
        collectParticipantPaths(
          child,
          `${prefix}.${key}`
        )
    );
  };

  const knownPaths = new Set([
    ...collectParticipantPaths(
      context.participant || {}
    ),
    "event.name",
    "ticket.id",
    "ticket.qr",
  ]);

  const unknown = tokens.filter(
    (token) => !knownPaths.has(token)
  );

  if (unknown.length) {
    throw new Error(
      `Google Slides template contains unmapped placeholders: ${[
        ...new Set(unknown),
      ].join(", ")}`
    );
  }

  // Validate all visible text placeholders.
  renderTemplate(
    tokens
      .map((token) => `{{${token}}}`)
      .join(" "),
    context,
    { strict: true }
  );

  return {
    presentationId: presentation.presentationId,
    tokens,
    presentation,
  };
}

export async function createPersonalizedPdf({
  templateUrl,
  context,
  qrPlaceholder = "",
  requireTicketId = true,
  onTemporaryFile = async () => {},
}) {
  if (!templateUrl) {
    throw new Error(
      "Configure a Google Slides template URL."
    );
  }

  const resolvedContext = requireTicketId
    ? context
    : {
        ...context,
        ticket: {
          ...context.ticket,
          id: context.ticket?.id || "",
        },
      };
  const result = await generatePdfWithAppsScript({
    templateUrl,
    context: resolvedContext,
    qrPlaceholder,
    requireTicketId,
  });

  return {
    pdf: result.pdf,
    cleanupWarnings: [],
  };
}