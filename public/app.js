// Streams an answer from /api/ask and shows it with numbered citations and its sources.
const $ = (id) => document.getElementById(id);
const UNREACHABLE = 'The assistant could not be reached. Please try again, or contact the Fair Work Ombudsman on 13 13 94.';

/** Answer text with [n] turned into small citation marks. Built from text nodes, never innerHTML. */
function render(el, text) {
  el.replaceChildren();
  for (const part of text.split(/(\[\d+\])/)) {
    if (/^\[\d+\]$/.test(part)) {
      const mark = document.createElement('span');
      mark.className = 'cite';
      mark.textContent = part.slice(1, -1);
      el.append(mark);
    } else el.append(document.createTextNode(part));
  }
}

function showSources(sources, text) {
  const list = $('sources');
  list.replaceChildren();
  const cited = sources.filter((s) => text.includes(`[${s.n}]`));
  for (const s of cited.length ? cited : sources.slice(0, 2)) {
    const li = document.createElement('li');
    const n = document.createElement('span');
    n.className = 'n';
    n.textContent = s.n;
    const a = document.createElement('a');
    a.href = s.url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = s.title;
    li.append(n, a);
    list.append(li);
  }
}

async function ask(question) {
  const out = $('text');
  $('answer').hidden = false;
  $('asked').textContent = question;
  out.textContent = '';
  out.classList.add('waiting');
  $('sources').replaceChildren();
  $('go').disabled = true;
  let text = '';
  let sources = [];
  try {
    const res = await fetch('/api/ask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question }) });
    if (!res.ok || !res.body) {
      const body = await res.json().catch(() => null);
      text = body?.error ?? UNREACHABLE;
    } else {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const e = JSON.parse(line);
          if (e.type === 'sources') sources = e.sources;
          else if (e.type === 'delta') text += e.text;
          else if (e.type === 'replace') {
            text = e.text;
            sources = [];
          }
        }
        out.classList.toggle('waiting', !text);
        render(out, text);
      }
    }
  } catch {
    text ||= UNREACHABLE;
  }
  out.classList.remove('waiting');
  render(out, text || UNREACHABLE);
  showSources(sources, text);
  $('go').disabled = false;
}

$('ask').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = $('q').value.trim();
  if (q) ask(q);
});
$('try').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  $('q').value = b.textContent;
  ask(b.textContent);
});
