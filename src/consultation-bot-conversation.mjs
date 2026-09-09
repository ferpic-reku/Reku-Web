import { analyzeConsultation, nextConsultationStep } from "./consultation-bot-ai.mjs";
import { chooseReviewedFollowup } from "./consultation-bot-followups.mjs";

const fields = ["reason", "location", "side", "onset", "mechanism", "pain", "limitations"];
const normalize = value => String(value || "").normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();
const quotedIn = (quote, text) => Boolean(normalize(quote)) && normalize(text).includes(normalize(quote));

// A missing model field is not a withdrawal of a previously verified fact.
// Stable ids prevent extraction order from moving answers between complaints.
export function mergeConsultationData(previous, extracted, latestText, lastQuestion) {
  const complaints = structuredClone(previous?.complaints || []);
  const seen = new Set();
  for (const incoming of extracted.complaints) {
    let item = complaints.find(existing => incoming.id && existing.id === incoming.id);
    if (!item && incoming.id) continue; // Never accept an invented existing id.
    if (!item) item = complaints.find(existing => normalize(existing.location) === normalize(incoming.location) && normalize(existing.side) === normalize(incoming.side));
    if (!item) {
      if (complaints.length >= 5) continue;
      item = { ...incoming, id: `c${complaints.length + 1}` };
      complaints.push(item);
    }
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    const priorEvidence = item.evidence || {};
    item.evidence = { ...priorEvidence };
    for (const field of fields) {
      const quote = incoming.evidence?.[field];
      if (incoming[field] == null) continue;
      // Bare numbers / yes / no belong only to the last question's target.
      if (/^(?:\d+(?:[.,]\d+)?|s[ií]|no)[.!\s]*$/i.test(latestText) && quotedIn(quote, latestText)
        && lastQuestion?.complaintId && (item.id !== lastQuestion.complaintId || (field !== lastQuestion.field && !(lastQuestion.field === "detail" && field === "location")))) continue;
      if (item[field] == null || item[field] === incoming[field] || quotedIn(quote, latestText)) {
        const unchanged = item[field] === incoming[field];
        item[field] = incoming[field];
        item.evidence[field] = quote;
        if (field === "location") { item.locationClear = (unchanged && item.locationClear) || incoming.locationClear; item.sideRequired = incoming.sideRequired; }
        if (field === "pain") item.painNote = incoming.painNote;
      }
    }
    if (incoming.pain == null && /^No informado:/i.test(incoming.painNote || "") && quotedIn(incoming.evidence?.pain, latestText)) {
      item.pain = null; item.painNote = incoming.painNote; item.evidence.pain = incoming.evidence.pain;
    }
  }
  const answer = extracted.lastAnswer;
  const target = complaints.find(item => item.id === lastQuestion?.complaintId);
  if (target && fields.concat("detail").includes(lastQuestion.field) && answer?.status === "answered"
    && typeof answer.value === "string" && quotedIn(answer.evidence, latestText)) {
    const field = lastQuestion.field === "detail" ? "location" : lastQuestion.field;
    if (field === "pain") {
      const pain = /^\d+(?:[.,]\d+)?$/.test(answer.value.trim()) ? Number(answer.value.replace(",", ".")) : NaN;
      if (Number.isFinite(pain) && pain >= 0 && pain <= 10) { target.pain = pain; target.painNote = null; }
      else if (/^No informado:/i.test(answer.value)) { target.pain = null; target.painNote = answer.value.slice(0, 1000); }
    } else {
      target[field] = answer.value.slice(0, 1000);
      if (lastQuestion.field === "detail") target.locationClear = true;
    }
    target.evidence = { ...target.evidence, [field]: answer.evidence };
  }
  return {
    ...extracted, complaints,
    priorCare: extracted.priorCare || previous?.priorCare || null,
    goal: extracted.goal || previous?.goal || null,
    followups: structuredClone(previous?.followups || []),
  };
}

export async function advanceConsultation(session, messages, { analyze = analyzeConsultation, chooseFollowup = chooseReviewedFollowup, onFollowupDecision = () => {} } = {}) {
  const latestText = messages.at(-1).text;
  const lastQuestion = session.lastQuestion;
  const extracted = await analyze(messages, { previousData: session.data, lastQuestion });
  const data = mergeConsultationData(session.data, extracted, latestText, lastQuestion);
  if (lastQuestion?.field === "followup") {
    const entry = data.followups[lastQuestion.followupIndex];
    if (entry && entry.answer === null) entry.answer = latestText; // Verbatim, never an inferred diagnosis.
  }
  // One short clarification instead of repeating the same compound question.
  // After a second unclear answer preserve uncertainty for clinician review.
  if (!data.urgent && lastQuestion?.complaintId && lastQuestion.field !== "followup" && extracted.lastAnswer?.status === "unclear") {
    const item = data.complaints.find(item => item.id === lastQuestion.complaintId);
    if (item && lastQuestion.clarification) {
      const value = "No informado: respuesta ambigua; revisar con el profesional";
      if (lastQuestion.field === "pain") { item.pain = null; item.painNote = value; }
      else if (lastQuestion.field === "detail") { item.locationClear = true; item.location = `${item.location || "Zona no precisada"} (detalle no aclarado)`; }
      else item[lastQuestion.field] = value;
    } else if (item) {
      const text = lastQuestion.field === "mechanism"
        ? `Para no interpretar de más: ¿querés decir que no recordás qué inició la molestia en ${item.location}?`
        : `Para dejarlo claro para el profesional: ${lastQuestion.text} Si no lo sabés, podés decirlo.`;
      return { data, next: { ...lastQuestion, text, clarification: true } };
    }
  }
  const next = nextConsultationStep(data);
  if (!next.complete || session.version >= 24 || data.followups.length >= 2) return { data, next };
  const followup = await chooseFollowup(data, messages, { onDecision: onFollowupDecision });
  if (!followup) return { data, next };
  data.followups.push(followup);
  return { data, next: { key: `followup.${data.followups.length}`, field: "followup", complaintId: followup.complaintId,
    followupIndex: data.followups.length - 1, text: followup.question } };
}
