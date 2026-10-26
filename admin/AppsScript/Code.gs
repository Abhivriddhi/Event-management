const CONFIG = {
  SECRET_PROPERTY: "API_SECRET",
  QR_API: "https://quickchart.io/qr",
};


/**
 * Health check
 */
function doGet() {
  return jsonResponse({
    ok: true,
    service: "Abhivriddhi Ticket PDF Generator",
    status: "running",
  });
}


/**
 * Main API endpoint.
 */
function doPost(e) {
  let temporaryFile = null;

  try {
    if (!e || !e.postData || !e.postData.contents) {
      return jsonResponse({
        ok: false,
        error: "Missing request body.",
      });
    }

    const body = JSON.parse(e.postData.contents);

    validateRequest(body);

    const {
      templateUrl,
      context,
      qrPlaceholder,
    } = body;

    const templateId = extractGoogleId(templateUrl);

    /*
     * ---------------------------------------------------------
     * 1. Copy the Google Slides template
     * ---------------------------------------------------------
     */

    const templateFile =
      DriveApp.getFileById(templateId);

    const temporaryName =
      "temporary-ticket-" +
      new Date().getTime();

    temporaryFile =
      templateFile.makeCopy(temporaryName);

    const temporaryPresentationId =
      temporaryFile.getId();


    /*
     * ---------------------------------------------------------
     * 2. Open copied presentation
     * ---------------------------------------------------------
     */

    const presentation =
      SlidesApp.openById(
        temporaryPresentationId
      );


    /*
     * ---------------------------------------------------------
     * 3. Replace normal placeholders
     * ---------------------------------------------------------
     */

    replaceTemplatePlaceholders(
      presentation,
      context
    );


    /*
     * ---------------------------------------------------------
     * 4. Insert QR code
     * ---------------------------------------------------------
     */

    if (qrPlaceholder) {
      insertQrCode(
        presentation,
        qrPlaceholder,
        context.ticket.id
      );
    }


    /*
     * ---------------------------------------------------------
     * 5. Save changes
     * ---------------------------------------------------------
     */

    presentation.saveAndClose();


    /*
     * ---------------------------------------------------------
     * 6. Convert presentation to PDF
     * ---------------------------------------------------------
     */

    const pdfBlob =
      temporaryFile.getAs(
        MimeType.PDF
      );

    const pdfBase64 =
      Utilities.base64Encode(
        pdfBlob.getBytes()
      );


    /*
     * ---------------------------------------------------------
     * 7. Delete temporary Slides file
     * ---------------------------------------------------------
     */

    temporaryFile.setTrashed(true);
    temporaryFile = null;


    /*
     * ---------------------------------------------------------
     * 8. Return PDF
     * ---------------------------------------------------------
     */

    return jsonResponse({
      ok: true,
      fileName:
        temporaryName + ".pdf",
      mimeType:
        "application/pdf",
      pdfBase64: pdfBase64,
    });

  } catch (error) {

    /*
     * Always attempt cleanup if something failed.
     */

    if (temporaryFile) {
      try {
        temporaryFile.setTrashed(true);
      } catch (cleanupError) {
        // Ignore cleanup failure.
      }
    }

    const errorMessage = error.message || String(error);
    const dailyQuota = /too many times for one day|daily quota/i.test(errorMessage);
    const retryable = dailyQuota || /(?:\b429\b|\b5\d\d\b|timed?\s*out|temporarily unavailable|rate limit|too many times|internal error)/i.test(errorMessage);
    return jsonResponse({
      ok: false,
      error: errorMessage,
      retryable,
      retryAfterMs: dailyQuota ? 86_400_000 : retryable ? 60_000 : 0,
    });
  }
}


/**
 * Validate incoming request.
 */
function validateRequest(body) {

  const configuredSecret =
    PropertiesService
      .getScriptProperties()
      .getProperty(
        CONFIG.SECRET_PROPERTY
      );

  if (!configuredSecret) {
    throw new Error(
      "API secret is not configured in Apps Script."
    );
  }

  if (body.secret !== configuredSecret) {
    throw new Error(
      "Unauthorized request."
    );
  }

  if (!body.templateUrl) {
    throw new Error(
      "templateUrl is required."
    );
  }

  if (!body.context) {
    throw new Error(
      "context is required."
    );
  }

  if (
    body.requireTicketId !== false &&
    (
      !body.context.ticket ||
      !body.context.ticket.id
    )
  ) {
    throw new Error(
      "context.ticket.id is required."
    );
  }
}


/**
 * Replace all supported template placeholders.
 *
 * Example:
 *
 * {{participant.name}}
 * {{participant.email}}
 * {{participant.prn}}
 * {{event.name}}
 * {{ticket.id}}
 */
function replaceTemplatePlaceholders(
  presentation,
  context
) {

  const replacements = flattenObject(
    context
  );

  Object.keys(replacements).forEach(
    function (token) {

      const placeholder =
        "{{" + token + "}}";

      const value =
        replacements[token] == null
          ? ""
          : String(
              replacements[token]
            );

      presentation.replaceAllText(
        placeholder,
        value
      );
    }
  );
}


/**
 * Convert nested object into:
 *
 * {
 *   "participant.name": "John",
 *   "participant.email": "john@email.com",
 *   "event.name": "Engineering Unplugged",
 *   "ticket.id": "ABC123..."
 * }
 */
function flattenObject(
  value,
  prefix,
  result
) {

  result = result || {};
  prefix = prefix || "";

  if (
    value === null ||
    value === undefined
  ) {
    if (prefix) {
      result[prefix] = "";
    }

    return result;
  }

  if (
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    if (prefix) {
      result[prefix] = value;
    }

    return result;
  }

  Object.keys(value).forEach(
    function (key) {

      const nextPrefix =
        prefix
          ? prefix + "." + key
          : key;

      flattenObject(
        value[key],
        nextPrefix,
        result
      );
    }
  );

  return result;
}


/**
 * Find QR placeholder and replace it
 * with a generated QR image.
 *
 * The placeholder must be an IMAGE
 * whose title or description contains:
 *
 * {{ticket.qr}}
 */
function insertQrCode(
  presentation,
  qrPlaceholder,
  ticketId
) {
  const slides =
    presentation.getSlides();

  let placeholder = null;

  for (
    let slideIndex = 0;
    slideIndex < slides.length;
    slideIndex++
  ) {
    const slide = slides[slideIndex];

    const elements =
      slide.getPageElements();

    for (
      let elementIndex = 0;
      elementIndex < elements.length;
      elementIndex++
    ) {
      const element =
        elements[elementIndex];

      let title = "";
      let description = "";

      try {
        title =
          String(
            element.getTitle() || ""
          ).trim();
      } catch (error) {
        title = "";
      }

      try {
        description =
          String(
            element.getDescription() || ""
          )
            .replace(/\s+/g, " ")
            .trim();
      } catch (error) {
        description = "";
      }

      const normalizedPlaceholder =
        String(
          qrPlaceholder || ""
        )
          .replace(/\s+/g, " ")
          .trim();

      const hasMarker =
        title ===
          normalizedPlaceholder ||
        description ===
          normalizedPlaceholder;

      if (!hasMarker) {
        continue;
      }

      /*
       * We found the QR placeholder.
       *
       * Your current template uses a SHAPE
       * with {{ticket.qr}} in its description.
       */

      if (
        element.getPageElementType() !==
        SlidesApp.PageElementType.SHAPE
      ) {
        throw new Error(
          "QR placeholder was found, but it is not a shape."
        );
      }

      if (placeholder) {
        throw new Error(
          "Multiple QR placeholders found. " +
          "Expected exactly one."
        );
      }

      placeholder = {
        slide: slide,
        element: element,
      };
    }
  }

  if (!placeholder) {
    throw new Error(
      "QR placeholder not found: " +
      qrPlaceholder
    );
  }

  const oldShape =
    placeholder.element;

  /*
   * ---------------------------------------------------------
   * Save the exact position and size
   * ---------------------------------------------------------
   */

  const left =
    oldShape.getLeft();

  const top =
    oldShape.getTop();

  const width =
    oldShape.getWidth();

  const height =
    oldShape.getHeight();

  const rotation =
    oldShape.getRotation();


  /*
   * ---------------------------------------------------------
   * Generate QR
   * ---------------------------------------------------------
   */

  const qrUrl =
    CONFIG.QR_API +
    "?text=" +
    encodeURIComponent(ticketId) +
    "&size=1000" +
    "&margin=1";

  const response =
    UrlFetchApp.fetch(
      qrUrl,
      {
        method: "get",
        muteHttpExceptions: true,
      }
    );

  if (
    response.getResponseCode() !==
    200
  ) {
    throw new Error(
      "QR generation failed. HTTP " +
      response.getResponseCode()
    );
  }

  const qrBlob =
    response
      .getBlob()
      .setName(
        "ticket-qr-" +
        ticketId +
        ".png"
      );


  /*
   * ---------------------------------------------------------
   * Delete the placeholder shape
   * ---------------------------------------------------------
   */

  oldShape.remove();


  /*
   * ---------------------------------------------------------
   * Insert QR at exactly the same location
   * ---------------------------------------------------------
   */

  const newImage =
    placeholder.slide.insertImage(
      qrBlob,
      left,
      top,
      width,
      height
    );


  /*
   * Preserve rotation.
   */

  newImage.setRotation(
    rotation
  );
}


/**
 * Extract Google Drive / Slides file ID.
 */
function extractGoogleId(url) {

  const value =
    String(url || "").trim();

  /*
   * Normal Google Slides URL:
   *
   * https://docs.google.com/presentation/d/FILE_ID/edit
   */

  let match =
    value.match(
      /\/presentation\/d\/([a-zA-Z0-9_-]+)/
    );

  if (match) {
    return match[1];
  }


  /*
   * Also support Google Drive URLs.
   */

  match =
    value.match(
      /\/d\/([a-zA-Z0-9_-]+)/
    );

  if (match) {
    return match[1];
  }


  throw new Error(
    "Could not extract Google Slides file ID from template URL."
  );
}


/**
 * Return JSON response.
 */
function jsonResponse(data) {

  return ContentService
    .createTextOutput(
      JSON.stringify(data)
    )
    .setMimeType(
      ContentService.MimeType.JSON
    );
}
