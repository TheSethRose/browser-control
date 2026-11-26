(() => {
  const VERSION = 7;
  if (globalThis.__bc && globalThis.__bc.v === VERSION) return;

  const INTERACTIVE = [
    'a[href]', 'button', 'input:not([type="hidden"])', 'select', 'textarea', 'summary',
    '[contenteditable=""]', '[contenteditable="true"]', '[tabindex]:not([tabindex="-1"])',
    '[role="button"]', '[role="link"]', '[role="textbox"]', '[role="checkbox"]', '[role="radio"]',
    '[role="tab"]', '[role="menuitem"]', '[role="menuitemcheckbox"]', '[role="menuitemradio"]',
    '[role="switch"]', '[role="combobox"]', '[role="option"]', '[role="searchbox"]',
    '[role="slider"]', '[role="spinbutton"]', '[role="treeitem"]',
  ].join(',');
  const CONTEXT = 'h1,h2,h3,h4,h5,h6,[role="heading"],label,p,li,[role="alert"],[role="status"],[role="dialog"]';
  const LIMIT = 250;
  const DIAG_MAX = 30;

  const HONEYPOT_NAME = /honeypot|honey.?pot|bot.?field|leave.?this.?empty|do.?not.?fill|anti.?spam|gotcha|trap.?field/i;
  const PAYMENT_FIELD = /card.?number|cardnumber|cc-?(number|csc|exp)|ccnumber|cvc|cvv|expir(y|ation)|security.?code|iban|account.?number|routing.?number|payment.?method/i;
  const SUCCESS_TEXT = /thank you|thanks for|successfully|has been (submitted|received|added|saved|sent)|we(?:'| ha)ve received|submission (received|complete)|pending review|under review|awaiting (approval|moderation)|check your (e-?mail|inbox)|confirmation (e-?mail|link)/i;
  const REJECT_TEXT = /please (fix|correct|complete|check)|(is |are )required\b|invalid\b|error(s)? (below|above|occurred|found)|something went wrong|could not (be )?(submit|process|save)|failed to|try again|not a valid|must (be|contain|not)|too (short|long|large|many)/i;
  const REJECT_SURFACE = '[role="alert"], [aria-invalid="true"], .error, .form-error, .field-error, .invalid-feedback';
  const DISMISS_TEXT = /^(close|dismiss|cancel|no thanks|not now|skip|reject( all)?|decline|necessary only|×|✕|x)$/i;

  // Refs are stable: an element keeps its ref for as long as it stays in the document.
  const refs = new Map();
  const ids = new WeakMap();
  const refMeta = new Map();
  // Sticky secret tracking: once a field is secret, it stays secret even if toggled to type="text".
  const secretEls = new WeakSet();
  let nextId = 1;
  let base = null;
  let baseEntries = null;
  let baseMutation = -1;
  let baseFull = false;
  let lastScan = null;
  let lastSnapView = null;
  let frameEls = [];
  let lastMutation = 0;
  let leaving = false;
  let wallCache;
  let inputProbe = null;

  // Passive status-only ring buffer (4xx/5xx resource responses + uncaught JS errors).
  const diag = [];
  let diagSeq = 0;
  let baseDiagSeq = 0;
  const pushDiag = (line) => {
    diag.push({ seq: ++diagSeq, line });
    if (diag.length > DIAG_MAX) diag.shift();
  };

  const clean = (s, n = 80) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
  const safePath = (u) => {
    try {
      const p = new URL(u, location.href);
      return p.origin === location.origin ? p.pathname : `${p.origin}${p.pathname}`;
    } catch {
      return String(u || '').split('?')[0].slice(0, 120);
    }
  };

  const isLuhnValid = (digits) => {
    if (!/^\d{13,19}$/.test(digits)) return false;
    let sum = 0;
    let alt = false;
    for (let i = digits.length - 1; i >= 0; i--) {
      let n = digits.charCodeAt(i) - 48;
      if (alt) { n *= 2; if (n > 9) n -= 9; }
      sum += n;
      alt = !alt;
    }
    return sum % 10 === 0;
  };
  const maskCard = (s) => String(s || '').replace(/\d(?:[ -]?\d){12,18}/g, (m) => {
    const d = m.replace(/[ -]/g, '');
    return isLuhnValid(d) ? '••••' : m;
  });

  try {
    new MutationObserver(() => { lastMutation = performance.now(); wallCache = undefined; })
      .observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    globalThis.navigation?.addEventListener('navigate', (e) => { if (!e.destination.sameDocument) leaving = true; });
  } catch { /* observers are an optimisation only */ }

  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.responseStatus >= 400) {
          pushDiag(`# HTTP ${e.responseStatus} (${e.initiatorType || 'res'}) ${safePath(e.name)}`);
        }
      }
    }).observe({ type: 'resource', buffered: false });
  } catch { /* PerformanceObserver responseStatus may be unavailable */ }

  try {
    globalThis.addEventListener?.('error', (e) => {
      const msg = e.error?.message || e.message || 'uncaught error';
      pushDiag(`# JS error: ${clean(msg, 120)}`);
    });
    globalThis.addEventListener?.('unhandledrejection', (e) => {
      const r = e.reason;
      const msg = r && typeof r === 'object' && 'message' in r ? r.message : String(r || 'unhandled rejection');
      pushDiag(`# JS error: ${clean(msg, 120)}`);
    });
  } catch { /* ignore */ }

  const styleIfShown = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    const st = getComputedStyle(el);
    return st.display !== 'none' && st.visibility !== 'hidden' && st.visibility !== 'collapse' ? st : null;
  };
  const shown = (el) => !!styleIfShown(el);

  function* roots(start) {
    const stack = [start];
    while (stack.length) {
      const root = stack.pop();
      yield root;
      const walker = (root.ownerDocument || root).createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      const found = [];
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (n.shadowRoot) found.push(n.shadowRoot);
        if (n.tagName === 'IFRAME' || n.tagName === 'FRAME') {
          try { if (n.contentDocument) found.push(n.contentDocument); } catch { /* cross-origin */ }
        }
      }
      stack.push(...found.reverse());
    }
  }

  const roleOf = (el) => {
    const explicit = el.getAttribute?.('role');
    if (explicit) return explicit.split(' ')[0];
    const tag = (el.tagName || '').toLowerCase();
    const type = (el.getAttribute?.('type') || 'text').toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return el.multiple ? 'listbox' : 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'li') return 'listitem';
    if (tag === 'p') return 'text';
    if (tag === 'input') {
      return ({ checkbox: 'checkbox', radio: 'radio', range: 'slider', number: 'spinbutton', search: 'searchbox',
        submit: 'button', button: 'button', reset: 'button', image: 'button', file: 'file' })[type] || 'textbox';
    }
    if (el.isContentEditable) return 'textbox';
    return tag;
  };

  const nameOf = (el) => {
    const doc = el.ownerDocument;
    const by = el.getAttribute?.('aria-labelledby');
    if (by && doc?.getElementById) {
      const text = by.split(/\s+/).map((id) => doc.getElementById(id)?.textContent || '').join(' ');
      if (clean(text)) return clean(text);
    }
    const tag = (el.tagName || '').toLowerCase();
    const text = tag === 'input' || tag === 'select' || tag === 'textarea' ? '' : el.innerText || el.textContent;
    return clean(el.getAttribute?.('aria-label') || (el.labels && el.labels[0]?.innerText) || el.getAttribute?.('placeholder')
      || el.getAttribute?.('title') || el.getAttribute?.('alt') || text
      || (tag === 'input' && /^(submit|button|reset)$/i.test(el.type) ? el.value : ''));
  };

  const scopeKeyOf = (el) => {
    const parts = [];
    let cur = el.parentElement;
    for (let depth = 0; cur && depth < 16; depth++, cur = cur.parentElement) {
      const tag = cur.tagName;
      const role = cur.getAttribute?.('role') || '';
      if (tag === 'DIALOG' || tag === 'FORM' || tag === 'TR' || tag === 'ARTICLE'
        || /^(dialog|alertdialog|region|row|form)$/.test(role)) {
        const lbl = clean(cur.getAttribute?.('aria-label') || cur.querySelector?.('h1,h2,h3,h4,[role="heading"]')?.textContent || '', 40);
        if (lbl) parts.push(`${role || tag.toLowerCase()}:${lbl}`);
      }
    }
    return parts.join('>');
  };

  const refOf = (el) => {
    let id = ids.get(el);
    if (!id) { id = `e${nextId++}`; ids.set(el, id); }
    refs.set(id, new WeakRef(el));
    const prev = refMeta.get(id);
    refMeta.set(id, {
      role: roleOf(el),
      name: nameOf(el),
      scope: scopeKeyOf(el),
      unique: prev ? prev.unique : false,
    });
    return id;
  };

  const isSecure = (el) => {
    if (secretEls.has(el)) return true;
    const type = (el.getAttribute?.('type') || '').toLowerCase();
    const ac = el.getAttribute?.('autocomplete') || '';
    if (type === 'password' || /password|one-time-code|cc-number|cc-csc/i.test(ac)) {
      secretEls.add(el);
      return true;
    }
    return false;
  };

  const isTextControl = (el) => el.tagName === 'TEXTAREA'
    || (el.tagName === 'INPUT' && !/^(checkbox|radio|submit|button|reset|image|file|range|color)$/i.test(el.type));

  const hayOf = (el) => [el.name, el.id, el.getAttribute?.('placeholder'), el.getAttribute?.('aria-label'),
    el.getAttribute?.('autocomplete'), el.labels && el.labels[0]?.textContent].join(' ');

  const isTrap = (el, st) => {
    if (!isTextControl(el)) return false;
    const r = el.getBoundingClientRect();
    return !!el.closest?.('[aria-hidden="true"]') || Number((st || getComputedStyle(el)).opacity) < 0.05
      || r.right < -500 || r.bottom < -500 || el.tabIndex < 0 || HONEYPOT_NAME.test(hayOf(el));
  };

  const flagsOf = (el, st) => {
    const f = [];
    if (el.disabled || el.getAttribute?.('aria-disabled') === 'true' || el.closest?.('fieldset[disabled]')) f.push('disabled');
    if (el.checked || el.getAttribute?.('aria-checked') === 'true') f.push('checked');
    if (el.getAttribute?.('aria-expanded') === 'true') f.push('expanded');
    if (el.required || el.getAttribute?.('aria-required') === 'true') f.push('required');
    if (el.readOnly) f.push('readonly');
    if (isSecure(el)) f.push('secure');
    if (isTrap(el, st)) f.push('trap');
    if (isTextControl(el) && PAYMENT_FIELD.test(hayOf(el))) f.push('payment');
    return f;
  };

  const SSO_HOST = /(^|\.)(login\.microsoftonline\.com|accounts\.google\.com|okta\.com|oktapreview\.com|auth0\.com|login\.salesforce\.com|onelogin\.com|pingidentity\.com|duosecurity\.com)$/i;

  const computeWall = () => {
    if (location.pathname.includes('/cdn-cgi/access/')
      || (/(^|\.)cloudflareaccess\.com$/i.test(location.hostname) && !location.pathname.startsWith('/browser/'))) return 'cloudflare-access';
    if (SSO_HOST.test(location.hostname)) return 'sso';
    const frame = [...document.querySelectorAll('iframe')].find((f) => shown(f)
      && /recaptcha|hcaptcha|turnstile|challenges\.cloudflare\.com|arkoselabs|funcaptcha/i.test(`${f.src} ${f.title}`));
    const text = ((document.body && document.body.innerText) || '').slice(0, 4000).toLowerCase();
    if (frame || /verify (that )?you are (a )?human|are you a robot|checking your browser before accessing|press (and|&) hold to confirm you are a human/.test(text)) return 'captcha';
    if (/^(429\b|too many requests|access denied|rate limit)/i.test(document.title.trim())
      || /^(too many requests|rate limit exceeded|you have been rate limited|access denied)/.test(text.trim().slice(0, 200))) return 'rate-limit';
    const password = [...document.querySelectorAll('input[type="password"]')].some(shown);
    if (password && /(^|\/)(log-?in|sign-?in|auth|sso)(\/|\.|$|\?)/i.test(location.pathname)) return 'sign-in';
    return null;
  };
  const wall = () => {
    if (!wallCache || wallCache.href !== location.href) wallCache = { href: location.href, kind: computeWall() };
    return wallCache.kind;
  };
  const wallLine = (w) => `# WALL: ${w}. Stop and hand this tab to the user; do not solve or bypass it.`;

  const mainCanvas = () => {
    const area = innerWidth * innerHeight;
    if (area <= 0) return null;
    let best = null;
    let bestArea = area * 0.5;
    for (const c of document.querySelectorAll('canvas')) {
      if (!shown(c)) continue;
      const r = c.getBoundingClientRect();
      const vis = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0))
        * Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
      if (vis > bestArea) { best = c; bestArea = vis; }
    }
    return best;
  };

  const surface = () => (mainCanvas() ? 'picture' : 'dom');
  const PICTURE_LINE = '# PICTURE PAGE: this page is drawn into a canvas (remote browser isolation or a canvas app), so its own controls cannot be listed. Read it with ocr, act with click --xy, type --focused and key.';

  let probeCanvas = null;
  function canvasHash() {
    const c = mainCanvas();
    if (!c) return '';
    try {
      if (!probeCanvas) {
        probeCanvas = document.createElement('canvas');
        probeCanvas.width = 16;
        probeCanvas.height = 16;
      }
      const ctx = probeCanvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return '';
      ctx.clearRect(0, 0, 16, 16);
      ctx.drawImage(c, 0, 0, 16, 16);
      const data = ctx.getImageData(0, 0, 16, 16).data;
      let h = 2166136261;
      let nonZero = 0;
      for (let i = 0; i < data.length; i += 4) {
        const px = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2] | (data[i + 3] << 24);
        if (px !== 0) nonZero++;
        h ^= px;
        h = Math.imul(h, 16777619);
      }
      return nonZero === 0 ? '' : (h >>> 0).toString(16);
    } catch {
      return '';
    }
  }

  const disambiguatorOf = (el, unnamed) => {
    const icon = el.getAttribute?.('data-icon')
      || el.querySelector?.('svg title')?.textContent
      || el.querySelector?.('svg use')?.getAttribute?.('href')?.replace(/^#/, '')
      || el.querySelector?.('svg use')?.getAttribute?.('xlink:href')?.replace(/^#/, '');
    const imgAlt = el.querySelector?.('img[alt]:not([alt=""])')?.getAttribute?.('alt');
    const testid = el.getAttribute?.('data-testid') || el.getAttribute?.('data-test-id');
    let near = '';
    const box = el.closest?.('tr,[role="row"],li,[role="listitem"],article,section,dialog,[role="dialog"],form');
    if (box) {
      const h = box.querySelector?.('h1,h2,h3,h4,[role="heading"],th,td,label');
      near = clean(h?.textContent || '', 40);
      if (near && near === nameOf(el)) near = '';
    }
    if (unnamed) {
      if (clean(icon, 30)) return ` (icon "${clean(icon, 30)}")`;
      if (clean(imgAlt, 30)) return ` (img "${clean(imgAlt, 30)}")`;
      if (clean(testid, 30)) return ` (testid "${clean(testid, 30)}")`;
      if (near) return ` (near "${near}")`;
      return '';
    }
    if (near) return ` (near "${near}")`;
    if (clean(testid, 30)) return ` (testid "${clean(testid, 30)}")`;
    if (clean(icon, 30)) return ` (icon "${clean(icon, 30)}")`;
    if (clean(imgAlt, 30)) return ` (img "${clean(imgAlt, 30)}")`;
    return '';
  };

  const lineOf = (el, st, hint = '') => {
    const name = nameOf(el);
    const flags = flagsOf(el, st);
    const rawVal = isTextControl(el) && !isSecure(el) && el.value ? maskCard(clean(el.value, 40)) : '';
    const value = rawVal ? ` value="${rawVal}"` : '';
    const typeAttr = el.tagName === 'INPUT' && /^(date|time|datetime-local|month|week|color|range)$/i.test(el.type)
      ? ` [type=${el.type.toLowerCase()}]` : '';
    return `- ${roleOf(el)}${name ? ` "${name.replace(/"/g, "'")}"` : ''} [${refOf(el)}]${typeAttr}${value}${flags.length ? ` [${flags.join(',')}]` : ''}${hint}`;
  };

  const scopeOf = (within) => {
    if (!within) return document;
    if (/^@?e\d+$/.test(within)) return resolve(within);
    const el = [...document.querySelectorAll(within)].find(shown) || document.querySelector(within);
    if (!el) throw new Error(`NO_MATCH: nothing matches --within ${within}`);
    return el;
  };

  const activeModal = () => {
    const open = [...document.querySelectorAll('dialog[open],[role="dialog"][aria-modal="true"],[role="alertdialog"][aria-modal="true"]')].filter(shown);
    return open.length ? open[open.length - 1] : null;
  };

  // Every visible control under `scope`, in document order: { el, line, role, name, disabled, interactive }.
  function scan(opts = {}) {
    const sel = opts.all ? `${INTERACTIVE},${CONTEXT}` : INTERACTIVE;
    const limit = opts.limit || LIMIT;
    const find = opts.find ? String(opts.find).toLowerCase() : null;
    const scope = opts.withinEl || scopeOf(opts.within);
    const items = [];
    let more = false;
    const take = (el) => {
      const st = styleIfShown(el);
      if (!st) return;
      const isInter = el.matches ? el.matches(INTERACTIVE) : true;
      if (opts.all && el.matches?.(CONTEXT) && !isInter && el.querySelector?.(INTERACTIVE)
        && !/^H[1-6]$/.test(el.tagName)) return;
      const role = roleOf(el);
      const name = nameOf(el);
      const val = isTextControl(el) && !isSecure(el) ? (el.value || '') : '';
      if (find && !`${role} ${name} ${val}`.toLowerCase().includes(find)) return;
      if (items.length >= limit) { more = true; return; }
      const flags = flagsOf(el, st);
      items.push({ el, st, role, name, disabled: flags.includes('disabled'), interactive: isInter, line: lineOf(el, st) });
    };
    if (scope.nodeType === 1 && scope.matches?.(sel)) take(scope);
    for (const root of roots(scope)) {
      for (const el of root.querySelectorAll(sel)) {
        if (more) break;
        take(el);
      }
    }
    // Track uniqueness for safe redraw healing and add disambiguators for duplicates/unnamed controls.
    const counts = new Map();
    const scopedCounts = new Map();
    for (const item of items) {
      const k = `${item.role}\0${item.name}`;
      counts.set(k, (counts.get(k) || 0) + 1);
      const id = ids.get(item.el);
      const meta = id ? refMeta.get(id) : null;
      const sk = `${k}\0${meta ? meta.scope : ''}`;
      scopedCounts.set(sk, (scopedCounts.get(sk) || 0) + 1);
    }
    let lookups = 0;
    for (const item of items) {
      const id = ids.get(item.el);
      const meta = id ? refMeta.get(id) : null;
      const k = `${item.role}\0${item.name}`;
      if (meta) meta.unique = (scopedCounts.get(`${k}\0${meta.scope}`) || 0) === 1;
      if (opts.disambiguate !== false && item.interactive && lookups < 32 && (item.name === '' || (counts.get(k) || 0) > 1)) {
        lookups++;
        const hint = disambiguatorOf(item.el, item.name === '');
        if (hint) item.line = lineOf(item.el, item.st, hint);
      }
    }
    return { items, more };
  }

  // Collapse runs of 3+ consecutive disabled controls of the same role into one summary line.
  function foldItems(items) {
    const out = [];
    for (let i = 0; i < items.length; ) {
      const cur = items[i];
      if (cur.disabled && cur.interactive) {
        let j = i + 1;
        while (j < items.length && items[j].disabled && items[j].interactive && items[j].role === cur.role) j++;
        if (j - i >= 3) {
          const first = items[i].name || ids.get(items[i].el);
          const last = items[j - 1].name || ids.get(items[j - 1].el);
          out.push({ line: `- ${j - i} disabled ${cur.role}s (${first} ... ${last})`, tier: 1 });
          i = j;
          continue;
        }
      }
      const tier = cur.interactive ? 1 : /^(heading|alert|status|dialog|label)$/.test(cur.role) ? 2 : 3;
      out.push({ line: cur.line, tier });
      i++;
    }
    return out;
  }

  // Fit lines to maxChars in three passes: controls first, headings/labels second, text third.
  function fitBudget(headLines, rows, maxChars) {
    const raw = [...headLines, ...rows.map((r) => r.line)].join('\n');
    if (!maxChars || raw.length <= maxChars) return raw;
    const footerReserve = 120;
    let budget = Math.max(400, maxChars - headLines.join('\n').length - footerReserve);
    const keep = new Array(rows.length).fill(false);
    const totals = [0, 0, 0];
    const kept = [0, 0, 0];
    for (const r of rows) totals[r.tier - 1]++;
    for (const tier of [1, 2, 3]) {
      for (let i = 0; i < rows.length; i++) {
        if (rows[i].tier !== tier) continue;
        const cost = rows[i].line.length + 1;
        if (cost <= budget) {
          keep[i] = true;
          budget -= cost;
          kept[tier - 1]++;
        }
      }
    }
    const body = rows.filter((_, i) => keep[i]).map((r) => r.line);
    const footer = `# [fit to ${maxChars} chars: ${kept[0]}/${totals[0]} controls, ${kept[1]}/${totals[1]} headings/labels, ${kept[2]}/${totals[2]} text; pass --full or --within for more]`;
    return [...headLines, ...body, footer].join('\n');
  }

  const crossOriginFrames = () => {
    frameEls = [...document.querySelectorAll('iframe')].filter((f) => {
      try { void f.contentDocument.body; return false; } catch { return shown(f); }
    });
    return frameEls;
  };

  const BASE_LIMIT = 2000;
  const mapOf = (items) => new Map(items.map((i) => [ids.get(i.el), i.line]));
  const stateSig = (el) => `${el.value ?? ''}\0${el.checked ? 1 : 0}\0${el.disabled ? 1 : 0}\0${el.selectedIndex ?? ''}`;
  const entriesOf = (items) => items.map((i) => ({ el: i.el, sig: stateSig(i.el) }));
  const entriesUnchanged = (entries) => {
    for (let i = 0; i < entries.length; i++) {
      const { el, sig } = entries[i];
      if (!el.isConnected || stateSig(el) !== sig) return false;
    }
    return true;
  };

  function snapshot(opts = {}) {
    const modal = !opts.within ? activeModal() : null;
    const { items, more } = scan(modal ? { ...opts, withinEl: modal } : opts);
    const isPlainFullPage = !opts.all && !opts.find && !opts.within && !modal && !more;
    const curMap = mapOf(items);
    if (isPlainFullPage) {
      lastScan = { map: curMap, entries: entriesOf(items), mutation: lastMutation, href: location.href, full: true };
    }
    const head = [`# ${clean(document.title, 100)} | ${location.origin}${location.pathname}`];
    const w = wall();
    if (w) head.push(wallLine(w));
    if (surface() === 'picture') head.push(PICTURE_LINE);
    if (modal) head.push('# Modal open: scoped to it. Pass --within body for the whole page.');
    if (opts.find) head.push(`# ${items.length} control(s) match "${clean(opts.find, 40)}"${more ? ` (first ${items.length} shown)` : ''}`);
    else if (more) head.push(`# Only the first ${items.length} elements are listed. Narrow with --find <text> or --within <ref|css>.`);
    const skipped = !opts.within && !modal ? crossOriginFrames().length : 0;
    if (skipped) head.push(`# ${skipped} cross-origin iframe(s): their controls are listed below as f<n>:e<m> when reachable.`);

    const rows = opts.full ? items.map((i) => ({ line: i.line, tier: 1 })) : foldItems(items);
    const maxChars = opts.full ? 0 : (opts.maxChars || 12000);
    const fullText = fitBudget(head, rows, maxChars);

    // Repeat-snapshot diffing on the same document saves tokens when only a few controls changed.
    if (isPlainFullPage && !opts.full && lastSnapView && lastSnapView.href === location.href) {
      const prev = lastSnapView.map;
      const diffLines = [];
      let unchanged = 0;
      for (const [id, line] of curMap) {
        const old = prev.get(id);
        if (old === undefined) diffLines.push(`+ ${line.slice(2)}`);
        else if (old !== line) diffLines.push(`~ ${line.slice(2)}`);
        else unchanged++;
      }
      for (const [id, line] of prev) {
        if (!curMap.has(id)) diffLines.push(`- ${line.slice(2)}`);
      }
      const threshold = Math.max(1, Math.ceil(curMap.size * 0.4));
      if (diffLines.length === 0) {
        return [...head, `# snap diff (${unchanged} refs unchanged and still valid; pass --full for all)`].join('\n');
      }
      if (diffLines.length <= threshold) {
        const diffText = [...head, `# snap diff (${unchanged} refs unchanged and still valid; pass --full for all)`, ...diffLines].join('\n');
        if (diffText.length < fullText.length) {
          lastSnapView = { href: location.href, map: curMap };
          return diffText;
        }
      }
    }
    if (isPlainFullPage) lastSnapView = { href: location.href, map: curMap };
    return fullText;
  }

  function frames() {
    return JSON.stringify(crossOriginFrames().map((f, i) => ({ i: i + 1, src: f.src, title: clean(f.title || f.name, 40) })));
  }

  function frameOffset(i) {
    const f = frameEls[i - 1];
    if (!f || !f.isConnected) throw new Error(`STALE_REF: iframe f${i} is gone. Run snap again.`);
    const r = f.getBoundingClientRect();
    return `${r.left + f.clientLeft} ${r.top + f.clientTop}`;
  }

  function captureScan() {
    if (lastScan && lastScan.full && lastScan.mutation === lastMutation && lastScan.href === location.href
      && entriesUnchanged(lastScan.entries)) {
      return lastScan;
    }
    const { items, more } = scan({ limit: BASE_LIMIT, disambiguate: false });
    lastScan = { map: mapOf(items), entries: entriesOf(items), mutation: lastMutation, href: location.href, full: !more };
    return lastScan;
  }

  function baseline() {
    const snap = captureScan();
    base = snap.map;
    baseEntries = snap.entries;
    baseMutation = snap.mutation;
    baseFull = snap.full;
    baseDiagSeq = diagSeq;
    leaving = false;
    return location.href;
  }

  async function settle(maxMs = 400, quietMs = 120) {
    if (document.hidden) return 'hidden';
    const start = performance.now();
    for (;;) {
      await new Promise((r) => setTimeout(r, 40));
      const now = performance.now();
      const limit = leaving ? 5000 : maxMs;
      if (now - start >= limit) return 'timeout';
      if (!leaving && now - Math.max(lastMutation, start) >= quietMs) return 'quiet';
    }
  }

  function diff(opts = {}) {
    const max = opts.max || 30;
    const out = [];
    const from = opts.from || '';
    const urlChanged = !!(from && from !== location.href);
    if (urlChanged) out.push(`# url: ${from} -> ${location.href}`);
    const w = wall();
    if (w) out.push(wallLine(w));
    const diagLines = diag.filter((d) => d.seq > baseDiagSeq).slice(-5).map((d) => d.line);
    baseDiagSeq = diagSeq;

    if (base && baseEntries && baseFull && !urlChanged && lastMutation === baseMutation && entriesUnchanged(baseEntries)) {
      out.push(...diagLines);
      if (out.length === 0) out.push('# no visible change yet');
      return out.join('\n');
    }

    const { items, more } = scan({ limit: BASE_LIMIT, disambiguate: false });
    const now = mapOf(items);
    lastScan = { map: now, entries: entriesOf(items), mutation: lastMutation, href: location.href, full: !more };
    const changes = [];
    if (!base) {
      out.push(`# new page: ${clean(document.title, 100)}`);
      for (const line of now.values()) changes.push(`+ ${line.slice(2)}`);
    } else {
      for (const [id, line] of now) {
        const old = base.get(id);
        if (old === undefined) changes.push(`+ ${line.slice(2)}`);
        else if (old !== line) changes.push(`~ ${line.slice(2)}`);
      }
      for (const [id, line] of base) if (!now.has(id)) changes.push(`- ${line.slice(2)}`);
    }
    base = now;
    baseEntries = lastScan.entries;
    baseMutation = lastMutation;
    baseFull = !more;
    out.push(...changes.slice(0, max));
    if (changes.length > max) out.push(`# … ${changes.length - max} more changes; run snap`);
    out.push(...diagLines);
    if (!changes.length && out.length === 0) out.push('# no visible change yet');
    return out.join('\n');
  }

  const TYPEABLE = /^(textbox|searchbox|combobox|spinbutton|listbox)$/;

  function locate(label, kind) {
    const want = clean(label, 200).toLowerCase();
    if (!want) throw new Error('INPUT_INVALID: a ref (e12) or a label is required');
    let { items } = scan({ limit: 5000, disambiguate: false });
    if (kind === 'type') {
      const typeable = items.filter((i) => TYPEABLE.test(i.role) || i.el.isContentEditable
        || (i.el.tagName === 'INPUT' && /^(date|time|datetime-local|month|week|color|range)$/i.test(i.el.type)));
      if (typeable.length) items = typeable;
    } else if (kind === 'select') {
      const selectable = items.filter((i) => i.el.tagName === 'SELECT' || /^(combobox|listbox)$/.test(i.role));
      if (selectable.length) items = selectable;
    }
    const named = items.map((i) => ({ ...i, lname: i.name.toLowerCase() }));
    let hits = named.filter((i) => i.lname === want);
    if (!hits.length) hits = named.filter((i) => i.lname.includes(want));
    const live = hits.filter((i) => !i.disabled);
    if (live.length) hits = live;
    if (hits.length === 1) return ids.get(hits[0].el);
    if (hits.length > 1) {
      throw new Error(`AMBIGUOUS: "${clean(label, 60)}" matches ${hits.length} controls; use one of these refs:\n${hits.slice(0, 12).map((h) => h.line).join('\n')}`);
    }
    const words = want.split(' ').filter((x) => x.length > 2);
    const near = named.filter((i) => i.lname && words.some((x) => i.lname.includes(x))).slice(0, 5);
    throw new Error(`NO_MATCH: no control named "${clean(label, 60)}".${near.length ? ` Closest:\n${near.map((h) => h.line).join('\n')}` : ' Run snap to see the controls.'}`);
  }

  const resolve = (ref) => {
    const id = String(ref || '').replace(/^@/, '');
    if (!/^e\d+$/.test(id)) throw new Error(`INPUT_INVALID: ref must look like e12, got "${ref}"`);
    const el = refs.get(id)?.deref();
    if (!el || !el.isConnected) throw new Error(`STALE_REF: ${id} is gone (page changed or navigated). Run snap again.`);
    return el;
  };

  // Verify the ref still points to the same role and label as when it was minted.
  function verifyRef(ref) {
    const id = String(ref || '').replace(/^@/, '');
    const el = resolve(id);
    const meta = refMeta.get(id);
    if (!meta) return 'ok';
    const curRole = roleOf(el);
    const curName = nameOf(el);
    if (curRole !== meta.role || (meta.name && curName && curName !== meta.name)) {
      throw new Error(`REF_DRIFTED: ${id} changed from ${meta.role} "${meta.name}" to ${curRole} "${curName}". Run snap again.`);
    }
    return 'ok';
  }

  // Safely rebind a redrawn ref inside a batch only when it was unique and still has one exact match in the same scope.
  function healRef(ref) {
    const id = String(ref || '').replace(/^@/, '');
    const meta = refMeta.get(id);
    if (!meta || !meta.unique || !meta.name) {
      throw new Error(`STALE_REF: ${id} is gone and cannot be safely rebound. Run snap again.`);
    }
    const { items } = scan({ limit: 5000, disambiguate: false });
    const matches = items.filter((i) => i.role === meta.role && i.name === meta.name && scopeKeyOf(i.el) === meta.scope);
    if (matches.length === 1) return ids.get(matches[0].el);
    if (matches.length > 1) {
      throw new Error(`STALE_REF: ${id} was redrawn and ${matches.length} controls match ${meta.role} "${meta.name}":\n${matches.slice(0, 6).map((m) => m.line).join('\n')}`);
    }
    throw new Error(`STALE_REF: ${id} (${meta.role} "${meta.name}") is gone. Run snap again.`);
  }

  const frame = () => (document.hidden ? Promise.resolve()
    : new Promise((r) => { const t = setTimeout(r, 50); requestAnimationFrame(() => { clearTimeout(t); r(); }); }));
  const animating = () => { try { return document.getAnimations().some((a) => a.playState === 'running'); } catch { return true; } };
  const describe = (el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : ''}${nameOf(el) ? ` "${nameOf(el).slice(0, 40)}"` : ''}`;

  const findBlocker = (hit, target) => {
    let best = hit;
    for (let cur = hit; cur && cur !== document.body && cur !== document.documentElement; cur = cur.parentElement) {
      if (cur.contains?.(target)) break;
      const role = cur.getAttribute?.('role') || '';
      const pos = getComputedStyle(cur).position;
      if (cur.tagName === 'DIALOG' || role === 'dialog' || role === 'alertdialog' || pos === 'fixed' || pos === 'sticky') {
        best = cur;
      }
    }
    const bRef = refOf(best);
    let dismiss = '';
    const btns = best.querySelectorAll?.('button, [role="button"], a[href]') || [];
    for (const b of btns) {
      if (!shown(b)) continue;
      const n = nameOf(b);
      if (n && DISMISS_TEXT.test(n)) {
        dismiss = ` (dismiss: ${roleOf(b)} "${n}" [${refOf(b)}])`;
        break;
      }
    }
    return `covered by ${describe(best)} [${bRef}]${dismiss}`;
  };

  async function point(ref, opts = {}) {
    const el = resolve(ref);
    const deadline = performance.now() + (opts.timeoutMs || 3000);
    const disabledDeadline = performance.now() + (opts.disabledWaitMs ?? 1500);
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const check = (a, b) => {
      if (!shown(el)) return 'not visible';
      if (flagsOf(el).includes('disabled')) return 'disabled';
      if (a.x !== b.x || a.y !== b.y || a.width !== b.width || a.height !== b.height) return 'still moving';
      const root = el.getRootNode();
      const hit = (root.elementFromPoint ? root : el.ownerDocument).elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      const ok = hit && (hit === el || el.contains(hit) || (el.labels && [...el.labels].some((l) => l.contains(hit))));
      return ok ? null : (hit ? findBlocker(hit, el) : 'covered by nothing (off screen)');
    };
    let reason;
    do {
      const moving = animating();
      if (moving) await frame();
      const a = el.getBoundingClientRect();
      await frame();
      const b = el.getBoundingClientRect();
      reason = check(a, b);
      if (!reason) {
        let px = b.left + b.width / 2, py = b.top + b.height / 2;
        for (let w = el.ownerDocument.defaultView; w && w !== w.parent && w.frameElement; w = w.parent) {
          const fr = w.frameElement.getBoundingClientRect();
          px += fr.left + w.frameElement.clientLeft;
          py += fr.top + w.frameElement.clientTop;
        }
        return `${Math.round(px)} ${Math.round(py)} ${document.hidden ? 'hidden' : 'visible'}`;
      }
      if (reason === 'disabled' && performance.now() >= disabledDeadline) break;
      if (reason === 'disabled') await new Promise((r) => setTimeout(r, 75));
    } while (!document.hidden && performance.now() < deadline);
    throw new Error(`NOT_ACTIONABLE: ${String(ref).replace(/^@/, '')} ${reason}`);
  }

  function guard(ref) {
    const flags = flagsOf(resolve(ref));
    if (flags.includes('trap')) throw new Error(`REFUSED: ${ref} looks like a bot-trap field; leave it empty`);
    if (flags.includes('payment')) throw new Error(`REFUSED: ${ref} is a payment field; the user enters payment details`);
    return 'ok';
  }

  function guardFocused() {
    let el = document.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    if (!el || el === document.body) return 'ok';
    const flags = flagsOf(el);
    if (flags.includes('trap')) throw new Error('REFUSED: the focused field looks like a bot-trap field; leave it empty');
    if (flags.includes('payment')) throw new Error('REFUSED: the focused field is a payment field; the user enters payment details');
    return 'ok';
  }

  const deepActive = () => {
    let el = document.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    return el;
  };

  // Validate and set native date/time/month/week/color/range inputs cleanly.
  function setTypedValue(ref, raw) {
    const el = resolve(ref);
    if (el.tagName !== 'INPUT') return '__not_typed__';
    const t = (el.type || '').toLowerCase();
    if (!/^(date|time|datetime-local|month|week|color|range)$/.test(t)) return '__not_typed__';
    if (flagsOf(el).includes('disabled')) throw new Error(`NOT_ACTIONABLE: ${ref} disabled`);
    let val = String(raw ?? '').trim();
    if (val !== '') {
      if (t === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(val)) {
        throw new Error(`INPUT_INVALID: date input requires YYYY-MM-DD, got "${val}"`);
      }
      if (t === 'time') {
        const ampm = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)$/i.exec(val);
        if (ampm) {
          let h = Number(ampm[1]);
          const mer = ampm[4].toLowerCase();
          if (mer === 'pm' && h < 12) h += 12;
          if (mer === 'am' && h === 12) h = 0;
          val = `${String(h).padStart(2, '0')}:${ampm[2]}${ampm[3] ? `:${ampm[3]}` : ''}`;
        } else if (!/^\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?$/.test(val)) {
          throw new Error(`INPUT_INVALID: time input requires HH:MM or "2:30 PM", got "${val}"`);
        }
      }
      if (t === 'datetime-local') {
        val = val.replace(' ', 'T');
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?$/.test(val)) {
          throw new Error(`INPUT_INVALID: datetime-local requires YYYY-MM-DDTHH:MM, got "${val}"`);
        }
      }
      if (t === 'month' && !/^\d{4}-\d{2}$/.test(val)) {
        throw new Error(`INPUT_INVALID: month input requires YYYY-MM, got "${val}"`);
      }
      if (t === 'week' && !/^\d{4}-W\d{2}$/.test(val)) {
        throw new Error(`INPUT_INVALID: week input requires YYYY-Www, got "${val}"`);
      }
      if (t === 'color') {
        const shortHex = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(val);
        if (shortHex) val = `#${shortHex[1]}${shortHex[1]}${shortHex[2]}${shortHex[2]}${shortHex[3]}${shortHex[3]}`.toLowerCase();
        else if (/^#[0-9a-f]{6}$/i.test(val)) val = val.toLowerCase();
        else throw new Error(`INPUT_INVALID: color input requires #rrggbb, got "${val}"`);
      }
      if (t === 'range' && !Number.isFinite(Number(val))) {
        throw new Error(`INPUT_INVALID: range input requires a number, got "${val}"`);
      }
    }
    const prev = el.value;
    el.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(el, val);
    else el.value = val;
    if (val !== '' && el.value === '') {
      if (setter) setter.call(el, prev);
      else el.value = prev;
      throw new Error(`INPUT_INVALID: ${ref} (${t}) rejected value "${val}"`);
    }
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return JSON.stringify({ typed: true, type: t, value: el.value, matched: el.value === val });
  }

  // Focus a field for typing; if clicking swapped it for a replacement input (e.g. search bar), follow focus safely.
  function focusForType(ref) {
    const id = String(ref || '').replace(/^@/, '');
    const el = refs.get(id)?.deref();
    if (!el || !el.isConnected) {
      const active = deepActive();
      const meta = refMeta.get(id);
      if (active && (isTextControl(active) || active.isContentEditable) && meta) {
        const flags = flagsOf(active);
        if (flags.includes('trap') || flags.includes('payment')) {
          throw new Error(`REFUSED: replacement field for ${id} is protected`);
        }
        const newName = nameOf(active);
        if (roleOf(active) === meta.role && (!meta.name || !newName || newName.toLowerCase().includes(meta.name.toLowerCase()) || meta.name.toLowerCase().includes(newName.toLowerCase()))) {
          if (typeof active.select === 'function') active.select();
          return `retargeted:${refOf(active)}`;
        }
      }
      throw new Error(`STALE_REF: ${id} was replaced on focus. Run snap again.`);
    }
    guard(ref);
    el.focus();
    if (typeof el.select === 'function') el.select();
    else if (el.isContentEditable) {
      const range = el.ownerDocument.createRange();
      range.selectNodeContents(el);
      const s = el.ownerDocument.getSelection();
      s.removeAllRanges(); s.addRange(range);
    }
    const active = deepActive();
    return active === el || el.contains(active) ? 'focused' : 'not focused';
  }

  function armInputProbe() {
    if (inputProbe) inputProbe.cleanup();
    const counts = { mousedown: 0, mouseup: 0, keydown: 0, keyup: 0, input: 0, beforeinput: 0, dragstart: 0, drop: 0 };
    const handlers = [];
    for (const ev of Object.keys(counts)) {
      const fn = (e) => { if (e.isTrusted !== false) counts[ev]++; };
      window.addEventListener(ev, fn, true);
      handlers.push([ev, fn]);
    }
    const cleanup = () => {
      for (const [ev, fn] of handlers) window.removeEventListener(ev, fn, true);
      inputProbe = null;
    };
    inputProbe = { counts, cleanup };
    return 'armed';
  }

  function readInputProbe() {
    if (!inputProbe) return JSON.stringify({});
    const out = { ...inputProbe.counts };
    inputProbe.cleanup();
    return JSON.stringify(out);
  }

  // Grid cell support: inspect whether ref is a grid cell and locate its editor.
  function cellInfo(ref) {
    const el = resolve(ref);
    const role = roleOf(el);
    const isCell = (role === 'gridcell' || role === 'cell' || el.tagName === 'TD')
      && !isTextControl(el) && !el.isContentEditable;
    if (!isCell) return '__not_cell__';
    const editor = el.querySelector('input:not([type="hidden"]),textarea,select,[contenteditable="true"]');
    const row = el.closest('tr,[role="row"]');
    const colIdx = row ? [...row.children].indexOf(el) : -1;
    return JSON.stringify({
      cell: true,
      before: clean(el.innerText || el.textContent, 120),
      editorRef: editor && shown(editor) ? refOf(editor) : null,
      rowIndex: row?.getAttribute?.('aria-rowindex') || null,
      colIndex: colIdx,
    });
  }

  function cellEditor() {
    const active = deepActive();
    if (active && (isTextControl(active) || active.tagName === 'SELECT' || active.isContentEditable)) {
      return refOf(active);
    }
    return '';
  }

  function cellRead(ref, beforeText) {
    const id = String(ref || '').replace(/^@/, '');
    const el = refs.get(id)?.deref();
    const active = deepActive();
    const errMsg = active?.validationMessage
      || (active?.getAttribute?.('aria-errormessage') && document.getElementById(active.getAttribute('aria-errormessage'))?.textContent)
      || (active?.getAttribute?.('aria-invalid') === 'true' && active.getAttribute?.('aria-describedby') && document.getElementById(active.getAttribute('aria-describedby'))?.textContent)
      || '';
    const after = el && el.isConnected ? clean(el.innerText || el.textContent, 120) : '';
    return JSON.stringify({ after, before: beforeText, error: clean(errMsg, 120) });
  }

  // Drag helpers: detect HTML5 draggable, compute far-half drop point, and read list order.
  function dragInfo(srcRef, dstRef, side) {
    const src = resolve(srcRef);
    const dst = resolve(dstRef);
    src.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    dst.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const sr = src.getBoundingClientRect();
    const dr = dst.getBoundingClientRect();
    const draggable = !!(src.draggable || src.closest?.('[draggable="true"]'));
    let dx = dr.left + dr.width / 2;
    let dy = dr.top + dr.height / 2;
    const vertical = Math.abs(dr.top - sr.top) >= Math.abs(dr.left - sr.left);
    if (vertical) {
      const frac = side === 'before' ? 0.25 : side === 'after' ? 0.75 : (dr.top > sr.top ? 0.75 : 0.25);
      dy = dr.top + dr.height * frac;
    } else {
      const frac = side === 'before' ? 0.25 : side === 'after' ? 0.75 : (dr.left > sr.left ? 0.75 : 0.25);
      dx = dr.left + dr.width * frac;
    }
    let listMeta = null;
    const item = src.closest?.('li,tr,[role="listitem"],[role="row"],[role="option"],[role="treeitem"]') || src;
    const parent = item.parentElement;
    if (parent && parent.contains(dst)) {
      const siblings = [...parent.children].filter((c) => c.tagName === item.tagName);
      const texts = siblings.map((c) => clean(c.innerText || c.textContent, 80));
      const idx = siblings.indexOf(item);
      if (idx >= 0 && texts.filter((t) => t === texts[idx]).length === 1) {
        listMeta = { parentRef: refOf(parent), tag: item.tagName, text: texts[idx], index: idx + 1, total: siblings.length };
      }
    }
    return JSON.stringify({
      sx: Math.round(sr.left + sr.width / 2),
      sy: Math.round(sr.top + sr.height / 2),
      dx: Math.round(dx),
      dy: Math.round(dy),
      draggable,
      listMeta,
    });
  }

  function listPosition(listMeta) {
    if (!listMeta) return '';
    const parent = refs.get(listMeta.parentRef)?.deref();
    if (!parent || !parent.isConnected) return '';
    const siblings = [...parent.children].filter((c) => c.tagName === listMeta.tag);
    const idx = siblings.findIndex((c) => clean(c.innerText || c.textContent, 80) === listMeta.text);
    if (idx < 0) return '';
    const pos = idx + 1;
    return pos === listMeta.index
      ? `the order did not change: still ${pos} of ${siblings.length}`
      : `moved to ${pos} of ${siblings.length} (was ${listMeta.index})`;
  }

  function select(ref, option) {
    const el = resolve(ref);
    if (flagsOf(el).includes('disabled')) throw new Error(`NOT_ACTIONABLE: ${ref} disabled`);
    if (el.tagName !== 'SELECT') return '__not_native__';
    const raw = String(option ?? '');
    const want = clean(raw, 200).toLowerCase();
    const opts = [...el.options].filter((o) => !o.disabled);
    let hits = opts.filter((o) => o.value === raw);
    if (!hits.length) hits = opts.filter((o) => clean(o.textContent, 200).toLowerCase() === want);
    if (!hits.length && want) hits = opts.filter((o) => clean(o.textContent, 200).toLowerCase().includes(want));
    const list = (arr) => arr.slice(0, 12).map((o) => `"${clean(o.textContent || o.value, 40)}" (value="${o.value}")`).join(', ');
    if (hits.length === 0) throw new Error(`NO_MATCH: no option "${clean(raw, 60)}" in ${ref}. Options: ${list(opts)}`);
    if (hits.length > 1) throw new Error(`AMBIGUOUS: "${clean(raw, 60)}" matches ${hits.length} options: ${list(hits)}`);
    const chosen = hits[0];
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
    if (setter) setter.call(el, chosen.value);
    else el.value = chosen.value;
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    return clean(chosen.textContent || chosen.value, 80);
  }

  function locateOption(option) {
    const want = clean(option, 200).toLowerCase();
    const found = [];
    for (const root of roots(document)) {
      for (const el of root.querySelectorAll('[role="option"],[role="menuitem"],[role="menuitemradio"]')) {
        if (!shown(el) || flagsOf(el).includes('disabled')) continue;
        found.push({ el, name: nameOf(el).toLowerCase(), line: lineOf(el) });
      }
    }
    let hits = found.filter((i) => i.name === want);
    if (!hits.length && want) hits = found.filter((i) => i.name.includes(want));
    if (hits.length === 1) return refOf(hits[0].el);
    if (hits.length > 1) {
      throw new Error(`AMBIGUOUS: option "${clean(option, 60)}" matches ${hits.length} items:\n${hits.slice(0, 12).map((h) => h.line).join('\n')}`);
    }
    throw new Error(`NO_MATCH: no open option "${clean(option, 60)}".${found.length ? ` Visible:\n${found.slice(0, 10).map((h) => h.line).join('\n')}` : ''}`);
  }

  function locateFile(refOrLabel) {
    const raw = String(refOrLabel ?? '').trim();
    if (!raw) throw new Error('INPUT_INVALID: a file input ref, label, or CSS selector is required');
    if (/^@?e\d+$/.test(raw)) {
      const el = resolve(raw);
      if (el.tagName === 'INPUT' && el.type === 'file') return refOf(el);
      if (el.tagName === 'LABEL' && el.control?.tagName === 'INPUT' && el.control.type === 'file') return refOf(el.control);
      const inner = el.querySelector?.('input[type="file"]');
      if (inner) return refOf(inner);
      throw new Error(`INPUT_INVALID: ${raw} is not a file input`);
    }
    const all = [];
    for (const root of roots(document)) {
      for (const el of root.querySelectorAll('input[type="file"]')) all.push(el);
    }
    if (!all.length) throw new Error('NO_MATCH: no <input type="file"> found on this page');
    try {
      const byCss = [...document.querySelectorAll(raw)].filter((e) => e.tagName === 'INPUT' && e.type === 'file');
      if (byCss.length === 1) return refOf(byCss[0]);
    } catch { /* not a CSS selector */ }
    const want = clean(raw, 200).toLowerCase();
    const named = all.map((el) => {
      const label = clean(nameOf(el) || el.name || el.id || el.accept || 'file', 80);
      return { el, label, hay: `${label} ${hayOf(el)} ${el.accept || ''}`.toLowerCase(), line: `- file "${label}" [${refOf(el)}]` };
    });
    let hits = named.filter((i) => i.label.toLowerCase() === want);
    if (!hits.length) hits = named.filter((i) => i.hay.includes(want));
    if (!hits.length && all.length === 1 && want === 'file') hits = named;
    if (hits.length === 1) return refOf(hits[0].el);
    if (hits.length > 1) {
      throw new Error(`AMBIGUOUS: "${clean(raw, 60)}" matches ${hits.length} file inputs:\n${hits.slice(0, 10).map((h) => h.line).join('\n')}`);
    }
    throw new Error(`NO_MATCH: no file input matching "${clean(raw, 60)}". Available:\n${named.slice(0, 10).map((h) => h.line).join('\n')}`);
  }

  function checkWait(opts = {}) {
    const w = wall() || '';
    let matched = true;
    if (opts.url && !location.href.toLowerCase().includes(String(opts.url).toLowerCase())) matched = false;
    if (matched && opts.selector) {
      let found = false;
      for (const root of roots(document)) {
        try {
          if ([...root.querySelectorAll(opts.selector)].some(shown)) { found = true; break; }
        } catch {
          throw new Error(`INPUT_INVALID: invalid CSS selector "${opts.selector}"`);
        }
      }
      if (!found) matched = false;
    }
    if (matched && opts.text) {
      const body = ((document.body && document.body.innerText) || '').toLowerCase();
      if (!body.includes(String(opts.text).toLowerCase())) matched = false;
    }
    return JSON.stringify({ matched, url: location.href, wall: w });
  }

  function value(ref) {
    const el = resolve(ref);
    if (isSecure(el)) return '__secure__';
    if ('value' in el && el.tagName !== 'BUTTON') return maskCard(String(el.value));
    return el.innerText;
  }

  function verdict() {
    const text = (document.body && document.body.innerText) || '';
    const surface = [...document.querySelectorAll(REJECT_SURFACE)].find((e) => shown(e) && clean(e.innerText));
    const success = text.match(SUCCESS_TEXT);
    const reject = surface ? clean(surface.innerText) : (text.match(REJECT_TEXT) || [])[0] || null;
    const result = success && !surface ? 'confirmed' : reject ? 'rejected' : 'unverified';
    return JSON.stringify({ result, success: success ? clean(success[0], 60) : null, rejection: reject && clean(reject, 80), url: location.origin + location.pathname });
  }

  function health(opts = {}) {
    const tapMin = opts.tapMin || 24;
    const out = { tap: [], tiny: [], contrast: [], unknownContrast: 0, headings: [], emptyLinks: [], unlabeled: [], duplicateIds: [], brokenImages: [], noAlt: [], meta: {} };
    const cap = (list, item) => { if (list.length < 8) list.push(item); };
    const vis = (e) => shown(e) && getComputedStyle(e).opacity !== '0';
    const parse = (v) => { const m = v.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { rgb: p.slice(0, 3), a: p[3] === undefined ? 1 : p[3] }; };
    const lum = (rgb) => { const l = rgb.map((c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * l[0] + 0.7152 * l[1] + 0.722 * l[2]; };
    const bg = (e) => { for (let n = e; n; n = n.parentElement) { const s = getComputedStyle(n); if (s.backgroundImage !== 'none') return null; const c = parse(s.backgroundColor); if (c && c.a > 0.95) return c.rgb; } return [255, 255, 255]; };
    const seen = new Set();
    for (const e of document.body.querySelectorAll('*')) {
      if (e.closest('svg') || !vis(e)) continue;
      if (![...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 1)) continue;
      const s = getComputedStyle(e);
      const size = parseFloat(s.fontSize);
      if (size < 12) cap(out.tiny, `${describe(e)} ${size}px`);
      const fg = parse(s.color); const b = bg(e);
      if (!b) { out.unknownContrast++; continue; }
      if (!fg || fg.a <= 0.9) continue;
      const [hi, lo] = [lum(fg.rgb), lum(b)].sort((x, y) => y - x);
      const ratio = (hi + 0.05) / (lo + 0.05);
      const large = size >= 24 || (size >= 18.66 && parseInt(s.fontWeight, 10) >= 700);
      const key = describe(e);
      if (ratio < (large ? 3 : 4.5) && !seen.has(key)) { seen.add(key); cap(out.contrast, `${key} ${ratio.toFixed(2)}`); }
    }
    for (const e of document.querySelectorAll('a, button, input:not([type=hidden]), select, textarea, summary, [role=button]')) {
      if (!vis(e)) continue;
      const r = e.getBoundingClientRect();
      if (r.width < tapMin || r.height < tapMin) cap(out.tap, `${describe(e)} ${Math.round(r.width)}x${Math.round(r.height)}`);
    }
    for (const h of document.querySelectorAll('h1,h2,h3,h4,h5,h6')) if (vis(h)) out.headings.push(Number(h.tagName[1]));
    for (const a of document.querySelectorAll('a')) if (vis(a) && !nameOf(a) && !a.querySelector('img[alt]:not([alt=""])')) cap(out.emptyLinks, a.getAttribute('href') || '(no href)');
    for (const c of document.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]), select, textarea')) if (vis(c) && !nameOf(c)) cap(out.unlabeled, describe(c));
    const dupIds = {};
    document.querySelectorAll('[id]').forEach((e) => { dupIds[e.id] = (dupIds[e.id] || 0) + 1; });
    for (const [id, n] of Object.entries(dupIds)) if (n > 1) cap(out.duplicateIds, `#${id} x${n}`);
    for (const img of document.images) {
      if (!vis(img)) continue;
      if (img.complete && img.naturalWidth === 0) cap(out.brokenImages, img.getAttribute('src') || '(no src)');
      if (!img.hasAttribute('alt')) cap(out.noAlt, img.getAttribute('src') || '(no src)');
    }
    const attr = (s, a) => document.querySelector(s)?.getAttribute(a) ?? null;
    out.meta = {
      title: document.title, description: attr('meta[name=description]', 'content'), lang: document.documentElement.lang || null,
      canonical: attr('link[rel=canonical]', 'href'), viewport: attr('meta[name=viewport]', 'content'),
      jsonld: [...document.querySelectorAll('script[type="application/ld+json"]')].map((n) => { try { const d = JSON.parse(n.textContent); return Array.isArray(d) || d?.['@type'] || d?.['@graph'] ? 'ok' : 'no @type'; } catch { return 'invalid JSON'; } }),
    };
    const levels = out.headings;
    out.headingSkips = levels.filter((l, i) => i > 0 && l > levels[i - 1] + 1).length;
    out.h1Count = levels.filter((l) => l === 1).length;
    return JSON.stringify(out);
  }

  const deepHit = (x, y) => {
    let el = document.elementFromPoint(x, y);
    while (el && el.shadowRoot && el.shadowRoot.elementFromPoint(x, y) && el.shadowRoot.elementFromPoint(x, y) !== el) el = el.shadowRoot.elementFromPoint(x, y);
    return el;
  };

  function hit(x, y) {
    const el = deepHit(x, y);
    if (!el) return 'hit: nothing (off screen)';
    const control = el.closest(INTERACTIVE);
    return `hit: ${control ? lineOf(control).slice(2) : describe(el)}`;
  }

  function rect(ref) {
    const el = resolve(ref);
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const r = el.getBoundingClientRect();
    return JSON.stringify({ x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height, dpr: devicePixelRatio });
  }

  function viewport() {
    return JSON.stringify({ x: scrollX, y: scrollY, width: innerWidth, height: innerHeight, dpr: devicePixelRatio });
  }

  // Return visible in-viewport control coordinates for daemon-side badge drawing (zero DOM mutation).
  function markBoxes() {
    const boxes = [];
    const lines = [];
    for (const { el, line } of scan({ limit: LIMIT }).items) {
      if (el.ownerDocument !== document) continue;
      const r = el.getBoundingClientRect();
      if (r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) continue;
      const num = ids.get(el).slice(1);
      boxes.push({ id: num, x: Math.max(0, Math.round(r.left)), y: Math.max(0, Math.round(r.top)) });
      lines.push(line);
    }
    return JSON.stringify({ boxes, legend: lines.join('\n') });
  }

  // Fallback DOM badge overlay for non-macOS environments without native image drawing.
  function marks(on) {
    document.getElementById('__bc_marks')?.remove();
    if (!on) return '0';
    const host = document.createElement('div');
    host.id = '__bc_marks';
    host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647';
    const lines = [];
    for (const { el, line } of scan({ limit: LIMIT }).items) {
      if (el.ownerDocument !== document) continue;
      const r = el.getBoundingClientRect();
      if (r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) continue;
      const tag = document.createElement('span');
      tag.textContent = ids.get(el).slice(1);
      tag.style.cssText = `position:absolute;left:${Math.max(0, r.left)}px;top:${Math.max(0, r.top)}px;background:#d00;color:#fff;font:bold 11px/13px sans-serif;padding:0 3px;border-radius:2px`;
      host.appendChild(tag);
      lines.push(line);
    }
    document.documentElement.appendChild(host);
    return lines.join('\n');
  }

  // Structured form inspector: fields, values, required/invalid states, select options, and submit buttons.
  function form(opts = {}) {
    const scope = opts.within ? scopeOf(opts.within) : (activeModal() || document);
    const FIELD_SEL = 'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]),select,textarea,[contenteditable=""],[contenteditable="true"],[role="textbox"],[role="searchbox"],[role="combobox"],[role="checkbox"],[role="radio"],[role="switch"],[role="slider"],[role="spinbutton"],[role="listbox"]';
    const lines = [];
    let required = 0;
    let reqEmpty = 0;
    let invalid = 0;
    let more = false;
    const seen = new Set();

    for (const root of roots(scope)) {
      for (const el of root.querySelectorAll(FIELD_SEL)) {
        if (seen.has(el)) continue;
        // Skip wrapper role around native field; list the inner input that holds the value.
        if (el.tagName !== 'INPUT' && el.tagName !== 'SELECT' && el.tagName !== 'TEXTAREA'
          && el.querySelector?.('input:not([type="hidden"]):not([type="button"]):not([type="submit"]),select,textarea')) continue;
        const st = styleIfShown(el);
        const visibleByLabel = !st && (el.type === 'checkbox' || el.type === 'radio') && el.labels && [...el.labels].some(shown);
        if (!st && !visibleByLabel) continue;
        seen.add(el);
        if (lines.length >= 200) { more = true; break; }
        const sec = isSecure(el);
        const flags = flagsOf(el, st || getComputedStyle(el));
        const isReq = flags.includes('required');
        if (isReq) required++;
        const rawVal = 'value' in el ? String(el.value ?? '') : clean(el.innerText || '', 80);
        if (isReq && rawVal === '' && !flags.includes('checked')) reqEmpty++;
        const errId = el.getAttribute?.('aria-errormessage') || (el.getAttribute?.('aria-invalid') === 'true' ? el.getAttribute?.('aria-describedby') : '');
        const ariaErr = errId ? clean(document.getElementById(errId)?.textContent || '', 80) : '';
        const valMsg = sec ? (el.validity && !el.validity.valid ? 'invalid' : '') : clean(el.validationMessage || ariaErr, 80);
        const isInvalid = !!(valMsg || el.getAttribute?.('aria-invalid') === 'true');
        if (isInvalid) invalid++;
        const meta = [...flags];
        if (el.tagName === 'INPUT' && el.type && el.type !== 'text') meta.unshift(`type=${el.type}`);
        if (isInvalid) meta.push(valMsg && !sec ? `invalid: ${valMsg}` : 'invalid');
        if (el.type === 'radio' && el.name) meta.push(`group=${el.name}`);
        let valText = '';
        if (sec) valText = ': ••••';
        else if (el.tagName === 'SELECT') {
          const optList = [...el.options].map((o) => clean(o.textContent || o.value, 30));
          const cur = el.selectedOptions?.[0] ? clean(el.selectedOptions[0].textContent || el.selectedOptions[0].value, 40) : '(none)';
          const preview = optList.length <= 8 ? optList.join(', ') : `${optList.slice(0, 6).join(', ')}, ... (${optList.length} total)`;
          valText = `: ${cur} [options: ${preview}]`;
        } else if (el.type !== 'checkbox' && el.type !== 'radio') {
          valText = rawVal ? `: ${maskCard(clean(rawVal, 80))}` : ': (empty)';
        }
        const lbl = nameOf(el) || el.name || el.id || '';
        lines.push(`- ${roleOf(el)}${lbl ? ` "${lbl.replace(/"/g, "'")}"` : ''} [${refOf(el)}]${meta.length ? ` [${meta.join(', ')}]` : ''}${valText}`);
      }
      if (more) break;
    }

    const submits = [];
    for (const root of roots(scope)) {
      for (const btn of root.querySelectorAll('button[type="submit"],button:not([type]),input[type="submit"]')) {
        if (!shown(btn) || submits.length >= 10) continue;
        submits.push(`- button "${(nameOf(btn) || 'Submit').replace(/"/g, "'")}" [${refOf(btn)}]${flagsOf(btn).includes('disabled') ? ' [disabled]' : ''}`);
      }
    }
    const header = `# form: ${lines.length} field(s), ${required} required, ${reqEmpty} required and empty, ${invalid} invalid${more ? ' (more past 200; narrow with --within)' : ''}`;
    return [header, ...lines, ...(submits.length ? ['# submit controls:', ...submits] : [])].join('\n');
  }

  // Structured extraction of repeated cards or HTML/ARIA tables into compact JSON rows.
  function query(opts = {}) {
    const sel = String(opts.selector || '').trim();
    if (!sel) throw new Error('INPUT_INVALID: query requires a CSS selector');
    const limit = Math.min(Math.max(1, Number(opts.limit) || 50), 500);
    const fieldsRaw = opts.fields && typeof opts.fields === 'object' ? Object.entries(opts.fields).slice(0, 30) : [];
    const matches = [];
    for (const root of roots(document)) {
      let nodes;
      try { nodes = root.querySelectorAll(sel); } catch { throw new Error(`INPUT_INVALID: invalid CSS selector "${sel}"`); }
      for (const el of nodes) {
        if (!opts.all && !shown(el)) continue;
        matches.push(el);
        if (matches.length > limit) break;
      }
      if (matches.length > limit) break;
    }
    const more = matches.length > limit;
    const kept = matches.slice(0, limit);
    const rows = [];

    const readField = (el, spec) => {
      const s = String(spec || '');
      const atIdx = s.lastIndexOf('@');
      const subSel = atIdx >= 0 ? s.slice(0, atIdx).trim() : s.trim();
      const attr = atIdx >= 0 ? s.slice(atIdx + 1).trim() : '';
      const target = subSel ? el.querySelector(subSel) : el;
      if (!target) return null;
      if (attr) {
        if (attr === 'href' && target.href) return clean(target.href, 300);
        if (attr === 'src' && target.src) return clean(target.src, 300);
        return clean(target.getAttribute?.(attr) || '', 300);
      }
      if (isSecure(target)) return '••••';
      if ('value' in target && target.tagName !== 'BUTTON' && target.tagName !== 'LI') return maskCard(clean(target.value, 300));
      return maskCard(clean(target.innerText || target.textContent, 300));
    };

    if (fieldsRaw.length > 0) {
      for (const el of kept) {
        const row = {};
        for (const [k, spec] of fieldsRaw) row[k] = readField(el, spec);
        rows.push(row);
      }
    } else if (kept.length === 1 && (kept[0].tagName === 'TABLE' || /^(table|grid|treegrid)$/.test(kept[0].getAttribute?.('role') || ''))) {
      const tbl = kept[0];
      const hdrs = [...tbl.querySelectorAll('thead th, thead [role="columnheader"], tr:first-child th, [role="row"]:first-child [role="columnheader"]')].map((h) => clean(h.innerText || h.textContent, 60));
      const keys = [];
      const used = new Set();
      for (let i = 0; i < Math.min(hdrs.length, 30); i++) {
        let baseKey = hdrs[i] || `col_${i + 1}`;
        let k = baseKey;
        for (let n = 2; used.has(k); n++) k = `${baseKey} ${n}`;
        used.add(k);
        keys.push(k);
      }
      const bodyRows = [...tbl.querySelectorAll('tbody tr, [role="row"]')].filter((r) => (opts.all || shown(r)) && !r.querySelector('th,[role="columnheader"]'));
      for (const r of bodyRows.slice(0, limit)) {
        const cells = [...r.querySelectorAll('td,[role="cell"],[role="gridcell"]')].slice(0, 30);
        if (!cells.length) continue;
        const row = {};
        cells.forEach((c, i) => { row[keys[i] || `col_${i + 1}`] = maskCard(clean(c.innerText || c.textContent, 300)); });
        rows.push(row);
      }
    } else {
      for (const el of kept) {
        const link = el.tagName === 'A' ? el.href : el.querySelector?.('a[href]')?.href || null;
        rows.push({ text: maskCard(clean(el.innerText || el.textContent, 300)), ...(link ? { link: clean(link, 300) } : {}) });
      }
    }
    const header = `# ${rows.length} row(s) for ${sel}${more ? ' (more match; raise --limit)' : ''}`;
    return [header, ...rows.map((r) => JSON.stringify(r))].join('\n');
  }

  // Parallel in-tab fetch for logged-in same-site URLs without navigating.
  async function readUrls(opts = {}) {
    const urls = Array.isArray(opts.urls) ? opts.urls.slice(0, 50) : [];
    if (!urls.length) throw new Error('INPUT_INVALID: read-urls needs at least one URL');
    const conc = Math.min(Math.max(1, Number(opts.concurrency) || 6), 10);
    const perTimeout = Math.min(Math.max(1000, Number(opts.timeoutMs) || 15000), 60000);
    const maxChars = Number(opts.maxChars) || Math.max(1500, Math.floor(18000 / urls.length));
    const results = new Array(urls.length);
    let next = 0;

    const extractHtml = (html) => {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const title = clean(doc.title || '', 120);
      for (const bad of doc.querySelectorAll('script,style,noscript,template,svg,nav,footer,aside')) bad.remove();
      const root = doc.querySelector('main,[role="main"],article') || doc.body;
      const body = clean((root?.innerText || root?.textContent || '').replace(/\n{3,}/g, '\n\n'), maxChars);
      return { title, body };
    };

    const worker = async () => {
      for (;;) {
        const idx = next++;
        if (idx >= urls.length) return;
        let abs;
        try {
          abs = new URL(urls[idx], location.href).href;
          if (!/^https?:/i.test(abs)) throw new Error('only http and https URLs are allowed');
        } catch (e) {
          results[idx] = `✗ [${idx + 1}] ${urls[idx]}: ${e.message}`;
          continue;
        }
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), perTimeout);
        try {
          const resp = await fetch(abs, { credentials: 'include', signal: ctrl.signal });
          const ctype = (resp.headers.get('content-type') || '').toLowerCase();
          if (/^image\/|^video\/|^audio\/|^application\/(pdf|octet-stream|zip)/.test(ctype)) {
            results[idx] = `## [${idx + 1}] ${abs} (${resp.status}, ${ctype})\n[binary content skipped]`;
            continue;
          }
          const raw = (await resp.text()).slice(0, 2_000_000);
          if (!resp.ok) {
            results[idx] = `✗ [${idx + 1}] ${abs} (HTTP ${resp.status}): ${clean(raw, 200)}`;
            continue;
          }
          if (ctype.includes('html')) {
            const { title, body } = extractHtml(raw);
            results[idx] = `## [${idx + 1}] ${title || abs} — ${abs} (${resp.status}, html)\n${body}`;
          } else {
            results[idx] = `## [${idx + 1}] ${abs} (${resp.status}, ${ctype || 'text'})\n${raw.slice(0, maxChars)}`;
          }
        } catch (e) {
          results[idx] = `✗ [${idx + 1}] ${abs}: ${e?.name === 'AbortError' ? `timed out after ${perTimeout}ms` : (e?.message || 'fetch failed')}`;
        } finally {
          clearTimeout(timer);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(conc, urls.length) }, worker));
    return results.join('\n\n');
  }

  // Scroll a virtualized or infinite list to collect deduplicated rows in one call.
  async function scrollRead(opts = {}) {
    const limit = Math.min(Math.max(1, Number(opts.limit) || (opts.match ? 5000 : 500)), 10000);
    const timeoutMs = Math.min(Math.max(2000, Number(opts.timeoutMs) || 25000), 60000);
    const needle = opts.match ? String(opts.match).toLowerCase() : '';

    const findList = () => {
      if (opts.within) return scopeOf(opts.within);
      let best = null;
      let bestScore = 0;
      for (const el of document.querySelectorAll('ul,ol,tbody,[role="list"],[role="grid"],[role="table"],[role="listbox"],div,section')) {
        if (!shown(el) || el.children.length < 4) continue;
        const groups = new Map();
        for (const c of el.children) {
          if (!shown(c)) continue;
          const k = `${c.tagName}.${(typeof c.className === 'string' ? c.className : '').trim().split(/\s+/).slice(0, 2).join('.')}`;
          groups.set(k, (groups.get(k) || 0) + 1);
        }
        const maxSame = Math.max(0, ...groups.values());
        if (maxSame < 4) continue;
        const score = maxSame * (el.querySelectorAll('a[href]').length > 0 ? 1.5 : 1) + Math.min(20, (el.innerText || '').length / 200);
        if (score > bestScore) { best = el; bestScore = score; }
      }
      if (!best) throw new Error('NO_MATCH: could not detect a repeated list to scroll; pass --within <selector>');
      return best;
    };

    const listEl = findList();
    const isScrollable = (el) => {
      const st = getComputedStyle(el);
      return /(auto|scroll|overlay)/.test(st.overflowY) && el.scrollHeight > el.clientHeight + 20;
    };
    let scroller = null;
    for (let cur = listEl; cur && cur !== document.documentElement; cur = cur.parentElement) {
      if (isScrollable(cur)) { scroller = cur; break; }
    }
    if (!scroller) {
      scroller = [...listEl.querySelectorAll('*')].find(isScrollable) || document.scrollingElement || document.documentElement;
    }

    const rowNodes = () => {
      const explicit = [...listEl.querySelectorAll(':scope > [role="row"],:scope > [role="listitem"],:scope > [role="option"],:scope > [role="treeitem"],:scope > li,:scope > tr,:scope > article')].filter(shown);
      if (explicit.length >= 2) return explicit;
      const deep = [...listEl.querySelectorAll('[role="row"],[role="listitem"],[role="option"],tr,article')].filter(shown);
      if (deep.length >= 2) return deep;
      return [...listEl.children].filter(shown);
    };

    const origTop = scroller.scrollTop;
    const seen = new Map();
    const deadline = performance.now() + timeoutMs;
    let stagnant = 0;
    let reason = 'scrolled to the end of the list';

    try {
      scroller.scrollTop = 0;
      await new Promise((r) => setTimeout(r, 80));
      for (;;) {
        const rows = rowNodes();
        const beforeCount = seen.size;
        for (const r of rows) {
          const text = maskCard(clean((r.innerText || r.textContent || '').replace(/\n+/g, ' · '), 400));
          if (!text) continue;
          const key = r.getAttribute?.('aria-posinset') || r.getAttribute?.('aria-rowindex')
            || r.getAttribute?.('data-index') || r.getAttribute?.('data-id') || r.getAttribute?.('data-key')
            || r.id || `${Math.round(r.offsetTop / 8)}:${text.slice(0, 80)}`;
          if (!seen.has(key)) seen.set(key, text);
        }
        if (seen.size >= limit) { reason = `reached limit of ${limit} rows`; break; }
        if (performance.now() >= deadline) { reason = `timed out after ${timeoutMs}ms`; break; }
        const prevTop = scroller.scrollTop;
        const step = Math.max(200, Math.round((scroller === document.scrollingElement ? innerHeight : scroller.clientHeight) * 0.9));
        scroller.scrollTop = prevTop + step;
        await new Promise((r) => setTimeout(r, 120));
        if (scroller.scrollTop === prevTop && seen.size === beforeCount) {
          stagnant++;
          if (stagnant >= 2) break;
          await new Promise((r) => setTimeout(r, 250));
        } else {
          stagnant = 0;
        }
      }
    } finally {
      scroller.scrollTop = origTop;
    }

    const allRows = [...seen.values()];
    const matched = needle ? allRows.filter((r) => r.toLowerCase().includes(needle)) : allRows;
    const shownRows = matched.slice(0, limit);
    const footer = needle
      ? `# [${matched.length} of ${allRows.length} rows match "${opts.match}"; ${reason}]`
      : `# [${allRows.length} rows read; ${reason}]`;
    return [...shownRows.map((r, i) => `${i + 1}. ${r}`), footer].join('\n');
  }

  const SKIP_TEXT = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|SVG|CANVAS|VIDEO|AUDIO|IFRAME|OBJECT|HEAD|INPUT|TEXTAREA|SELECT)$/i;
  const BLOCK_TEXT = /^(ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|DD|DETAILS|DIALOG|DIV|DL|DT|FIELDSET|FIGCAPTION|FIGURE|FOOTER|FORM|H[1-6]|HEADER|HR|LI|MAIN|NAV|OL|P|PRE|SECTION|SUMMARY|TABLE|TBODY|THEAD|TFOOT|TR|UL)$/;

  // Detect pagination / result scope hint on the page.
  const scopeHint = () => {
    const bodyText = ((document.body && document.body.innerText) || '').slice(0, 12000);
    const range = /\b\d[\d,]*\s*[–-]\s*\d[\d,]*\s+of\s+\d[\d,]*(?:\s+\w+)?/i.exec(bodyText)?.[0];
    const total = !range && /\b\d[\d,]*\s+(?:results?|items?|matches|records|entries)\b/i.exec(bodyText)?.[0];
    const pageOf = /\bpage\s+\d+\s+of\s+\d+\b/i.exec(bodyText)?.[0];
    const hasNext = !!document.querySelector('a[rel="next"], button[aria-label*="next" i], a[aria-label*="next" i]');
    const parts = [range || total, pageOf, hasNext ? 'has Next page link' : ''].filter(Boolean);
    return parts.length ? `# scope: ${parts.join('; ')}` : '';
  };

  // The page's readable content as compact markdown. Folds noisy site navbars/filters unless --all.
  function text(opts = {}) {
    const max = opts.max || 20000;
    const main = !opts.within && !opts.all && [...document.querySelectorAll('main,[role="main"],article')].find(shown);
    const root = opts.within ? scopeOf(opts.within) : main || document.body;
    const out = [];
    const hidden = (el) => (el.checkVisibility ? !el.checkVisibility({ checkVisibilityCSS: true }) : false);

    const inline = (node) => {
      if (node.nodeType === 3) return node.textContent;
      if (node.nodeType !== 1 || SKIP_TEXT.test(node.tagName) || hidden(node)) return '';
      if (node.tagName === 'BR') return '\n';
      if (node.tagName === 'IMG') return node.alt ? `![${clean(node.alt, 80)}]` : '';
      let inner = '';
      for (const c of (node.shadowRoot || node).childNodes) inner += inline(c);
      if (/^(BUTTON|LABEL|TD|TH|OPTION|SUMMARY)$/.test(node.tagName)) inner = ` ${inner} `;
      const href = node.tagName === 'A' && node.getAttribute('href');
      return href && clean(inner) && !/^(#|javascript:)/i.test(href) ? `[${clean(inner, 200)}](${node.href})` : inner;
    };
    const push = (s) => { const t = s.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim(); if (t) out.push(t); };

    const shouldFoldNav = (el) => {
      if (opts.all || opts.within) return '';
      const role = el.getAttribute?.('role') || '';
      const tag = el.tagName;
      if ((tag === 'NAV' || role === 'navigation' || tag === 'FOOTER') && !el.querySelector?.('main,article')) {
        const lbl = (el.getAttribute?.('aria-label') || '').toLowerCase();
        if (/breadcrumb|pagination|contents|toc/.test(lbl)) return '';
        const links = [...el.querySelectorAll('a[href]')].filter(shown);
        if (links.length >= 6 && (el.innerText || '').length >= 100) {
          const sample = links.slice(0, 4).map((a) => clean(a.innerText, 20)).filter(Boolean).join(' · ');
          return `[navigation hidden, ${links.length} links${sample ? `: ${sample} ...` : ''}; pass --all to show]`;
        }
      }
      // Large filter panel (16+ short filter checkboxes/radios/links).
      if (tag !== 'ARTICLE' && !el.querySelector?.('main,article') && (tag === 'ASIDE' || tag === 'DIV' || tag === 'SECTION' || tag === 'FORM')) {
        const ctrls = [...el.querySelectorAll('input[type="checkbox"],input[type="radio"],[role="checkbox"],[role="option"]')].filter(shown);
        if (ctrls.length >= 16) {
          const sel = ctrls.filter((c) => c.checked || c.getAttribute?.('aria-checked') === 'true').map((c) => nameOf(c)).filter(Boolean).slice(0, 4);
          return `[filters hidden, ${ctrls.length} options${sel.length ? `; selected: ${sel.join(', ')}` : ''}; pass --all to show, snap gives their refs]`;
        }
      }
      return '';
    };

    const walk = (el) => {
      if (SKIP_TEXT.test(el.tagName)) {
        if (el.tagName === 'IFRAME') { try { if (el.contentDocument?.body) walk(el.contentDocument.body); } catch { /* cross-origin */ } }
        return;
      }
      if (hidden(el)) return;
      const folded = shouldFoldNav(el);
      if (folded) return push(folded);
      const tag = el.tagName;
      const role = el.getAttribute?.('role') || '';
      if (/^H[1-6]$/.test(tag)) return push(`${'#'.repeat(Number(tag[1]))} ${inline(el)}`);
      if (tag === 'PRE') return push('```\n' + el.innerText.trim() + '\n```');
      if (tag === 'TR') return push(`| ${[...el.cells].map((c) => clean(inline(c), 200)).join(' | ')} |`);
      if (role === 'row') {
        const cells = [...el.querySelectorAll('[role="cell"],[role="gridcell"],[role="columnheader"],[role="rowheader"]')];
        if (cells.length) return push(`| ${cells.map((c) => clean(inline(c), 200)).join(' | ')} |`);
      }
      if (role === 'grid' || role === 'table' || role === 'treegrid') {
        const rc = Number(el.getAttribute?.('aria-rowcount') || 0);
        const rendered = el.querySelectorAll('[role="row"]').length;
        if (rc > rendered && rendered > 0) {
          push(`(${rendered} of ${rc} rows rendered; virtualized grid: use text --scroll to read all rows)`);
        }
      }
      let run = '';
      const flush = () => { if (run.trim()) push(tag === 'LI' ? `- ${run}` : run); run = ''; };
      for (const c of (el.shadowRoot || el).childNodes) {
        if (c.nodeType === 1 && (BLOCK_TEXT.test(c.tagName) || c.tagName === 'IFRAME' || c.getAttribute?.('role') === 'row'
          || c.querySelector?.('p,div,li,tr,h1,h2,h3,h4,h5,h6,section,article,ul,ol,table,[role="row"]'))) { flush(); walk(c); }
        else run += inline(c);
      }
      flush();
    };

    walk(root);
    let body = out.join('\n\n').replace(/(^|\n)(- [^\n]*)\n\n(?=- )/g, '$1$2\n').replace(/(\|[^\n]*\|)\n\n(?=\|)/g, '$1\n');
    const head = [`# ${clean(document.title, 100)} | ${location.origin}${location.pathname}`];
    const w = wall();
    if (w) head.push(wallLine(w));
    if (main) head.push('# Main content only. Pass --all for the whole page.');
    const sc = scopeHint();
    if (sc) head.push(sc);
    if (body.length > max) body = `${body.slice(0, max)}\n# [truncated ${body.length - max} of ${body.length} chars; narrow with --within <ref|css> or raise --max]`;
    return `${head.join('\n')}\n\n${body}`;
  }

  Object.defineProperty(globalThis, '__bc', {
    value: {
      v: VERSION, snapshot, wall, surface, canvasHash, point, guard, guardFocused, focusForType,
      setTypedValue, verifyRef, healRef, armInputProbe, readInputProbe, cellInfo, cellEditor, cellRead,
      dragInfo, listPosition, select, locateOption, locateFile, el: resolve, checkWait, value,
      verdict, health, frames, frameOffset, baseline, settle, diff, locate, hit, rect, viewport,
      markBoxes, marks, form, query, readUrls, scrollRead, text,
    },
    configurable: true, enumerable: false,
  });
})();
