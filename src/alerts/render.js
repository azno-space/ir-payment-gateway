'use strict';
// Turns an alert document into the text one chat platform accepts.
// A document is { header, blocks, tags, time }. Blocks: {t:'text',v,copyable?} {t:'field',label,v} {t:'pre',label,v}.
// Telegram gets HTML (every dynamic value escaped). Bale gets plain text only: it prints tags.

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&amp;/g, '&');

// Decode first, strip tags second: otherwise "&lt;b&gt;" would decode into a tag after the strip.
function toPlain(s) {
  let t = String(s ?? '');
  for (let i = 0; i < 3; i++) { const n = unesc(t); if (n === t) break; t = n; }
  return t.replace(/<\/?[a-z][^>]*>/gi, '');
}

const cut = (s, n) => (s.length > n ? `${s.slice(0, Math.max(0, n - 14))}… (کوتاه شد)` : s);
const hasPersian = (s) => /[؀-ۿ]/.test(s);
const stripLeadingEmoji = (s) => String(s || '').replace(/^[\p{Extended_Pictographic}️‍\s]+/u, '');

// Wraps each copyable value found in the (escaped) text in <code>.
function wrapCode(escaped, values = []) {
  let out = escaped;
  for (const v of values) {
    const e = esc(toPlain(v));
    if (e.length >= 3) out = out.split(e).join(`<code>${e}</code>`);
  }
  return out;
}

function renderBlock(b, tg, caps) {
  if (b.t === 'text') {
    const v = cut(toPlain(b.v), caps.msg);
    return [tg ? wrapCode(esc(v), b.copyable) : v, ''];
  }
  if (b.t === 'field') {
    const v = cut(toPlain(b.v), 300);
    if (hasPersian(v)) return [`${b.label}: ${tg ? esc(v) : v}`];
    return [`${b.label}:`, tg ? `<code>${esc(v)}</code>` : v];
  }
  if (b.t === 'pre' && caps.pre > 0) {
    const v = cut(toPlain(b.v), caps.pre);
    return [tg ? `⚙️ <b>${b.label}:</b>\n<pre>${esc(v)}</pre>` : `⚙️ ${b.label}:\n${v}`, ''];
  }
  return [];
}

function build(doc, tg, caps) {
  const parts = [tg ? `<b>${esc(toPlain(doc.header))}</b>` : toPlain(doc.header), ''];
  for (const b of doc.blocks) parts.push(...renderBlock(b, tg, caps));
  if (doc.time) parts.push(`⏰ ${doc.time}`);
  if (doc.tags && doc.tags.length) parts.push('', doc.tags.join(' '));
  return parts.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Shrinks the long parts step by step until the text fits the platform limit.
function render(doc, platform, limit = 4096) {
  const tg = platform === 'telegram';
  for (const [msg, pre] of [[2500, 1200], [1200, 400], [500, 0], [200, 0]]) {
    const text = build(doc, tg, { msg, pre });
    if (text.length <= limit) return text;
  }
  return cut(build(doc, tg, { msg: 200, pre: 0 }), limit); // field-heavy: last resort, may drop trailing lines
}

module.exports = { render, toPlain, esc, cut, stripLeadingEmoji };
