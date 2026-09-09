import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { extname, join } from "node:path";
import Busboy from "busboy";
import sharp from "sharp";
import { config, uploadRoot } from "./config.mjs";

const csvMimeTypes = new Set([
  "text/csv",
  "application/csv",
  "application/vnd.ms-excel",
  "text/plain",
]);

const optimizableImageMimeTypes = new Set(["image/jpeg", "image/png", "image/webp"]);

const normalizeMimeType = (mimeType) =>
  String(mimeType || "").split(";", 1)[0].trim().toLowerCase();

const invalidImageError = () => {
  const error = new Error("INVALID_IMAGE");
  error.statusCode = 415;
  return error;
};

export const parseMultipartForm = (
  request,
  {
    maxBytes = config.uploadMaxBytes,
    maxFiles = 4,
    collectFiles = false,
    signal,
    timeoutMs = 30_000,
  } = {},
) =>
  new Promise((resolve, reject) => {
    const busboy = Busboy({
      headers: request.headers,
      limits: {
        fileSize: maxBytes,
        files: maxFiles,
        fields: 80,
        fieldSize: Math.min(maxBytes, 1024 * 1024),
        parts: maxFiles + 80,
      },
    });
    const fields = Object.create(null);
    const files = Object.create(null);
    let totalBytes = 0;
    let requestBytes = 0;
    let settled = false;
    const streams = new Set();
    const errorFor = (message, statusCode) => Object.assign(new Error(message), { statusCode });
    const onRequestError = error => fail(error);
    const onAborted = () => fail(errorFor("UPLOAD_ABORTED", 400));
    const onClose = () => { if (!request.complete && !request.readableEnded) onAborted(); };
    const onSignal = () => fail(errorFor("UPLOAD_ABORTED", 408));
    const onData = chunk => {
      requestBytes += chunk.length;
      // Include fields and multipart overhead, not only file streams.
      if (requestBytes > maxBytes + 64 * 1024) fail(errorFor("PAYLOAD_TOO_LARGE", 413));
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onSignal);
      request.removeListener("data", onData);
      request.removeListener("aborted", onAborted);
      request.removeListener("close", onClose);
      request.removeListener("error", onRequestError);
    };

    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      request.unpipe(busboy);
      // Every file stream needs its own error handler: a Busboy handler alone
      // cannot catch "Unexpected end of form" emitted by FileStream.
      // Defer destruction until Busboy's current callback has returned. A
      // synchronous destroy from its "limit" callback mutates internal state
      // while Busboy is still updating that same file stream.
      queueMicrotask(() => {
        for (const file of streams) file.destroy();
        streams.clear();
        busboy.destroy();
      });
      for (const key of Object.keys(files)) delete files[key];
      // A late socket error must not become an uncaught EventEmitter error.
      request.once("error", () => {});
      if (!request.destroyed) request.resume();
      reject(error);
    };
    const timer = setTimeout(() => {
      fail(errorFor("UPLOAD_TIMEOUT", 408));
      request.destroy();
    }, timeoutMs);

    busboy.on("field", (name, value, info) => {
      if (settled) return;
      if (info.valueTruncated || info.nameTruncated) { fail(errorFor("PAYLOAD_TOO_LARGE", 413)); return; }
      fields[name] = value;
    });

    busboy.on("file", (name, file, info) => {
      const chunks = [];
      const filename = info.filename || "";
      const mimeType = normalizeMimeType(info.mimeType);
      streams.add(file);
      file.on("error", error => fail(Object.assign(error, { statusCode: error.statusCode || 422 })));
      file.on("close", () => streams.delete(file));

      if (settled) { file.resume(); return; }

      if (!filename) {
        file.resume();
        return;
      }

      file.on("data", (chunk) => {
        if (settled) return;
        totalBytes += chunk.length;
        if (totalBytes > maxBytes) {
          const error = new Error("PAYLOAD_TOO_LARGE");
          error.statusCode = 413;
          fail(error);
          return;
        }
        chunks.push(chunk);
      });

      file.on("limit", () => {
        const error = new Error("PAYLOAD_TOO_LARGE");
        error.statusCode = 413;
        fail(error);
      });

      file.on("end", () => {
        if (!settled && chunks.length > 0) {
          const upload = {
            filename,
            mimeType,
            buffer: Buffer.concat(chunks),
          };
          if (collectFiles) {
            files[name] ||= [];
            files[name].push(upload);
          } else {
            files[name] = upload;
          }
        }
      });
    });

    busboy.on("filesLimit", () => {
      if (settled) return;
      const error = new Error("TOO_MANY_FILES");
      error.statusCode = 422;
      fail(error);
    });
    busboy.on("fieldsLimit", () => fail(errorFor("TOO_MANY_FIELDS", 422)));
    busboy.on("partsLimit", () => fail(errorFor("TOO_MANY_PARTS", 422)));
    busboy.on("error", error => fail(Object.assign(error, { statusCode: error.statusCode || 422 })));
    busboy.on("finish", () => {
      if (!settled) { settled = true; cleanup(); resolve({ fields, files }); }
    });
    request.on("error", onRequestError);
    request.on("aborted", onAborted);
    request.on("close", onClose);
    request.on("data", onData);
    signal?.addEventListener("abort", onSignal, { once: true });
    if (signal?.aborted || request.aborted || request.destroyed) { onAborted(); return; }
    request.pipe(busboy);
  });

export const saveAgreementLogo = async (file) => {
  if (!file) return "";
  const buffer = await optimizeImageUpload(file, {
    width: 1200,
    height: 600,
    fit: "inside",
  });
  return saveAgreementFile(buffer, ".webp");
};

export const saveAgreementPdf = async (file) => {
  if (!file) return "";
  const hasPdfSignature =
    file.buffer.length >= 5 && file.buffer.subarray(0, 5).toString("ascii") === "%PDF-";
  if (
    file.mimeType !== "application/pdf" ||
    extname(file.filename).toLowerCase() !== ".pdf" ||
    !hasPdfSignature
  ) {
    const error = new Error("INVALID_PDF");
    error.statusCode = 415;
    throw error;
  }
  return saveAgreementFile(file.buffer, ".pdf");
};

export const saveProfessionalPhoto = async (file) => {
  if (!file) return "";
  const buffer = await optimizeImageUpload(file, {
    width: 512,
    height: 512,
    fit: "cover",
  });
  return saveUploadFile("professionals", buffer, ".webp");
};

export const saveServiceImage = async (file) => {
  if (!file) return "";
  const buffer = await optimizeImageUpload(file, {
    width: 1200,
    height: 720,
    fit: "cover",
  });
  return saveUploadFile("services", buffer, ".webp");
};

const optimizeImageUpload = async (file, options) => {
  if (!optimizableImageMimeTypes.has(file.mimeType)) {
    throw invalidImageError();
  }

  try {
    return await optimizeImageBuffer(file.buffer, options);
  } catch {
    throw invalidImageError();
  }
};

export const optimizeImageBuffer = async (buffer, options) =>
  sharp(buffer, { failOn: "warning" })
    .rotate()
    .resize({
      width: options.width,
      height: options.height,
      fit: options.fit,
      withoutEnlargement: true,
    })
    .webp({ quality: 82, effort: 4 })
    .toBuffer();

const saveAgreementFile = async (buffer, extension) => {
  return saveUploadFile("agreements", buffer, extension);
};

const saveUploadFile = async (folder, buffer, extension) => {
  await mkdir(join(uploadRoot, folder), { recursive: true });
  const relativePath = `${folder}/${randomUUID()}${extension}`;
  await writeFile(join(uploadRoot, relativePath), buffer, { mode: 0o640 });
  return relativePath;
};

export const readCsvUpload = (file) => {
  if (!file) {
    const error = new Error("CSV_REQUIRED");
    error.statusCode = 422;
    throw error;
  }
  if (!csvMimeTypes.has(file.mimeType) && extname(file.filename).toLowerCase() !== ".csv") {
    const error = new Error("INVALID_CSV");
    error.statusCode = 415;
    throw error;
  }
  return file.buffer.toString("utf8");
};
