import PDFDocument from "pdfkit";
import sharp from "sharp";
import { join } from "node:path";
import { root } from "./config.mjs";
import { resolvePublicUploadPath } from "./http.mjs";

export const loadBotBrandLogo = async (brand) => {
  if (!brand.cobranded || !brand.logo_url) return null;
  const path = await resolvePublicUploadPath(brand.logo_url);
  return path ? sharp(path).trim().resize({ width: 400, height: 160, fit: "inside" }).png().toBuffer().catch(() => null) : null;
};

export const consultationReportRows = (data) => (data?.complaints || []).map((item) => [
  ["Motivo", item.reason],
  ["Zona / detalle", item.location],
  ["Lado", item.side || (item.sideRequired ? "No informado" : "No aplica")],
  ["Inicio / antigüedad", item.onset],
  ["Cómo comenzó", item.mechanism],
  ["Dolor actual", [item.pain !== null ? `${item.pain}/10` : "No cuantificado", item.painNote].filter(Boolean).join(". ")],
  ["Limitación / actividad que lo agrava", item.limitations],
]);

export const renderConsultationReport = async (session) => {
  const doc = new PDFDocument({ size: "A4", margin: 48, bufferPages: true, info: { Title: "Reku - Motivo de consulta", Author: "Reku" } });
  const chunks = [];
  const ready = new Promise((resolve, reject) => {
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  const width = 499;
  const navy = "#18213f";
  const muted = "#64738a";
  const teal = "#318b99";
  const rekuLogo = await sharp(join(root, "images/logo-reku.svg")).resize({ width: 340 }).png().toBuffer();
  const agreementLogo = await loadBotBrandLogo(session.brand);
  const heading = (title) => {
    if (doc.y > 680) doc.addPage();
    doc.moveDown(0.7).font("Helvetica-Bold").fontSize(13).fillColor(teal).text(title, 48, doc.y, { width });
    doc.moveDown(0.7);
  };
  const row = (label, value) => {
    const text = String(value || "No informado");
    doc.font("Helvetica").fontSize(10);
    const height = Math.max(24, doc.heightOfString(text, { width: 315 }) + 14);
    if (doc.y + height > 755) doc.addPage();
    const y = doc.y;
    doc.font("Helvetica-Bold").fontSize(9).fillColor(muted).text(label, 48, y, { width: 163 });
    doc.font("Helvetica").fontSize(10).fillColor(navy).text(text, 232, y, { width: 315 });
    doc.y = y + height;
    doc.moveTo(48, doc.y - 6).lineTo(547, doc.y - 6).strokeColor("#e4ebef").stroke();
  };
  if (agreementLogo) {
    doc.image(agreementLogo, 48, 43, { fit: [180, 50] });
    doc.image(rekuLogo, 464, 44, { fit: [83, 42] });
  } else doc.image(rekuLogo, 48, 43, { fit: [120, 52] });
  doc.y = 123;
  doc.font("Helvetica-Bold").fontSize(23).fillColor(navy).text("Motivo de consulta", 48, doc.y);
  doc.moveDown(0.35).font("Helvetica").fontSize(11).fillColor(muted).text("Entrevista previa de telerehabilitación kinésica");
  doc.moveDown(1.1);
  row("Fecha", new Date(session.updatedAt).toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires", hour12: false }));
  row("Paciente", "Prueba sin datos de identificación ni turno asociado");
  if (session.brand.slug) row("Acuerdo", `${session.brand.name} (${session.brand.slug})`);
  row("Estado", session.status === "complete" ? "Entrevista finalizada" : session.status === "urgent" ? "Entrevista interrumpida: se sugirió atención urgente" : "Informe parcial: datos pendientes");
  if (session.data?.urgent) {
    heading("Atención presencial urgente sugerida");
    row("Relato que motivó el aviso", session.data.urgentReason);
    row("Orientación mostrada", "Evaluación médica presencial urgente. No esperar al turno de telerehabilitación; contactar emergencias locales si corresponde.");
  }
  const complaints = consultationReportRows(session.data);
  complaints.forEach((rows, index) => {
    heading(complaints.length > 1 ? `Motivo ${index + 1}` : "Lo que nos cuenta el paciente");
    rows.forEach(([label, value]) => row(label, value));
  });
  heading("Contexto para la consulta");
  row("Atención / antecedentes referidos", session.data?.priorCare);
  row("Objetivo del paciente", session.data?.goal);
  doc.moveDown(0.8).font("Helvetica").fontSize(9).fillColor(muted).text("Resumen asistido por IA a partir del relato del paciente. No constituye un diagnóstico, una indicación de tratamiento ni una evaluación de aptitud para telerehabilitación. Los datos no informados y las incertidumbres requieren revisión del profesional. No se realizó un descarte completo de signos de alarma.", 48, doc.y, { width, lineGap: 3 });
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(i);
    doc.font("Helvetica").fontSize(8).fillColor(muted).text(`REKU  ·  INFORME DE PRUEBA  ·  ${i + 1} / ${range.count}`, 48, 776, { width, lineBreak: false });
  }
  doc.end();
  return ready;
};
