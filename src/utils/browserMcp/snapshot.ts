/**
 * Source of the in-page function that produces the accessibility snapshot.
 *
 * Replaces Playwright's `_snapshotForAI`: walks the rendered DOM (piercing open
 * shadow roots), keeps only visible semantic/interactive nodes, and emits a
 * compact indented tree where every actionable element gets a stable `[ref=eN]`.
 * The ref→element map is stashed on `window.__brefMap` so a later
 * `browser_click`/`browser_type` can resolve `eN` back to the live element
 * within the same document. Evaluated via `Runtime.evaluate({returnByValue})`.
 *
 * Kept as a string (not a real function) because it executes in the *page*, not
 * in our runtime — it must be self-contained with no outside references.
 */
export const SNAPSHOT_FN = String.raw`
(() => {
  const map = {};
  let counter = 0;
  const out = [];
  const SKIP = new Set(['script','style','noscript','template','head','meta','link','svg','path','br']);
  const ROLE_TAG = { a:'link', button:'button', select:'combobox', textarea:'textbox',
    nav:'navigation', main:'main', form:'form', h1:'heading', h2:'heading', h3:'heading',
    h4:'heading', h5:'heading', h6:'heading', img:'img', table:'table', ul:'list', ol:'list', li:'listitem' };
  function vis(el) {
    const s = window.getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  function roleOf(el) {
    const explicit = el.getAttribute && el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'button' || t === 'submit' || t === 'reset') return 'button';
      if (t === 'hidden') return null;
      return 'textbox';
    }
    return ROLE_TAG[tag] || null;
  }
  function nameOf(el) {
    const direct = el.getAttribute && (el.getAttribute('aria-label') ||
      el.getAttribute('placeholder') || el.getAttribute('alt') || el.getAttribute('title'));
    let n = direct || el.value || '';
    if (!n) {
      // own text only (don't pull in deep descendant text for containers)
      let t = '';
      for (const c of el.childNodes) if (c.nodeType === 3) t += c.textContent;
      n = t.trim();
      if (!n && el.children.length === 0) n = (el.textContent || '').trim();
    }
    return String(n).replace(/\s+/g, ' ').trim().slice(0, 160);
  }
  function interactive(el) {
    const tag = el.tagName.toLowerCase();
    if (['a','button','input','textarea','select','option'].includes(tag)) return true;
    if (el.hasAttribute('onclick')) return true;
    if (typeof el.tabIndex === 'number' && el.tabIndex >= 0 && el.getAttribute('tabindex') !== null) return true;
    const r = el.getAttribute('role');
    return ['button','link','checkbox','radio','tab','menuitem','switch','option','combobox','textbox'].includes(r);
  }
  function kids(node) {
    const list = [];
    if (node.shadowRoot) for (const c of node.shadowRoot.children) list.push(c);
    for (const c of node.children) list.push(c);
    return list;
  }
  function walk(node, depth) {
    for (const el of kids(node)) {
      if (!el.tagName) continue;
      const tag = el.tagName.toLowerCase();
      if (SKIP.has(tag)) continue;
      if (!vis(el)) continue;
      const role = roleOf(el);
      const isInt = interactive(el);
      if (role || isInt) {
        const name = nameOf(el);
        let ref = '';
        if (isInt) { const id = 'e' + (++counter); map[id] = el; ref = ' [ref=' + id + ']'; }
        const label = role || tag;
        const namePart = name ? ' "' + name.replace(/"/g, "'") + '"' : '';
        out.push('  '.repeat(Math.min(depth, 12)) + '- ' + label + namePart + ref);
        walk(el, depth + 1);
      } else {
        walk(el, depth);
      }
    }
  }
  try { window.__brefMap = map; } catch (e) {}
  const root = document.body || document.documentElement;
  if (root) walk(root, 0);
  const title = (document.title || '').slice(0, 200);
  const url = location.href;
  let text = '- url: ' + url + '\n- title: ' + title + '\n' + out.join('\n');
  if (text.length > 24000) text = text.slice(0, 24000) + '\n… (snapshot truncated)';
  return text;
})()
`
