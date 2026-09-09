import assert from "node:assert/strict";
import test from "node:test";
import { buildConsultationNarrative, cachedConsultationNarrative, fallbackConsultationNarrative } from "../src/consultation-bot-narrative.mjs";
import { chooseReviewedFollowup, followupCandidateRejection } from "../src/consultation-bot-followups.mjs";

const session = () => ({ version: 3, data: {
  complaints: [{ id: "c1", reason: "dolor", location: "rodilla derecha", side: "derecha", onset: "hace un mes", mechanism: "esfuerzo", pain: 8, limitations: "le cuesta subir escaleras" }],
  priorCare: null, goal: null, followups: [],
}, messages: [
  { role: "user", text: "Me duele la rodilla derecha hace un mes por un esfuerzo." },
  { role: "assistant", text: "¿Cuánto te duele del 1 al 10?" },
  { role: "user", text: "8. Me cuesta subir escaleras." },
] });
const paragraph = "Refiere dolor en la rodilla derecha desde hace un mes, iniciado con un esfuerzo. Lo califica en 8/10 y cuenta que le cuesta subir escaleras.";
const candidate = { sentences: [
  { text: "Refiere dolor en la rodilla derecha desde hace un mes, iniciado con un esfuerzo.", evidence: ["Me duele la rodilla derecha hace un mes por un esfuerzo."] },
  { text: "Lo califica en 8/10 y cuenta que le cuesta subir escaleras.", evidence: ["8. Me cuesta subir escaleras."] },
] };
const approved = { faithful: true, complete: true, uncertaintyPreserved: true, noDiagnosisAdded: true, noContradictions: true, respectful: true, confidence: "high" };
function provider(outputs) {
  const requests = [];
  return { requests, settings: { apiKey: "test", model: "test" }, fetchImpl: async (_url, options) => {
    requests.push(JSON.parse(options.body));
    const value = outputs.shift();
    if (value instanceof Error) throw value;
    return { ok: true, json: async () => ({ status: "completed", output: [{ content: [{ type: "output_text", text: JSON.stringify(value) }] }] }) };
  } };
}
test("narrative joins the account into one reviewed paragraph, preserving short answers", async () => {
  const mock = provider([candidate, approved]);
  assert.equal(await buildConsultationNarrative(session(), mock), paragraph);
  assert.equal(mock.requests.length, 2);
  assert.ok(mock.requests.every(item => item.store === false));
  assert.match(mock.requests[0].instructions, /Un 'no' ambiguo no descarta síntomas/);
  assert.match(mock.requests[0].instructions, /discapacidad/);
  assert.match(mock.requests[1].instructions, /revisor independiente/);
});
test("unsupported citations never reach the reviewer", async () => {
  const mock = provider([{ sentences: [{ text: "Tiene una fractura.", evidence: ["tengo una fractura"] }] }]);
  assert.equal(await buildConsultationNarrative(session(), mock), fallbackConsultationNarrative(session().data));
  assert.equal(mock.requests.length, 1);
});
for (const key of Object.keys(approved)) test(`narrative falls back when review fails ${key}`, async () => {
  const mock = provider([candidate, { ...approved, [key]: key === "confidence" ? "uncertain" : false }]);
  assert.equal(await buildConsultationNarrative(session(), mock), fallbackConsultationNarrative(session().data));
});
test("provider errors and malformed rewrites preserve the PDF fallback", async () => {
  for (const value of [new Error("private failure"), null, { sentences: [] }, { sentences: [{ text: "inventado", evidence: [] }] }]) {
    assert.equal(await buildConsultationNarrative(session(), provider([value])), fallbackConsultationNarrative(session().data));
  }
});
test("concurrent downloads share one cached narrative per version", async () => {
  const current = session(); let calls = 0;
  const generate = async () => { calls++; return paragraph; };
  const [a, b] = await Promise.all([cachedConsultationNarrative(current, { generate }), cachedConsultationNarrative(current, { generate })]);
  assert.equal(a, b); assert.equal(calls, 1);
  current.version++;
  await cachedConsultationNarrative(current, { generate });
  assert.equal(calls, 2);
});
test("quota or concurrency failures use a cached fallback", async () => {
  const current = session(); let calls = 0;
  const generate = async () => { calls++; throw new Error("BUSY"); };
  assert.equal(await cachedConsultationNarrative(current, { generate }), fallbackConsultationNarrative(current.data));
  await cachedConsultationNarrative(current, { generate });
  assert.equal(calls, 1);
});

const functional = { question: "¿Hay alguna actividad habitual que esta molestia te dificulte?", topic: "impacto funcional", complaintId: "c1", evidence: "rodilla derecha" };
test("a neutral activity question is allowed only when impact is not already known", () => {
  const current = session();
  assert.equal(followupCandidateRejection(functional, current.data, current.messages), "functional_impact_not_applicable");
  current.data.complaints[0].limitations = null;
  assert.equal(followupCandidateRejection(functional, current.data, current.messages.slice(0, 1)), null);
});
for (const context of ["Uso una silla de ruedas.", "Tengo una discapacidad motriz.", "Salí de una cirugía ayer.", "Estoy operado de la rodilla.", "Estoy con reposo indicado."]) {
  test(`generic activity question is omitted with context: ${context}`, async () => {
    const current = session(); current.data.complaints[0].limitations = null;
    current.messages = [current.messages[0], { role: "user", text: context }];
    const mock = provider([functional]);
    assert.equal(await chooseReviewedFollowup(current.data, current.messages, mock), null);
    assert.equal(mock.requests.length, 1);
    assert.match(mock.requests[0].instructions, /Nunca supongas que una persona con discapacidad carece de autonomía/);
  });
}
test("wheelchair context does not exclude other respectful questions", () => {
  const current = session();
  current.messages.push({ role: "user", text: "Uso una silla de ruedas." });
  assert.equal(followupCandidateRejection({ ...functional, question: "¿Notaste hinchazón en esa rodilla?", topic: "hinchazón" }, current.data, current.messages), null);
});
