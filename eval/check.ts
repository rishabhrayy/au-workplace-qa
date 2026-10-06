/**
 * Checks the test set against the law itself: every expected section must exist, and every
 * fact must appear in at least one of its expected sections. A wrong answer key would make
 * every number the evaluation reports meaningless, so this runs before anything else.
 */
import fs from 'node:fs';
import path from 'node:path';

type Q = { q: string; expect?: string[]; facts?: string[]; notInAct?: boolean };
const here = import.meta.dirname;
const { questions } = JSON.parse(fs.readFileSync(path.join(here, 'questions.json'), 'utf8')) as { questions: Q[] };
const { sections } = JSON.parse(fs.readFileSync(path.join(here, '..', 'data', 'sections.json'), 'utf8')) as {
  sections: { number: string; title: string; text: string }[];
};
const flat = (s: string) => s.toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, ' ');
const byNumber = new Map(sections.map((s) => [s.number, flat(`${s.title} ${s.text}`)]));

const problems: string[] = [];
for (const q of questions) {
  if (q.notInAct) continue;
  for (const n of q.expect ?? []) if (!byNumber.has(n)) problems.push(`no section ${n}: ${q.q}`);
  for (const f of q.facts ?? []) {
    if (!(q.expect ?? []).some((n) => byNumber.get(n)?.includes(flat(f)))) problems.push(`fact "${f}" not in s ${q.expect?.join('/')}: ${q.q}`);
  }
}
const answerable = questions.filter((q) => !q.notInAct).length;
console.log(`${questions.length} questions (${answerable} answerable, ${questions.length - answerable} not in the Act)`);
if (problems.length) {
  console.log(problems.join('\n'));
  process.exit(1);
}
console.log('Every expected section exists and every fact appears in one of them.');
