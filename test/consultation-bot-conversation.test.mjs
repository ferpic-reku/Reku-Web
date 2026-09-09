import assert from "node:assert/strict";
import test from "node:test";
import { mergeConsultationData, advanceConsultation } from "../src/consultation-bot-conversation.mjs";
import { chooseReviewedFollowup } from "../src/consultation-bot-followups.mjs";

const complaint = (id = "c1", overrides = {}) => ({ id, reason: "tirón", location: "muslo derecho", locationClear: true,
  sideRequired: true, side: "derecha", onset: "ayer", mechanism: "jugando al fútbol", pain: 4, painNote: null,
  limitations: null, evidence: { reason: "tirón", location: "muslo derecho", side: "derecho", onset: "ayer", mechanism: "jugando al fútbol", pain: "4", limitations: null }, ...overrides });
const state = (items = [complaint()]) => ({ complaints: items, priorCare: null, goal: null, urgent: false, urgentReason: null, followups: [] });
const msgs = text => [{ role: "user", text }];
const contextText = "Ayer sentí un tirón en el muslo derecho jugando al fútbol, me duele 4.";

test("verified facts survive omitted fields, omitted complaints and reordered extraction", () => {
  const previous = state([complaint(), complaint("c2", { location: "espalda baja", sideRequired: false })]);
  const extracted = state([complaint("c2", { onset: null }), complaint("c1", { onset: null, mechanism: null })]);
  let data = mergeConsultationData(previous, extracted, "3", { field: "pain", complaintId: "c2" });
  assert.deepEqual(data.complaints.map(item => item.id), ["c1", "c2"]);
  assert.equal(data.complaints[0].onset, "ayer");
  assert.equal(data.complaints[0].mechanism, "jugando al fútbol");
  data = mergeConsultationData(data, state([]), "gracias", null);
  assert.equal(data.complaints.length, 2);
});
test("short pain answers bind to the last question, not another complaint", () => {
  const previous = state([complaint(), complaint("c2", { location: "espalda baja", pain: null })]);
  const extracted = state([complaint("c1", { pain: 3, evidence: { pain: "3" } })]);
  extracted.lastAnswer = { status: "answered", value: "3", evidence: "3" };
  const data = mergeConsultationData(previous, extracted, "3", { field: "pain", complaintId: "c2" });
  assert.equal(data.complaints[0].pain, 4);
  assert.equal(data.complaints[1].pain, 3);
});
test("current corrections replace facts while stale evidence cannot overwrite them", () => {
  const previous = state();
  let data = mergeConsultationData(previous, state([complaint("c1", { onset: "hace tres semanas", evidence: { onset: "tres semanas" } })]), "Me equivoqué: hace tres semanas", null);
  assert.equal(data.complaints[0].onset, "hace tres semanas");
  data = mergeConsultationData(data, state(), "4", { field: "pain", complaintId: "c1" });
  assert.equal(data.complaints[0].onset, "hace tres semanas");
});
test("unverified lastAnswer cannot inject an answer", () => {
  const extracted = state([]);
  extracted.lastAnswer = { status: "answered", value: "9", evidence: "9" };
  const data = mergeConsultationData(state(), extracted, "3", { field: "pain", complaintId: "c1" });
  assert.equal(data.complaints[0].pain, 4);
});
test("screenshot sequence clarifies ambiguous no once, then continues without repeating onset or mechanism", async () => {
  const session = { data: state([complaint("c1", { mechanism: null }), complaint("c2", { location: "espalda baja", pain: null })]), version: 2,
    lastQuestion: { complaintId: "c1", field: "mechanism", key: "c1.mechanism", text: "¿Hubo golpe, esfuerzo, apareció de a poco o no recordás?" } };
  const unclear = async () => ({ ...state([]), lastAnswer: { status: "unclear", value: null, evidence: "no" } });
  let turn = await advanceConsultation(session, msgs("no"), { analyze: unclear });
  assert.equal(turn.next.clarification, true);
  assert.match(turn.next.text, /no recordás/);
  assert.notEqual(turn.next.text, session.lastQuestion.text);
  turn = await advanceConsultation({ ...session, data: turn.data, lastQuestion: turn.next }, msgs("no"), { analyze: unclear });
  assert.equal(turn.next.key, "c2.pain");
  assert.match(turn.data.complaints[0].mechanism, /respuesta ambigua/);
  turn = await advanceConsultation({ ...session, data: turn.data, lastQuestion: turn.next }, msgs("3"), {
    analyze: async () => ({ ...state([]), lastAnswer: { status: "answered", value: "3", evidence: "3" } }), chooseFollowup: async () => null,
  });
  assert.equal(turn.next.complete, true);
  assert.equal(turn.data.complaints[1].pain, 3);
});
test("zero followups is valid; no selection before essentials or after urgency", async () => {
  let calls = 0;
  const chooseFollowup = async () => { calls++; return null; };
  const turn = await advanceConsultation({ data: state(), version: 1 }, msgs("ok"), { analyze: async () => state([]), chooseFollowup });
  assert.equal(turn.next.complete, true);
  assert.equal(calls, 1);
  await advanceConsultation({ data: state([complaint("c1", { onset: null })]), version: 1 }, msgs("hola"), { analyze: async () => state([]), chooseFollowup });
  const urgent = await advanceConsultation({ data: state(), version: 1 }, msgs("alarma"), { analyze: async () => ({ ...state([]), urgent: true }), chooseFollowup });
  assert.equal(urgent.next.urgent, true);
  assert.equal(calls, 1);
});
test("followup ledger allows at most two total and preserves literal answers for the report", async () => {
  let session = { data: state(), version: 1 };
  let count = 0;
  const chooseFollowup = async () => ({ complaintId: "c1", topic: `topic-${++count}`, question: "¿Notaste algún moretón en ese muslo?", answer: null });
  const analyze = async () => state([]);
  for (const answer of ["ok", "No vi moretones", "Caminar me cuesta un poco"]) {
    const turn = await advanceConsultation(session, msgs(answer), { analyze, chooseFollowup });
    session = { data: turn.data, lastQuestion: turn.next, version: session.version + 1 };
  }
  assert.equal(count, 2);
  assert.equal(session.lastQuestion.complete, true);
  assert.deepEqual(session.data.followups.map(item => item.answer), ["No vi moretones", "Caminar me cuesta un poco"]);
});
test("provider extraction failures do not mutate the session", async () => {
  const session = { data: state(), version: 1 };
  const before = structuredClone(session);
  await assert.rejects(advanceConsultation(session, msgs("hola"), { analyze: async () => { throw new Error("failure"); } }));
  assert.deepEqual(session, before);
});

const candidate = { question: "¿Notaste algún moretón en ese muslo?", complaintId: "c1", topic: "moretón", evidence: "tirón en el muslo derecho" };
const approved = { relevant: true, useful: true, notAlreadyAnswered: true, clear: true, respectful: true, nonIntrusive: true,
  nonDiscriminatory: true, noDiagnosis: true, safe: true, grounded: true, confidence: "high" };
function mockProvider(outputs) {
  const requests = [];
  return { requests, settings: { apiKey: "test", model: "test" }, fetchImpl: async (_url, options) => {
    requests.push(JSON.parse(options.body));
    const value = outputs.shift();
    if (value instanceof Error) throw value;
    return { ok: true, json: async () => ({ status: "completed", output: [{ content: [{ type: "output_text", text: JSON.stringify(value) }] }] }) };
  } };
}
test("candidate is displayed only after a separate review approves ALL criteria", async () => {
  const mock = mockProvider([candidate, approved]);
  const result = await chooseReviewedFollowup(state(), msgs(contextText), mock);
  assert.equal(result.question, candidate.question);
  assert.equal(mock.requests.length, 2);
  assert.notEqual(mock.requests[0].text.format.name, mock.requests[1].text.format.name);
  assert.ok(mock.requests.every(item => item.store === false));
  assert.match(mock.requests[1].instructions, /revisor independiente/);
  assert.ok(mock.requests.every(item => item.instructions.includes("NINGUNA pregunta puede requerir una prueba, movimiento ni esfuerzo físico")));
});
for (const key of Object.keys(approved)) {
  test(`review fails closed for ${key}`, async () => {
    const mock = mockProvider([candidate, { ...approved, [key]: key === "confidence" ? "uncertain" : false }]);
    assert.equal(await chooseReviewedFollowup(state(), msgs(contextText), mock), null);
  });
}
test("failed or malformed review is omitted, never retried or shown", async () => {
  for (const review of [new Error("timeout"), {}, null]) {
    const mock = mockProvider([candidate, review]);
    assert.equal(await chooseReviewedFollowup(state(), msgs(contextText), mock), null);
    assert.equal(mock.requests.length, 2);
  }
});
test("local gate rejects ungrounded, invasive, malformed, duplicate or extra questions", async () => {
  for (const invalid of [{ ...candidate, evidence: "me caí" }, { ...candidate, complaintId: "c99" },
    { ...candidate, question: "¿Estás embarazada o cuál es tu religión?" }, { ...candidate, question: "¿Te duele? ¿Te hinchó?" },
    { ...candidate, question: "¿Podés hacer diez sentadillas ahora para ver si duele?" },
    { ...candidate, question: "¿Qué pasa si levantás la pierna?" },
    { ...candidate, question: "¿Qué hiciste mal para lastimarte?" },
    { ...candidate, question: "¿Notaste moretones o hinchazón?" }, { question: null }]) {
    const mock = mockProvider([invalid]);
    assert.equal(await chooseReviewedFollowup(state(), msgs(contextText), mock), null);
    assert.equal(mock.requests.length, 1);
  }
  const data = { ...state(), followups: [{ ...candidate, answer: "no" }] };
  assert.equal(await chooseReviewedFollowup(data, msgs(contextText), mockProvider([candidate])), null);
  data.followups.push({ ...candidate });
  const mock = mockProvider([]);
  assert.equal(await chooseReviewedFollowup(data, msgs(contextText), mock), null);
  assert.equal(mock.requests.length, 0);
});
