#!/usr/bin/env node
/**
 * OpenCode smoke: NVIDIA NIM API first, Ollama fallback.
 * Loads .env from project root. Requires opencode on PATH.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadDotenv } from '../lib/load-dotenv.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
loadDotenv(root);

const nimModel = process.env.NVIDIA_MODEL || 'deepseek-ai/deepseek-v4-pro';
const primary =
  process.env.OPENCODE_MODEL ||
  (process.env.NVIDIA_API_KEY ? `nvidia-nim/${nimModel}` : '');
const fallback = process.env.OPENCODE_MODEL_FALLBACK || 'ollama/gemma4:e4b';
const ms = Number(process.env.OPENCODE_VERIFY_MS || 180000);
const prompt = 'Reply with exactly this JSON: {"verify":"opencode-llm"}';

function runOpenCode(model) {
  return new Promise((resolve) => {
    const child = spawn(
      'opencode',
      [
        'run',
        '--pure',
        '--dir',
        root,
        '-m',
        model,
        '--dangerously-skip-permissions',
        prompt,
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
      },
    );

    let out = '';
    let err = '';
    child.stdout?.on('data', (d) => {
      out += d;
    });
    child.stderr?.on('data', (d) => {
      err += d;
    });

    const t = setTimeout(() => child.kill('SIGTERM'), ms);

    child.on('close', (code, signal) => {
      clearTimeout(t);
      const combined = out + err;
      const modelNotFound = /Model not found|ProviderModelNotFoundError/i.test(combined);
      const okMarker = /opencode-llm|"verify"/i.test(combined);
      resolve({
        model,
        code: code ?? 1,
        signal,
        combined: combined.slice(-4000),
        modelNotFound,
        ok: code === 0 && okMarker && !modelNotFound,
      });
    });
  });
}

async function main() {
  if (!primary) {
    console.error('Set NVIDIA_API_KEY in .env or OPENCODE_MODEL=nvidia-nim/<model>');
    process.exit(1);
  }

  console.log(`Trying primary: ${primary}`);
  const first = await runOpenCode(primary);
  if (first.ok) {
    console.log(`OK — OpenCode + ${primary}`);
    process.exit(0);
  }

  console.warn(`Primary failed (${primary}): code=${first.code} modelNotFound=${first.modelNotFound}`);
  if (first.combined) console.warn(first.combined.slice(-1500));

  console.log(`Trying fallback: ${fallback}`);
  const second = await runOpenCode(fallback);
  if (second.ok) {
    console.log(`OK — OpenCode fallback ${fallback} (fix NVIDIA NIM: API key, model id, or quota)`);
    process.exit(0);
  }

  console.error(`Fallback failed (${fallback}): code=${second.code}`);
  if (second.combined) console.error(second.combined.slice(-2000));
  process.exit(second.code || 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
