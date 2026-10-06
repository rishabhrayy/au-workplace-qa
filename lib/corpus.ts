import fs from 'node:fs';
import path from 'node:path';
import { chunk, type Doc, type Passage } from 'ask-rishabh';

export const ACT_URL = 'https://www.legislation.gov.au/C2009A00028/latest/text';
export const ATTRIBUTION =
  'Based on content from the Federal Register of Legislation. For the latest information on Australian Government legislation please go to https://www.legislation.gov.au.';

export type Corpus = {
  compilation: string;
  asAt: string;
  sections: { number: string; title: string; part: string; division: string; topic: string; text: string }[];
};

export function loadCorpus(root = path.resolve(import.meta.dirname, '..')): Corpus {
  return JSON.parse(fs.readFileSync(path.join(root, 'data', 'sections.json'), 'utf8')) as Corpus;
}

/** "Division 11 - Notice of termination and redundancy pay" -> "Notice of termination and redundancy pay" */
const label = (heading: string) => heading.replace(/^(Part|Division)\s+[\w-]+\s+-\s+/, '');

/**
 * One document per section, titled the way people cite it ("s 117 ...") and carrying its
 * division name, so "annual leave" matches every section in the Annual leave division even
 * where the section itself only says "the leave".
 */
export function sectionDocs(corpus: Corpus): Doc[] {
  return corpus.sections.map((s) => ({
    id: s.number,
    title: `s ${s.number} ${s.title}`,
    url: ACT_URL,
    text: `${label(s.division) || label(s.part)}. ${s.text}`,
  }));
}

/** Sections split into passages of about 350 tokens; long sections become several. */
export const passages = (corpus: Corpus): Passage[] => chunk(sectionDocs(corpus), 1400);
