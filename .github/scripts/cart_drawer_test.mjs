// Regression test for the cart drawer (sections/gk-cart-drawer.liquid).
//
// The PDP variant-picker test stops at the hidden name="id" input; this test
// exercises the code that actually creates the order — the drawer's
// /cart/add.js interception and its /cart/change.js line mutations.
//
// Like variant_picker_test.mjs, it avoids asserting on template text:
//   1. checks the template's line-addressing contract (immutable item keys),
//   2. builds a mini-DOM fixture the way the template would,
//   3. extracts and runs the REAL inline <script> from gk-cart-drawer.liquid,
//   4. submits add forms and clicks line controls, asserting on the network
//      requests the drawer issues.
//
// Mutation semantics under test: everything flows through one serialized
// queue — nothing is silently dropped while a request is in flight (two
// rapid adds of different products both land), same-form double-submits are
// debounced, and rapid +/− clicks on a line coalesce to the final quantity.
//
// Runs on plain Node (no dependencies): node .github/scripts/cart_drawer_test.mjs

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const themeRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const drawerSrc = readFileSync(join(themeRoot, 'sections', 'gk-cart-drawer.liquid'), 'utf8');

const SECTION_ID = 'gk-drawer-test';

// ---------------------------------------------------------------------------
// 1. Template contract: lines are addressed by immutable item key
// ---------------------------------------------------------------------------
// /cart/change.js is called with { id: <line item key> }, never a 1-based
// line index, so a queued mutation can't hit the wrong line after a removal
// re-numbers the cart. That requires the key on every rendered line.

if (!/class="gk-cart-line"[^>]*data-key="\{\{\s*item\.key\s*\}\}"/.test(drawerSrc)) {
  throw new Error('sections/gk-cart-drawer.liquid no longer renders data-key="{{ item.key }}" on .gk-cart-line — the drawer JS addresses lines by key; update the template or cart_drawer_test.mjs to match.');
}

// ---------------------------------------------------------------------------
// 2. Minimal DOM: just enough for the drawer script
// ---------------------------------------------------------------------------

class El {
  constructor(tag = 'div', classes = [], attrs = {}) {
    this.tag = tag.toLowerCase();
    this.classes = new Set(classes);
    this.attributes = {};
    this.dataset = {};
    this.children = [];
    this.parentElement = null;
    this.handlers = {};
    this.textContent = '';
    this.innerHTML = '';
    this.value = '';
    this.name = '';
    this.hidden = false;
    this.disabled = false;
    this.offsetParent = null;
    this.submitted = false;
    for (const [k, v] of Object.entries(attrs)) this.setAttribute(k, v);
    const self = this;
    this.classList = {
      add: (c) => self.classes.add(c),
      remove: (c) => self.classes.delete(c),
      contains: (c) => self.classes.has(c),
      toggle: (c, force) => {
        const on = force === undefined ? !self.classes.has(c) : Boolean(force);
        if (on) self.classes.add(c); else self.classes.delete(c);
        return on;
      },
    };
  }
  append(...kids) {
    for (const k of kids) { k.parentElement = this; this.children.push(k); }
    return this;
  }
  addEventListener(type, fn) { (this.handlers[type] ||= []).push(fn); }
  removeEventListener(type, fn) {
    this.handlers[type] = (this.handlers[type] || []).filter((f) => f !== fn);
  }
  setAttribute(k, v) {
    this.attributes[k] = String(v);
    if (k === 'name') this.name = String(v);
    if (k === 'value') this.value = String(v);
    if (k.startsWith('data-')) {
      const key = k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      this.dataset[key] = String(v);
    }
  }
  getAttribute(k) { return k in this.attributes ? this.attributes[k] : null; }
  focus() {}
  submit() { this.submitted = true; }
  // Selector support for exactly what the drawer script uses: tag, .class,
  // [attr], [attr="v"], [attr*="v"], :not(...) — comma-separated.
  matches(sel) {
    return sel.split(',').some((part) => this.#matchesOne(part.trim()));
  }
  #matchesOne(part) {
    const tagM = part.match(/^[a-z][\w-]*/i);
    if (tagM && this.tag !== tagM[0].toLowerCase()) return false;
    const rest = tagM ? part.slice(tagM[0].length) : part;
    const toks = rest.match(/\.[\w-]+|\[[^\]]*\]|:not\([^)]*\)/g) || [];
    if (toks.join('') !== rest) {
      throw new Error(`cart_drawer_test.mjs mini-DOM cannot parse selector "${part}" — extend El.matches().`);
    }
    return toks.every((t) => this.#matchesToken(t));
  }
  #matchesToken(tok) {
    if (tok.startsWith('.')) return this.classes.has(tok.slice(1));
    if (tok.startsWith(':not(')) return !this.#matchesToken(tok.slice(5, -1));
    if (tok.startsWith('[')) {
      const inner = tok.slice(1, -1);
      let m;
      if ((m = inner.match(/^([\w-]+)\*="?([^"\]]*)"?$/))) {
        const v = this.getAttribute(m[1]);
        return v !== null && v.includes(m[2]);
      }
      if ((m = inner.match(/^([\w-]+)="?([^"\]]*)"?$/))) {
        return this.getAttribute(m[1]) === m[2];
      }
      if (inner === 'disabled') return Boolean(this.disabled);
      return this.getAttribute(inner) !== null;
    }
    throw new Error(`cart_drawer_test.mjs mini-DOM cannot match selector token "${tok}" — extend El.matches().`);
  }
  *walk() { for (const c of this.children) { yield c; yield* c.walk(); } }
  querySelectorAll(sel) { return [...this.walk()].filter((el) => el.matches(sel)); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  closest(sel) {
    let n = this;
    while (n) { if (n.matches(sel)) return n; n = n.parentElement; }
    return null;
  }
}

function makeDocument(root) {
  const doc = {
    handlers: {},
    documentElement: new El('html'),
    body: new El('body'),
    activeElement: null,
    addEventListener(type, fn) { (doc.handlers[type] ||= []).push(fn); },
    querySelector: (sel) => root.querySelector(sel),
    querySelectorAll: (sel) => root.querySelectorAll(sel),
    getElementById: (id) => [...root.walk()].find((el) => el.getAttribute('id') === id) || null,
    createElement: (tag) => new El(tag),
  };
  return doc;
}

// Synthetic event dispatch with bubbling: target → ancestors → document.
function dispatch(doc, type, target, extra = {}) {
  const e = Object.assign({
    type,
    target,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
  }, extra);
  let node = target;
  while (node) {
    for (const fn of (node.handlers[type] || []).slice()) fn(e);
    node = node.parentElement;
  }
  for (const fn of (doc.handlers[type] || []).slice()) fn(e);
  return e;
}

class FormDataStub {
  constructor(form) {
    this._entries = [];
    if (form) {
      for (const el of form.walk()) {
        if (!el.name || el.disabled) continue;
        if (el.tag === 'input' || el.tag === 'select' || el.tag === 'textarea') {
          this._entries.push([el.name, String(el.value)]);
        }
      }
    }
  }
  append(name, value) { this._entries.push([String(name), String(value)]); }
  get(name) { const e = this._entries.find((x) => x[0] === name); return e ? e[1] : null; }
  entries() { return this._entries[Symbol.iterator](); }
}

class DOMParserStub {
  parseFromString() { return { querySelector: () => null }; }
}

// ---------------------------------------------------------------------------
// 3. Fixture: drawer + cart lines + two product add forms elsewhere on the page
// ---------------------------------------------------------------------------

function buildFixture({ lines = [{ qty: 2, key: '40001:aaa' }, { qty: 1, key: '40002:bbb' }], variantId = '1001', formQty = '2' } = {}) {
  const root = new El('div', ['root']);

  const drawer = new El('div', ['gk-cart-drawer'], { 'data-gk-cart': '', 'data-section-id': SECTION_ID, id: 'gk-cart-drawer' });
  drawer.hidden = true;
  const backdrop = new El('div', ['gk-cart-backdrop'], { 'data-gk-cart-close': '' });
  const panel = new El('aside', ['gk-cart-panel']);
  const head = new El('header', ['gk-cart-head']);
  const count = new El('span', ['gk-cart-headcount'], { 'data-gk-cart-count': '' });
  count.textContent = String(lines.length);
  const closeBtn = new El('button', ['gk-cart-close'], { 'data-gk-cart-close': '' });
  head.append(count, closeBtn);
  const renderRegion = new El('div', ['gk-cart-render'], { 'data-gk-cart-render': '' });
  const cartForm = new El('form', ['gk-cart-form'], { action: '/cart', id: 'gk-cart-form' });
  const ul = new El('ul', ['gk-cart-lines'], { 'data-gk-cart-lines': '' });
  const lineEls = lines.map((l) => {
    const li = new El('li', ['gk-cart-line'], { 'data-key': l.key });
    const minus = new El('button', ['gk-qty-btn'], { 'data-gk-cart-minus': '' });
    const input = new El('input', ['gk-cart-qty-input'], { 'data-gk-cart-qty': '', name: 'updates[]', value: String(l.qty) });
    const plus = new El('button', ['gk-qty-btn'], { 'data-gk-cart-plus': '' });
    const remove = new El('button', ['gk-cart-remove'], { 'data-gk-cart-remove': '' });
    li.append(minus, input, plus, remove);
    ul.append(li);
    return { li, minus, input, plus, remove, key: l.key };
  });
  cartForm.append(ul);
  renderRegion.append(cartForm);
  panel.append(head, renderRegion);
  drawer.append(backdrop, panel);

  // Two product add forms, the way the PDP / quick-add cards render them
  // (outside the drawer) — two DIFFERENT products for the rapid-add tests.
  const addForm = new El('form', ['gk-pdp-form'], { action: '/cart/add', id: 'gk-add-form' });
  const idInput = new El('input', [], { name: 'id', value: variantId, id: 'gk-variant-id' });
  const qtyInput = new El('input', [], { name: 'quantity', value: formQty });
  const addBtn = new El('button', ['gk-btn', 'gk-pdp-add'], { type: 'submit' });
  addForm.append(idInput, qtyInput, addBtn);
  const addForm2 = new El('form', ['gk-qa-form'], { action: '/cart/add', id: 'gk-add-form-2' });
  const idInput2 = new El('input', [], { name: 'id', value: '1002' });
  const qtyInput2 = new El('input', [], { name: 'quantity', value: '1' });
  const addBtn2 = new El('button', ['gk-qa'], { type: 'submit' });
  addForm2.append(idInput2, qtyInput2, addBtn2);

  root.append(drawer, addForm, addForm2);
  const document = makeDocument(root);
  return { root, document, drawer, panel, count, lines: lineEls, addForm, idInput, qtyInput, addForm2 };
}

// ---------------------------------------------------------------------------
// 4. Extract the real inline script and run it against the fixture
// ---------------------------------------------------------------------------

function drawerScript() {
  const m = drawerSrc.match(/<script>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('No inline <script> found in sections/gk-cart-drawer.liquid — update cart_drawer_test.mjs.');
  if (/\{\{|\{%/.test(m[1])) {
    throw new Error('The drawer inline <script> now contains Liquid — add interpolation support to cart_drawer_test.mjs (see variant_picker_test.mjs).');
  }
  return m[1];
}

function makeFetch(calls, { failAdd = false, rejectChangeOnce = false } = {}) {
  const json = (obj) => Promise.resolve({ ok: true, json: () => Promise.resolve(obj), text: () => Promise.resolve('') });
  let changeRejections = rejectChangeOnce ? 1 : 0;
  return function fetchStub(url, opts) {
    calls.push({ url: String(url), opts: opts || {} });
    if (String(url) === '/cart/change.js' && changeRejections > 0) {
      changeRejections -= 1;
      return Promise.reject(new Error('network down'));
    }
    if (String(url) === '/cart/add.js' && failAdd) {
      return Promise.resolve({ ok: false, json: () => Promise.resolve({ status: 422, description: 'sold out' }) });
    }
    if (String(url) === '/cart.js') return json({ item_count: 3 });
    if (String(url).startsWith('/?section_id=')) {
      return Promise.resolve({ ok: true, text: () => Promise.resolve('<div data-gk-cart-render></div>'), json: () => Promise.resolve({}) });
    }
    return json({});
  };
}

function setup(opts = {}) {
  const fx = buildFixture(opts);
  fx.calls = [];
  new Function('document', 'window', 'fetch', 'FormData', 'DOMParser', 'requestAnimationFrame', drawerScript())(
    fx.document, {}, makeFetch(fx.calls, opts), FormDataStub, DOMParserStub, (fn) => fn(),
  );
  return fx;
}

// Let the drawer's promise chains (queue → fetch → refresh) settle.
const flush = () => new Promise((r) => setTimeout(r, 0));
async function settle(n = 6) { for (let i = 0; i < n; i++) await flush(); }

// ---------------------------------------------------------------------------
// 5. Tests
// ---------------------------------------------------------------------------

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL  ${name}\n      ${err.message}`);
  }
}
function assertEqual(actual, expected, what) {
  if (String(actual) !== String(expected)) {
    throw new Error(`${what}: expected ${JSON.stringify(String(expected))}, got ${JSON.stringify(String(actual))}`);
  }
}

console.log('cart drawer regression test');

await check('add: posts the selected variant id and quantity to /cart/add.js', async () => {
  const fx = setup();
  const e = dispatch(fx.document, 'submit', fx.addForm);
  if (!e.defaultPrevented) throw new Error('submit was not intercepted — a native POST (full page navigation) would have fired');
  await settle();
  const add = fx.calls.find((c) => c.url === '/cart/add.js');
  if (!add) throw new Error('no POST to /cart/add.js');
  assertEqual(add.opts.method, 'POST', 'method');
  assertEqual(add.opts.body.get('id'), '1001', 'posted variant id — must match the hidden name="id" input');
  assertEqual(add.opts.body.get('quantity'), '2', 'posted quantity');
});

await check('add: refreshes via /cart.js + the section render URL and opens the drawer', async () => {
  const fx = setup();
  dispatch(fx.document, 'submit', fx.addForm);
  await settle();
  if (!fx.calls.some((c) => c.url === '/cart.js')) throw new Error('no /cart.js refresh after add');
  if (!fx.calls.some((c) => c.url === '/?section_id=' + encodeURIComponent(SECTION_ID))) {
    throw new Error('no Section Rendering API refresh after add');
  }
  if (fx.drawer.hidden) throw new Error('drawer did not open after a successful add');
  assertEqual(fx.count.textContent, '3', 'header cart count after refresh');
});

await check('lines: + posts the line key and incremented quantity to /cart/change.js', async () => {
  const fx = setup(); // line 2 starts at qty 1
  dispatch(fx.document, 'click', fx.lines[1].plus);
  await settle();
  const change = fx.calls.find((c) => c.url === '/cart/change.js');
  if (!change) throw new Error('no POST to /cart/change.js');
  assertEqual(change.opts.method, 'POST', 'method');
  const body = JSON.parse(change.opts.body);
  assertEqual(body.id, fx.lines[1].key, 'line item key — index addressing hits the WRONG line after a removal');
  assertEqual(body.quantity, 2, 'quantity after +');
  assertEqual(fx.lines[1].input.value, '2', 'input updates optimistically');
});

await check('lines: − posts the decremented quantity, clamped at 0', async () => {
  const fx = setup(); // line 1 starts at qty 2
  dispatch(fx.document, 'click', fx.lines[0].minus);
  await settle();
  let body = JSON.parse(fx.calls.find((c) => c.url === '/cart/change.js').opts.body);
  assertEqual(body.id, fx.lines[0].key, 'line item key');
  assertEqual(body.quantity, 1, 'quantity after −');
  fx.calls.length = 0;
  fx.lines[0].input.value = '0';
  dispatch(fx.document, 'click', fx.lines[0].minus);
  await settle();
  body = JSON.parse(fx.calls.find((c) => c.url === '/cart/change.js').opts.body);
  assertEqual(body.quantity, 0, 'quantity clamps at 0, never negative');
});

await check('lines: typing a quantity posts the typed value for that line', async () => {
  const fx = setup();
  fx.lines[0].input.value = '5';
  dispatch(fx.document, 'change', fx.lines[0].input);
  await settle();
  const body = JSON.parse(fx.calls.find((c) => c.url === '/cart/change.js').opts.body);
  assertEqual(body.id, fx.lines[0].key, 'line item key');
  assertEqual(body.quantity, 5, 'typed quantity');
});

await check('lines: remove posts quantity 0 for that line', async () => {
  const fx = setup();
  dispatch(fx.document, 'click', fx.lines[1].remove);
  await settle();
  const body = JSON.parse(fx.calls.find((c) => c.url === '/cart/change.js').opts.body);
  assertEqual(body.id, fx.lines[1].key, 'line item key');
  assertEqual(body.quantity, 0, 'remove posts quantity 0');
});

await check('lines: rapid +/+ coalesces to one request with the compounded quantity', async () => {
  const fx = setup(); // line 1 starts at qty 2
  dispatch(fx.document, 'click', fx.lines[0].plus);
  dispatch(fx.document, 'click', fx.lines[0].plus); // before the first resolves
  await settle();
  const changes = fx.calls.filter((c) => c.url === '/cart/change.js');
  assertEqual(changes.length, 1, 'requests — rapid clicks coalesce, they are not dropped');
  assertEqual(JSON.parse(changes[0].opts.body).quantity, 4, 'quantity compounds 2 → 3 → 4 across rapid clicks');
  assertEqual(fx.lines[0].input.value, '4', 'input reflects both clicks');
});

await check('adds: two different products in quick succession BOTH post', async () => {
  const fx = setup();
  dispatch(fx.document, 'submit', fx.addForm);
  dispatch(fx.document, 'submit', fx.addForm2); // while the first add is in flight
  await settle();
  const adds = fx.calls.filter((c) => c.url === '/cart/add.js');
  assertEqual(adds.length, 2, 'POSTs to /cart/add.js — the old global busy-lock silently swallowed the second product');
  assertEqual(adds[0].opts.body.get('id'), '1001', 'first add id');
  assertEqual(adds[1].opts.body.get('id'), '1002', 'second add id (queued, in order)');
  if (fx.drawer.classList.contains('is-busy')) throw new Error('drawer stuck is-busy after the queue drained');
});

await check('adds: double-submitting the SAME form while in flight posts once', async () => {
  const fx = setup();
  dispatch(fx.document, 'submit', fx.addForm);
  dispatch(fx.document, 'submit', fx.addForm);
  await settle();
  assertEqual(fx.calls.filter((c) => c.url === '/cart/add.js').length, 1, 'a double-click must not add the product twice');
});

await check('queue: a qty click during an in-flight add lands after it, in order', async () => {
  const fx = setup();
  dispatch(fx.document, 'submit', fx.addForm);
  dispatch(fx.document, 'click', fx.lines[0].plus);
  await settle();
  const urls = fx.calls.map((c) => c.url);
  const addIdx = urls.indexOf('/cart/add.js');
  const changeIdx = urls.indexOf('/cart/change.js');
  if (addIdx === -1) throw new Error('add was dropped');
  if (changeIdx === -1) throw new Error('qty change during an in-flight add was silently dropped');
  if (changeIdx < addIdx) throw new Error('mutations ran out of order');
});

await check('queue: releases after each resolved request', async () => {
  const fx = setup();
  dispatch(fx.document, 'submit', fx.addForm);
  await settle();
  if (fx.drawer.classList.contains('is-busy')) throw new Error('drawer stuck is-busy after a resolved add');
  dispatch(fx.document, 'click', fx.lines[0].plus);
  await settle();
  if (!fx.calls.some((c) => c.url === '/cart/change.js')) {
    throw new Error('quantity change blocked after a resolved add — the queue wedged');
  }
  fx.calls.length = 0;
  dispatch(fx.document, 'click', fx.lines[0].plus);
  await settle();
  if (!fx.calls.some((c) => c.url === '/cart/change.js')) {
    throw new Error('second quantity change blocked — the queue wedged after /cart/change.js resolved');
  }
});

await check('queue: a failed change still resyncs the drawer and keeps working', async () => {
  const fx = setup({ rejectChangeOnce: true });
  dispatch(fx.document, 'click', fx.lines[0].plus);
  await settle();
  if (!fx.calls.some((c) => c.url === '/cart.js')) throw new Error('no resync refresh after the failed change');
  fx.calls.length = 0;
  dispatch(fx.document, 'click', fx.lines[0].minus);
  await settle();
  if (!fx.calls.some((c) => c.url === '/cart/change.js')) throw new Error('queue wedged after a failed change');
});

await check('queue: releases after a failed add (falls back to native submit)', async () => {
  const fx = setup({ failAdd: true });
  dispatch(fx.document, 'submit', fx.addForm);
  await settle();
  if (!fx.addForm.submitted) throw new Error('failed AJAX add did not fall back to a native form submit');
  if (fx.drawer.classList.contains('is-busy')) throw new Error('drawer stuck is-busy after a failed add');
});

await check('guard: a blank variant id is never posted to /cart/add.js', async () => {
  const fx = setup({ variantId: '' });
  const e = dispatch(fx.document, 'submit', fx.addForm);
  if (!e.defaultPrevented) throw new Error('submit not intercepted');
  await settle();
  if (fx.calls.some((c) => c.url === '/cart/add.js')) {
    throw new Error('an empty variant id was POSTed to /cart/add.js — the PDP clears it when no variant matches the selection, and a blank/stale id must never reach the cart');
  }
  if (fx.addForm.submitted) throw new Error('an empty variant id fell through to a native form submit');
  if (fx.drawer.classList.contains('is-busy')) throw new Error('drawer left is-busy after refusing a blank id');
});

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('all checks passed');
