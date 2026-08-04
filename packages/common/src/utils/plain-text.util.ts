/**
 * HTML → one line of plain text, for surfaces that render text and nothing else:
 * FCM notification bodies, notification titles, push previews.
 *
 * Post content is stored as editor HTML (`<p>…</p>`, mention `<span>`s) and
 * `post.excerpt` is a raw 200-char slice of it, so a notification body built
 * from an excerpt used to reach the device as literal `<p>p adu</p>`. Android
 * and iOS both render the FCM `body` verbatim — there is no client-side
 * sanitiser to fall back on.
 *
 * Distinct from `sanitizeContent` (comment.service), which guards what gets
 * STORED: it drops tags without leaving a word boundary and keeps entities
 * verbatim, both correct for content the client re-renders. This one is for
 * DISPLAY, so it joins block boundaries with a space, decodes entities, and
 * collapses the whitespace HTML left behind.
 *
 * The output is guaranteed to contain no `<` or `>` at all — entities are
 * decoded first and any bracket they produce is replaced afterwards, so a
 * `&lt;script&gt;` in the source cannot be decoded back into markup.
 *
 * Every regex here scans linearly with no nested quantifiers (no ReDoS surface
 * on uncontrolled member input); the tag scan avoids regex entirely.
 */

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  '#39': "'",
};

// Does `c` make a `<` start a tag? Mirrors the browser rule: a `<` only opens
// a tag when followed by a letter, `/`, `!` or `?` (so "5 < 10" stays text).
function opensTag(c: string | undefined): boolean {
  if (c === undefined) return false;
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '/' || c === '!' || c === '?';
}

// Tags become a space rather than nothing: `<p>a</p><p>b</p>` is two paragraphs,
// and dropping the tags outright would jam them into "ab". The whitespace
// collapse at the end cleans up the spaces this over-produces.
function stripTags(input: string): string {
  let out = '';
  let i = 0;
  const n = input.length;
  while (i < n) {
    const ch = input[i];
    if (ch === '<' && opensTag(input[i + 1])) {
      const close = input.indexOf('>', i + 1);
      // No `>` means the input was cut mid-tag — a 200-char excerpt slice does
      // this routinely. Drop the remainder; it is markup, not text.
      if (close === -1) break;
      out += ' ';
      i = close + 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function decodeEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-f]{1,6});/gi, (m, hex: string) => codePoint(Number.parseInt(hex, 16), m))
    .replace(/&#(\d{1,7});/g, (m, dec: string) => codePoint(Number.parseInt(dec, 10), m))
    .replace(/&([a-z]+);/gi, (m, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
}

function codePoint(code: number, original: string): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return original;
  try {
    return String.fromCodePoint(code);
  } catch {
    return original;
  }
}

/**
 * Returns a single line of plain text — tags removed, entities decoded,
 * whitespace collapsed, trimmed. Never returns markup.
 */
export function toPlainText(input: string): string {
  if (!input) return '';
  const decoded = decodeEntities(stripTags(input));
  let out = '';
  for (const ch of decoded) {
    // Anything an entity decoded back into a bracket is replaced here, so the
    // result can never be re-interpreted as markup by a client that renders
    // HTML. A space rather than nothing, for the same reason tags become one:
    // `&lt;b&gt;tebal` should read "b tebal", not "btebal".
    out += ch === '<' || ch === '>' ? ' ' : ch;
  }
  return out.replace(/\s+/g, ' ').trim();
}
