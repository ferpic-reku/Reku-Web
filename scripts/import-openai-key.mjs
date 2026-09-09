import { readFile, writeFile, chmod } from "node:fs/promises";

// Credential provisioning: only the requested env value is updated; never print it.
const [envPath, sourcePath] = process.argv.slice(2);
if (!envPath) throw new Error("Usage: node scripts/import-openai-key.mjs ENV_PATH [SOURCE_FILE]");
let source = "";
if (sourcePath) source = await readFile(sourcePath, "utf8");
else for await (const chunk of process.stdin) source += chunk;
const keys = source.match(/sk-[A-Za-z0-9_-]{20,}/g) || [];
if (new Set(keys).size !== 1) throw new Error("Expected exactly one OpenAI API key; no changes made.");
const previous = await readFile(envPath, "utf8");
const entry = `OPENAI_API_KEY=${keys[0]}`;
const next = /^OPENAI_API_KEY=/m.test(previous)
  ? previous.replace(/^OPENAI_API_KEY=.*$/m, entry)
  : `${previous.trimEnd()}\n${entry}\n`;
await writeFile(envPath, next, { mode: 0o600 });
await chmod(envPath, 0o600);
console.log("OpenAI key configured in private environment.");
