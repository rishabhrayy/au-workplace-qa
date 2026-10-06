import fs from 'node:fs';
import path from 'node:path';

/** Reads KEY=value lines from .env.local into process.env (never overriding what is already set). */
export function loadEnv(root = path.resolve(import.meta.dirname, '..')) {
  for (const file of ['.env.local', '.env']) {
    const full = path.join(root, file);
    if (!fs.existsSync(full)) continue;
    for (const line of fs.readFileSync(full, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*?)"?\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  }
}
