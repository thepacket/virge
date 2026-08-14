// Markdown and LaTeX for the assistant's replies.
//
// Two constraints shape this, and both point the same way.
//
// 1. The reply is not trusted input. It is written by a model that has just
//    read a GenBank file the user dropped in — feature labels, definitions and
//    notes are attacker-controllable text in someone else's file. So the HTML
//    is sanitised, always, and never assembled by string concatenation that
//    could smuggle a tag through.
//
// 2. VIRGE's Content Security Policy is `style-src 'self'` with no
//    'unsafe-inline'. KaTeX's default HTML output writes inline style
//    attributes — four on `x^2` alone — which that policy blocks, and the usual
//    fix is to weaken the policy. Rendering to **MathML** instead emits zero
//    inline styles and needs no webfonts, so the strict CSP stands and ~1 MB of
//    KaTeX font files never enters the bundle. Browsers render MathML Core
//    natively.
import { marked } from "marked";
import createDOMPurify from "dompurify";
import katex from "katex";

// Placeholder for extracted math. Deliberately plain alphanumerics: anything
// with punctuation risks being mangled or escaped by the markdown pass, and the
// substitution would then silently fail to find it again.
const MATH_TOKEN = (i) => `xKaTeXMathToken${i}x`;

/**
 * Pull LaTeX out before markdown runs, so `*` and `_` inside a formula are not
 * eaten as emphasis. Returns the text with placeholders plus the extracted
 * expressions, in order.
 *
 * Delimiters are `$$…$$` and `\[…\]` for display, `$…$` and `\(…\)` for inline.
 * A bare `$` needs a non-space immediately inside it, so "costs $5 to $10" is
 * left alone rather than being read as a formula.
 */
export function splitMath(src) {
  const math = [];
  const keep = (tex, display) => {
    math.push({ tex: tex.trim(), display });
    return MATH_TOKEN(math.length - 1);
  };
  const text = String(src)
    .replace(/\$\$([\s\S]+?)\$\$/g, (_, tex) => keep(tex, true))
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, tex) => keep(tex, true))
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, tex) => keep(tex, false))
    .replace(/\$(?!\s)((?:[^$\n\\]|\\.)+?)(?<!\s)\$/g, (_, tex) => keep(tex, false));
  return { text, math };
}

/** Render one expression, or return the source text if it will not parse.
 *  A malformed formula should read as the LaTeX the model wrote, not vanish. */
function renderMath({ tex, display }) {
  try {
    const html = katex.renderToString(tex, {
      output: "mathml",       // no inline styles, no webfonts — see the header
      displayMode: display,
      throwOnError: true,
      strict: false,
    });
    // KaTeX wraps the markup in <semantics> with an <annotation> holding the
    // original TeX. DOMPurify's MathML profile drops both tags — rightly, since
    // <annotation-xml> can carry HTML and is a known mXSS vector — but it keeps
    // their *text*, so the raw LaTeX rendered as a second line under every
    // equation. Removing the annotation here is better than allowing the tags:
    // the source TeX is only there for copy-paste, and the alternative is
    // widening the sanitiser at the one point it is guarding a real hole.
    return html.replace(/<annotation\b[\s\S]*?<\/annotation>/g, "");
  } catch {
    return `<code>${tex.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]))}</code>`;
  }
}

// A window is needed to sanitise. The browser has one; the tests supply jsdom's.
// Injectable rather than module-global so the tests exercise this exact path.
//
// createDOMPurify returns the *factory* again when handed something that is not
// a usable DOM, and that object's `sanitize` is a passthrough — so a missing
// check here does not fail loudly, it silently stops sanitising. The guard
// below is therefore on `isSupported`, not on truthiness.
let purify = null;
export function configureSanitizer(win) {
  const p = win ? createDOMPurify(win) : null;
  purify = p && p.isSupported ? p : null;
  return !!purify;
}
if (typeof window !== "undefined") configureSanitizer(window);

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const PURIFY_OPTIONS = {
  // `style` is dropped rather than trusted: the CSP would block it anyway, and
  // an attribute that silently does nothing is worse than one that is absent.
  FORBID_ATTR: ["style"],
  FORBID_TAGS: ["style", "form", "input", "button", "iframe", "object", "embed"],
  // MathML is the point of the KaTeX configuration above, so it must survive.
  USE_PROFILES: { html: true, mathMl: true },
  ADD_ATTR: ["target", "rel"],
};

/**
 * Markdown + LaTeX → sanitised HTML.
 *
 * Order matters: math is extracted first so markdown cannot chew on it, the
 * markdown is rendered, the maths are substituted back, and only then is the
 * whole thing sanitised — so KaTeX's own output is subject to the same filter
 * as the model's prose rather than being trusted because we generated it.
 */
export function renderMarkdown(src) {
  const { text, math } = splitMath(src ?? "");
  let html = marked.parse(text, { breaks: true, gfm: true, async: false });
  math.forEach((m, i) => {
    html = html.replaceAll(MATH_TOKEN(i), renderMath(m));
  });
  // No working sanitiser is a reason to render *less*, never more. Returning the
  // raw HTML here would turn an environment problem into an injection hole in
  // the one place the input is least trustworthy, so the text is escaped and
  // shown verbatim instead — ugly, and safe.
  if (!purify) return `<p>${escapeHtml(src ?? "")}</p>`;
  return purify.sanitize(html, PURIFY_OPTIONS);
}
