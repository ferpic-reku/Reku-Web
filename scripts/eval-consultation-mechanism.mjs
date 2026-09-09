// Opt-in extraction checks using fictional accounts only; never production chats.
// node --env-file=.env scripts/eval-consultation-mechanism.mjs
import assert from "node:assert/strict";
import { analyzeConsultation, nextConsultationStep } from "../src/consultation-bot-ai.mjs";
import { mergeConsultationData } from "../src/consultation-bot-conversation.mjs";

const cases = [
  { id: "football_context", text: "Hace dos meses me torcí el tobillo izquierdo jugando al fútbol. Ahora al caminar me duele 5 de 10.", pattern: /f[uú]tbol/i, clear: true },
  { id: "work_context", text: "Ayer me empezó a doler el hombro derecho al levantar una caja en el trabajo. Hoy me duele 4 de 10.", pattern: /caja.*trabajo/i, clear: true },
  { id: "missing_circumstances", text: "Hace dos meses me torcí el tobillo izquierdo. Me duele 5 de 10 al caminar.", clear: false },
  { id: "unknown_cause", text: "Me duele la rodilla derecha desde ayer, 4 de 10. No recuerdo cómo empezó.", clear: true },
  { id: "gradual_onset", text: "Me duele la espalda baja desde hace un mes, apareció de a poco sin ningún golpe ni actividad que lo desencadenara. Me duele 3 de 10.", clear: true },
];
for (const fixture of cases) {
  const messages = [{ role: "user", text: fixture.text }];
  const data = await analyzeConsultation(messages);
  const item = data.complaints[0];
  assert.equal(item.mechanismClear, fixture.clear, fixture.id);
  if (fixture.pattern) assert.match(item.mechanism, fixture.pattern, fixture.id);
  const next = nextConsultationStep(data);
  if (!fixture.clear) assert.equal(next.field, "mechanism", fixture.id);
  else assert.equal(next.complete, true, fixture.id);
  if (!fixture.clear) {
    const previousData = mergeConsultationData(null, data, fixture.text, null);
    const lastQuestion = { ...next, complaintId: "c1" };
    const answer = "Fue jugando al fútbol";
    const history = [...messages, { role: "assistant", text: next.text }, { role: "user", text: answer }];
    const fresh = await analyzeConsultation(history, { previousData, lastQuestion });
    const merged = mergeConsultationData(previousData, fresh, answer, lastQuestion);
    assert.match(merged.complaints[0].mechanism, /torcedura.*f[uú]tbol/i);
    assert.equal(nextConsultationStep(merged).complete, true);
  }
  if (fixture.id === "football_context") {
    const previousData = mergeConsultationData(null, data, fixture.text, null);
    const followMessages = [...messages, { role: "assistant", text: "¿Notaste hinchazón en ese tobillo?" }, { role: "user", text: "No" }];
    const lastQuestion = { field: "followup", complaintId: "c1" };
    const fresh = await analyzeConsultation(followMessages, { previousData, lastQuestion });
    const merged = mergeConsultationData(previousData, fresh, "No", lastQuestion);
    assert.match(merged.complaints[0].mechanism, fixture.pattern);
  }
  console.log(JSON.stringify({ fixture: fixture.id, passed: true, mechanism: item.mechanism, mechanismClear: item.mechanismClear }));
}
