#!/usr/bin/env node
/**
 * Smoke-test local Ollama for career-ops (no cloud).
 * Usage: node scripts/verify-local-llm.mjs [model]
 */
const model = process.argv[2] || "career-ops-llama";
const base = process.env.OLLAMA_HOST || "http://127.0.0.1:11434";

const res = await fetch(`${base}/api/generate`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    model,
    prompt:
      "You are a terse assistant. Respond with exactly one word: ready",
    stream: false,
  }),
});

if (!res.ok) {
  console.error(`Ollama HTTP ${res.status}`);
  process.exit(1);
}
const data = await res.json();
const text = (data.response || "").trim().slice(0, 200);
console.log(`OK — model=${model} response=${JSON.stringify(text)}`);
process.exit(0);
