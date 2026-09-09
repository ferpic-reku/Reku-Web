import { randomBytes } from "node:crypto";
import { isProduction } from "./config.mjs";
import { getClientIp, parseCookies, readBody, sendJson, withSecurityHeaders } from "./http.mjs";
import { requestIdentifiesAgreement, resolveAgreementForRequest } from "./agreement-resolution.mjs";
import { consumeRateLimit } from "./rate-limit.mjs";
import { parseMultipartForm } from "./uploads.mjs";
import { transcribeConsultation, botSettings } from "./consultation-bot-ai.mjs";
import { advanceConsultation } from "./consultation-bot-conversation.mjs";
import { loadBotBrandLogo, renderConsultationReport } from "./consultation-bot-report.mjs";

export const welcomeMessages = [
  "Hola, bienvenido a Reku. Necesitamos que nos cuentes el motivo de tu consulta: si es una lesión o una dolencia que venís arrastrando, cómo empezó, en qué zona, cuánto te duele del 1 al 10 y desde hace cuánto tiempo.",
  "Podés escribirlo o, si te resulta más cómodo, mandar un audio.",
];
const cookieName = "reku_consultation_bot";
const ttl = 2 * 60 * 60 * 1000;
const sessions = new Map();
let activeRequests = 0;
const cleanSessions = () => {
  for (const [id, session] of sessions) if (session.expiresAt < Date.now()) sessions.delete(id);
};
const cleanup = setInterval(cleanSessions, 60_000);
cleanup.unref();
const fail = (message, statusCode = 422) => Object.assign(new Error(message), { statusCode, publicMessage: message });
const present = (session) => ({
  messages: session.messages, data: session.data, brand: session.brand, status: session.status,
  expiresAt: session.expiresAt, version: session.version, instanceId: session.instanceId,
});
export const requireBotOrigin = (request) => {
  let origin;
  try { origin = new URL(request.headers.origin); } catch { throw fail("Recargá la página para continuar.", 403); }
  if (origin.host !== request.headers.host || (isProduction && origin.protocol !== "https:") || !["http:", "https:"].includes(origin.protocol)) throw fail("Origen no permitido.", 403);
};
const context = async (request, url) => {
  const agreement = await resolveAgreementForRequest(request, url);
  if (requestIdentifiesAgreement(request, url) && !agreement) throw fail("No encontramos ese acuerdo.", 404);
  return agreement ? { name: agreement.name, slug: agreement.slug, cobranded: Boolean(agreement.cobranded), logo_url: agreement.cobranded ? agreement.logo_url : "" } : { name: "Reku", slug: "", cobranded: false, logo_url: "" };
};

export const handleConsultationBot = async (request, response, url) => {
  try {
    const action = url.pathname.slice("/api/bot/".length);
    if (request.method === "GET" && action === "logo") {
      const logo = await loadBotBrandLogo(await context(request, url));
      if (!logo) throw fail("Logo no encontrado.", 404);
      response.writeHead(200, withSecurityHeaders({ "Content-Type": "image/png", "Cache-Control": "public, max-age=300" }));
      response.end(logo);
      return;
    }
    if (request.method === "GET" && action === "context") {
      sendJson(response, 200, { brand: await context(request, url), available: Boolean(botSettings.apiKey) });
      return;
    }
    if (request.method === "POST") requireBotOrigin(request);
    const token = parseCookies(request)[cookieName];
    let session = sessions.get(token);
    if (session && (session.expiresAt < Date.now() || session.host !== request.headers.host)) session = null;
    if (request.method === "GET" && action === "session") {
      if (!session) { sendJson(response, 200, { session: null }); return; }
      const brand = await context(request, url);
      sendJson(response, 200, { session: brand.slug === session.brand.slug ? present(session) : null });
      return;
    }
    if (request.method === "POST" && action === "session") {
      const body = JSON.parse(await readBody(request, 1000));
      if (body.consent !== true) throw fail("Necesitamos tu aceptación para procesar el relato.");
      if (!botSettings.apiKey) throw fail("El asistente todavía no está disponible.", 503);
      await consumeRateLimit({ scope: "bot.sessions", key: getClientIp(request), limit: 12, windowSeconds: 3600 });
      cleanSessions();
      if (sessions.size >= 500) throw fail("El asistente está ocupado. Probá en unos minutos.", 503);
      const brand = await context(request, url);
      if (token) sessions.delete(token);
      const id = randomBytes(32).toString("hex");
      session = {
        host: request.headers.host, brand, data: null, status: "collecting", busy: false,
        createdAt: Date.now(), updatedAt: Date.now(), expiresAt: Date.now() + ttl,
        version: 0, lastRequestId: null, audioCount: 0,
        instanceId: randomBytes(12).toString("hex"),
        messages: welcomeMessages.map((text) => ({ role: "assistant", text })),
      };
      sessions.set(id, session);
      sendJson(response, 201, { session: present(session) }, { "Set-Cookie": `${cookieName}=${id}; Path=/api/bot/; HttpOnly; SameSite=Strict; Max-Age=7200${isProduction ? "; Secure" : ""}` });
      return;
    }
    if (!session) throw fail("La sesión terminó. Iniciá una nueva conversación.", 401);
    if ((await context(request, url)).slug !== session.brand.slug) throw fail("Esta conversación corresponde a otro acuerdo. Iniciá una nueva conversación.", 409);
    if (request.method === "GET" && action === "report") {
      if (!session.data || session.status === "collecting") throw fail("Primero completá la conversación.", 409);
      await consumeRateLimit({ scope: "bot.report", key: getClientIp(request), limit: 40, windowSeconds: 3600 });
      const pdf = await renderConsultationReport(session);
      response.writeHead(200, withSecurityHeaders({ "Content-Type": "application/pdf", "Content-Disposition": 'attachment; filename="reku-motivo-de-consulta.pdf"', "Cache-Control": "private, no-store" }, { privateRoute: true }));
      response.end(pdf);
      return;
    }
    if (request.method !== "POST" || !["message", "transcribe"].includes(action)) throw fail("Endpoint no encontrado.", 404);
    if (session.busy) throw fail("Estamos procesando tu mensaje anterior.", 409);
    if (activeRequests >= 6) throw fail("El asistente está ocupado. Intentá de nuevo en unos segundos.", 503);
    activeRequests++;
    session.busy = true;
    try {
      if (action === "message") {
        const body = JSON.parse(await readBody(request, 20_000));
        if (body.instanceId !== session.instanceId) throw fail("Se inició otra conversación. Recargá la página para continuar.", 409);
        if (typeof body.requestId !== "string" || !/^[\w-]{10,80}$/.test(body.requestId)) throw fail("Mensaje inválido.");
        if (body.requestId === session.lastRequestId) { sendJson(response, 200, { session: present(session) }); return; }
        if (body.version !== session.version) throw fail("La conversación cambió en otra ventana. Recargá para continuar.", 409);
        if (session.status !== "collecting") throw fail("La entrevista ya finalizó. Podés comenzar una nueva para corregir el relato.", 409);
        const text = typeof body.text === "string" ? body.text.trim() : "";
        if (!text || text.length > 4000) throw fail("Escribí un mensaje de hasta 4000 caracteres.");
        await enforceAIQuota(request);
        const messages = [...session.messages, { role: "user", text }];
        const { data, next } = await advanceConsultation(session, messages);
        const exhausted = session.version >= 24;
        const reply = exhausted && !next.complete && !next.urgent
          ? "Gracias por tu tiempo. Dejamos un informe parcial con lo que nos contaste y los datos pendientes para revisar con el profesional. Podés descargarlo acá abajo."
          : next.text;
        session.messages = [...messages, { role: "assistant", text: reply }];
        session.data = data;
        session.lastQuestion = next;
        session.status = next.urgent ? "urgent" : next.complete ? "complete" : exhausted ? "partial" : "collecting";
        session.version++;
        session.lastRequestId = body.requestId;
        session.updatedAt = Date.now();
        sendJson(response, 200, { session: present(session) });
      } else {
        if (session.status !== "collecting") throw fail("La entrevista ya finalizó.", 409);
        if (session.audioCount >= 15) throw fail("Llegaste al límite de audios. Podés seguir escribiendo.", 429);
        await enforceAIQuota(request);
        session.audioCount++;
        const { files } = await parseMultipartForm(request, { maxBytes: 8 * 1024 * 1024, maxFiles: 1 });
        const text = await transcribeConsultation(files.audio);
        sendJson(response, 200, { text });
      }
    } finally { session.busy = false; activeRequests--; }
  } catch (error) {
    const status = error.message === "RATE_LIMITED" ? 429 : error.message === "PAYLOAD_TOO_LARGE" ? 413 : error instanceof SyntaxError ? 422 : error.statusCode || 502;
    const message = error.publicMessage || (status === 429 ? "Llegaste al límite de solicitudes. Probá más tarde." : status === 413 ? "El audio es demasiado grande. Usá uno de hasta 8 MB." : error.message === "BOT_AUDIO_TYPE" ? "Usá un audio MP3, M4A, WAV, OGG o WebM." : "No pudimos procesarlo. Tu conversación sigue disponible; intentá de nuevo o escribí el mensaje.");
    // Never log patient messages, audio, API responses or credentials.
    if (status >= 500) console.error("Consultation bot request failed", { code: String(error.message).startsWith("BOT_") ? error.message : "BOT_FAILED" });
    sendJson(response, status, { error: message }, status === 429 ? { "Retry-After": String(error.retryAfter || 60) } : {});
  }
};

const enforceAIQuota = async (request) => {
  await consumeRateLimit({ scope: "bot.ai.ip", key: getClientIp(request), limit: 100, windowSeconds: 3600 });
  await consumeRateLimit({ scope: "bot.ai.global", key: "global", limit: Number(process.env.OPENAI_BOT_DAILY_LIMIT || 1000), windowSeconds: 86_400 });
};
