/**
 * Fetches the Fair Work Act 2009 from the Federal Register of Legislation's official API and
 * turns the sections people actually ask about into plain-text documents.
 *
 * One download per compilation (cached in data/raw), well inside the site's 10-second crawl
 * delay, with an identifying user agent. The Act is licensed CC BY 4.0:
 * "Based on content from the Federal Register of Legislation at <date>. For the latest
 * information on Australian Government legislation please go to https://www.legislation.gov.au."
 *
 * Output: data/sections.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { strFromU8, unzipSync } from 'fflate';

const ROOT = path.resolve(import.meta.dirname, '..');
const RAW = path.join(ROOT, 'data', 'raw');
const UA = 'au-workplace-qa/0.1 (portfolio research project; +https://rishabhray.me)';
const API = 'https://api.prod.legislation.gov.au/v1';
const TITLE = 'C2009A00028';

/** The parts of the Act everyday questions are about */
export const SCOPE: { from: string; to: string; topic: string }[] = [
  { from: '15A', to: '15F', topic: 'Casual employment' },
  { from: '59', to: '131', topic: 'National Employment Standards' },
  { from: '323', to: '333', topic: 'Payment of wages' },
  { from: '333M', to: '333U', topic: 'Right to disconnect' },
  { from: '379', to: '398', topic: 'Unfair dismissal' },
];

export type ActSection = {
  number: string;
  title: string;
  part: string;
  division: string;
  topic: string;
  text: string;
};

/** "87" < "87A" < "88"; compares a section number's digits, then its letters */
export function compareSection(a: string, b: string): number {
  const pa = a.match(/^(\d+)([A-Z]*)$/)!;
  const pb = b.match(/^(\d+)([A-Z]*)$/)!;
  return Number(pa[1]) - Number(pb[1]) || pa[2].localeCompare(pb[2]);
}

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, '')
    .replace(/&#xa0;|&nbsp;/g, ' ')
    .replace(/&#x2011;|&#x2010;/g, '-')
    .replace(/&#x2014;|&#x2013;|—|–/g, ' - ')
    .replace(/&#x201[89];|&rsquo;|&lsquo;/g, "'")
    .replace(/&#x201[cd];/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\s+/g, ' ')
    .trim();

/** Walks the Act's paragraphs and tables in order, grouping them under their section heading. */
export function parseAct(html: string): Omit<ActSection, 'topic'>[] {
  const sections: Omit<ActSection, 'topic'>[] = [];
  let part = '';
  let division = '';
  let current: Omit<ActSection, 'topic'> | null = null;
  for (const m of html.matchAll(/<p\b[^>]*class="([^"]*)"[^>]*>([\s\S]*?)<\/p>|<table\b[\s\S]*?<\/table>/g)) {
    if (!m[1]) {
      // a table: one line per row, cells separated by |
      if (!current) continue;
      const rows = [...m[0].matchAll(/<tr\b[\s\S]*?<\/tr>/g)].map((r) =>
        [...r[0].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) => text(c[1])).filter(Boolean).join(' | '),
      );
      current.text += `\n${rows.filter(Boolean).join('\n')}`;
      continue;
    }
    const cls = m[1];
    const body = m[2];
    if (cls.startsWith('TOC')) continue;
    if (cls === 'ActHead2') {
      part = text(body);
      division = '';
    } else if (cls === 'ActHead3') {
      division = text(body);
    } else if (cls === 'ActHead5') {
      const number = text(body.match(/<span class="CharSectno">([\s\S]*?)<\/span>/)?.[1] ?? '');
      const title = text(body.replace(/<span class="CharSectno">[\s\S]*?<\/span>/, ''));
      current = { number, title, part, division, text: '' };
      sections.push(current);
    } else if (current && !/^(ActHead|CharPart|CharDiv)/.test(cls)) {
      const line = text(body);
      if (!line) continue;
      // subsection heads stand on their own line; numbered paragraphs follow their stem
      current.text += cls === 'SubsectionHead' ? `\n\n${line}:` : `\n${line}`;
    }
  }
  return sections.map((s) => ({ ...s, text: s.text.trim() }));
}

async function download(): Promise<{ html: string; compilation: string; asAt: string }> {
  const meta = path.join(RAW, 'act-version.json');
  const epub = path.join(RAW, 'fair-work-act-2009.epub');
  if (!fs.existsSync(meta) || process.argv.includes('--refresh')) {
    const headers = { 'user-agent': UA, accept: 'application/json' };
    const v = (await (await fetch(`${API}/versions/Find(titleId='${TITLE}',asAtSpecification='Latest')`, { headers })).json()) as {
      start: string;
      retrospectiveStart: string;
      compilationNumber: string;
      registerId: string;
    };
    const day = (d: string) => d.slice(0, 10);
    const url = `${API}/documents(titleid='${TITLE}',start=${day(v.start)},retrospectivestart=${day(v.retrospectiveStart)},rectificationversionnumber=0,type='Primary',uniqueTypeNumber=0,volumeNumber=0,format='Epub')`;
    await new Promise((r) => setTimeout(r, 10000)); // the register's crawl delay
    const res = await fetch(url, { headers: { 'user-agent': UA } });
    if (!res.ok) throw new Error(`download failed: ${res.status}`);
    fs.writeFileSync(epub, Buffer.from(await res.arrayBuffer()));
    fs.writeFileSync(meta, JSON.stringify({ compilation: v.compilationNumber, registerId: v.registerId, inForceFrom: day(v.start), downloaded: new Date().toISOString().slice(0, 10) }));
  }
  // An EPUB is a zip: the Act's text is OEBPS/document_N/document_N.html, in volume order
  const zip = unzipSync(new Uint8Array(fs.readFileSync(epub)));
  const files = Object.keys(zip)
    .filter((name) => /^OEBPS\/document_\d+\/document_\d+\.html$/.test(name))
    .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
  const { compilation, downloaded } = JSON.parse(fs.readFileSync(meta, 'utf8'));
  return { html: files.map((f) => strFromU8(zip[f])).join('\n'), compilation, asAt: downloaded };
}

async function main() {
  fs.mkdirSync(RAW, { recursive: true });
  const { html, compilation, asAt } = await download();
  const all = parseAct(html);
  const seen = new Set<string>();
  const sections: ActSection[] = [];
  for (const s of all) {
    // Only the body of the Act: its parts are "Part 2-2" style. The transitional schedules restart
    // section numbering under parts like "Part 13", and would otherwise pass for NES sections.
    if (!/^\d+[A-Z]*$/.test(s.number) || seen.has(s.number) || !/^Part \d+-\d+\b/.test(s.part)) continue;
    const scope = SCOPE.find((r) => compareSection(s.number, r.from) >= 0 && compareSection(s.number, r.to) <= 0);
    if (!scope || s.text.length < 40) continue;
    seen.add(s.number);
    sections.push({ ...s, topic: scope.topic });
  }
  const out = { source: 'Fair Work Act 2009 (Cth)', compilation, asAt, licence: 'CC BY 4.0', sections };
  fs.writeFileSync(path.join(ROOT, 'data', 'sections.json'), JSON.stringify(out, null, 1));
  console.log(`Compilation ${compilation}, downloaded ${asAt}: ${sections.length} sections`);
  for (const { topic } of SCOPE) {
    const list = sections.filter((s) => s.topic === topic);
    if (list.length) console.log(`  ${topic}: ${list.length} (s ${list[0].number} to s ${list[list.length - 1].number})`);
  }
}

if (process.argv[1]?.endsWith('fetch-act.ts')) await main();
