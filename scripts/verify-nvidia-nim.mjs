#!/usr/bin/env node
/**
 * Direct NVIDIA NIM API smoke (no OpenCode). Loads .env from project root.
 */
import { loadDotenv } from '../lib/load-dotenv.mjs';
import { fileURLToPath } from 'url';
import path from 'path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
loadDotenv(root);

const apiKey = process.env.NVIDIA_API_KEY;
const model = process.env.NVIDIA_MODEL || 'deepseek-ai/deepseek-v4-pro';

if (!apiKey) {
  console.error('NVIDIA_API_KEY missing in .env');
  process.exit(1);
}

const res = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    model,
    messages: [{ role: 'user', content: 'Reply with exactly: {"verify":"nvidia-nim"}' }],
    temperature: 1,
    top_p: 0.95,
    max_tokens: 256,
    stream: false,
    chat_template_kwargs: { thinking: false },
  }),
});

const text = await res.text();
if (!res.ok) {
  console.error(`NIM HTTP ${res.status}:`, text.slice(0, 500));
  process.exit(1);
}

let body;
try {
  body = JSON.parse(text);
} catch {
  console.error('Invalid JSON:', text.slice(0, 300));
  process.exit(1);
}

const content = body.choices?.[0]?.message?.content || '';
if (!/nvidia-nim|"verify"/i.test(content)) {
  console.warn('Unexpected response:', content.slice(0, 300));
  process.exit(2);
}

console.log(`OK — NVIDIA NIM ${model}`);
console.log(content.slice(0, 120));
