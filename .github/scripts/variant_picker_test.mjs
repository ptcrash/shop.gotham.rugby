// Regression test for the PDP variant picker (sections/product.liquid).
//
// Guards against the launch-day bug where every add-to-cart submitted the
// DEFAULT variant: the template rendered data-option from the inner value
// loop's forloop.index (the value's position) instead of the option's
// position, so the picker JS never matched the clicked size and the hidden
// name="id" input stayed on the first variant (a 2XS shipped for an L).
//
// Rather than asserting on template text, this test:
//   1. parses the data-option expressions the template actually renders
//      for size buttons and color swatches,
//   2. builds a mini-DOM fixture the way the template would (including the
//      buggy attribute values, if the expression regresses),
//   3. extracts and runs the REAL inline <script> from product.liquid,
//   4. clicks through single-option and color x size products and asserts
//      the hidden variant-id input tracks every selection.
//
// Runs on plain Node (no dependencies): node .github/scripts/variant_picker_test.mjs

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const themeRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const productSrc = readFileSync(join(themeRoot, 'sections', 'product.liquid'), 'utf8');
const swatchSrc = readFileSync(join(themeRoot, 'snippets', 'swatch.liquid'), 'utf8');

// ---------------------------------------------------------------------------
// 1. Parse what the template renders into data-option
// ---------------------------------------------------------------------------

const sizeBtn = productSrc.match(/class="gk-pdp-size[^"]*"[^>]*data-option="\{\{\s*(.+?)\s*\}\}"/);
if (!sizeBtn) {
  throw new Error('Could not find the size button data-option expression in sections/product.liquid — the markup changed, update variant_picker_test.mjs to match.');
}
const swatchCall = productSrc.match(/render\s+'swatch'[^%]*?position:\s*([\w.]+)/);
if (!swatchCall) {
  throw new Error("Could not find the render 'swatch' ... position: argument in sections/product.liquid — update variant_picker_test.mjs to match.");
}
if (!/data-option="\{\{\s*position\s*\}\}"/.test(swatchSrc)) {
  throw new Error('snippets/swatch.liquid no longer renders data-option="{{ position }}" — update variant_picker_test.mjs to match.');
}
const EXPRS = { size: sizeBtn[1], swatch: swatchCall[1] };

// Evaluate a Liquid data-option expression the way the template would.
// optionPos/valuePos are 1-based. 'forloop.index' (the value's position) is
// the historical bug — supported here so the test FAILS on behavior, with a
// message pointing at the symptom, rather than erroring out.
function evalOptionExpr(expr, optionPos, valuePos) {
  switch (expr) {
    case 'option.position': return optionPos;
    case 'forloop.parentloop.index': return optionPos;
    case 'forloop.parentloop.index0': return optionPos - 1;
    case 'forloop.index': return valuePos;
    case 'forloop.index0': return valuePos - 1;
    default:
      throw new Error(`Unrecognized data-option expression "${expr}" in sections/product.liquid — update evalOptionExpr() in variant_picker_test.mjs.`);
  }
}

// ---------------------------------------------------------------------------
// 2. Minimal DOM: just enough for the picker script
// ---------------------------------------------------------------------------

class El {
  constructor(classes = [], id = '') {
    this.classes = new Set(classes);
    this.id = id;
    this.dataset = {};
    this.attributes = {};
    this.children = [];
    this.parentElement = null;
    this.handlers = {};
    this.textContent = '';
    this.value = '';
    this.hidden = false;
    this.disabled = false;
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
  click() { for (const fn of this.handlers.click || []) fn({ preventDefault() {} }); }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  removeAttribute(k) { delete this.attributes[k]; }
  getAttribute(k) { return k in this.attributes ? this.attributes[k] : null; }
  // Class-only selectors, optionally comma-separated: '.a.b, .c'
  matches(sel) {
    return sel.split(',').some((part) => {
      part = part.trim();
      if (!part.startsWith('.')) return false;
      return part.slice(1).split('.').every((c) => this.classes.has(c));
    });
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

// ---------------------------------------------------------------------------
// 3. Fixture products and DOM construction (mirrors the template's markup)
// ---------------------------------------------------------------------------

function makeProduct(options, optionValues, { unavailable = [], prices = {} } = {}) {
  const variants = [];
  const combos = optionValues.reduce(
    (acc, values) => acc.flatMap((c) => values.map((v) => [...c, v])),
    [[]],
  );
  combos.forEach((opts, i) => {
    const title = opts.join(' / ');
    variants.push({
      id: 1001 + i,
      title,
      options: opts,
      available: !unavailable.includes(title),
      price: prices[title] ?? 4500,
    });
  });
  return { options, optionValues, variants };
}

function buildFixture(product) {
  const first = product.variants.find((v) => v.available) || product.variants[0];
  const root = new El(['root']);
  const byId = {};
  const reg = (el) => { byId[el.id] = el; return el; };

  const form = reg(new El(['gk-pdp-form'], 'gk-add-form'));
  const idInput = reg(new El([], 'gk-variant-id'));
  idInput.value = String(first.id);
  form.append(idInput);

  product.options.forEach((name, oi) => {
    const isColor = /^colou?r$/i.test(name);
    const optWrap = new El(['gk-pdp-option']);
    if (isColor) optWrap.append(new El(['gk-pdp-optval']));
    const group = new El([isColor ? 'gk-pdp-swatches' : 'gk-pdp-sizes']);
    product.optionValues[oi].forEach((val, vi) => {
      const btn = new El([isColor ? 'gk-pdp-swatch' : 'gk-pdp-size']);
      btn.dataset.option = String(evalOptionExpr(isColor ? EXPRS.swatch : EXPRS.size, oi + 1, vi + 1));
      btn.dataset.value = val;
      if (first.options[oi] === val) btn.classes.add('is-active');
      group.append(btn);
    });
    optWrap.append(group);
    form.append(optWrap);
  });

  const addBtn = new El(['gk-pdp-add']);
  const addLabel = new El(['gk-pdp-add-label']);
  addLabel.textContent = 'Add to cart · ';
  const addPrice = reg(new El([], 'gk-add-price'));
  addBtn.append(addLabel, addPrice);
  const qty = reg(new El([], 'gk-qty'));
  qty.value = '1';
  form.append(addBtn, qty);

  root.append(form, reg(new El([], 'gk-price')), reg(new El([], 'gk-stickybar-meta')), reg(new El([], 'gk-stickybar')));

  const document = {
    getElementById: (id) => byId[id] || null,
    querySelectorAll: (sel) => root.querySelectorAll(sel),
    querySelector: (sel) => root.querySelector(sel),
    activeElement: null,
    body: new El(['body']),
  };
  document.body.style = {};
  return { document, form, idInput, byId };
}

// ---------------------------------------------------------------------------
// 4. Extract the real inline script and substitute its Liquid interpolations
// ---------------------------------------------------------------------------

function pickerScript(product) {
  const m = productSrc.match(/<script>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('No inline <script> found in sections/product.liquid — update variant_picker_test.mjs.');
  const LIQUID = {
    'product.variants | json': JSON.stringify(product.variants),
    'product.options | json': JSON.stringify(product.options),
    'shop.money_format | strip_html | json': JSON.stringify('${{amount}}'),
  };
  return m[1].replace(/\{\{\s*(.+?)\s*\}\}/g, (_, inner) => {
    const key = inner.replace(/\s+/g, ' ').trim();
    if (!(key in LIQUID)) {
      throw new Error(`Inline script uses a Liquid interpolation this test does not know: "{{ ${key} }}" — add it to LIQUID in variant_picker_test.mjs.`);
    }
    return LIQUID[key];
  });
}

function runPicker(product) {
  const fixture = buildFixture(product);
  new Function('document', 'window', pickerScript(product))(fixture.document, {});
  return fixture;
}

function clickValue(fixture, value) {
  const btn = fixture.form
    .querySelectorAll('.gk-pdp-size, .gk-pdp-swatch')
    .find((b) => b.dataset.value === value);
  if (!btn) throw new Error(`No picker button found for value "${value}"`);
  btn.click();
  return btn;
}

// ---------------------------------------------------------------------------
// 5. Tests
// ---------------------------------------------------------------------------

let failures = 0;
function check(name, fn) {
  try {
    fn();
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
const variantId = (product, title) => product.variants.find((v) => v.title === title).id;

const SIZES = ['2XS', 'XS', 'S', 'M', 'L', 'XL', '2XL'];

console.log('variant picker regression test');
console.log(`  data-option expressions: size="${EXPRS.size}", swatch position=${EXPRS.swatch}`);

{
  // The launch-day repro: size-only product, customer picks L.
  const product = makeProduct(['Size'], [SIZES]);
  const fx = runPicker(product);
  check('size-only: seeds with the default variant', () => {
    assertEqual(fx.idInput.value, variantId(product, '2XS'), 'hidden variant id after init');
  });
  check('size-only: clicking L submits the L variant (NOT the 2XS default)', () => {
    clickValue(fx, 'L');
    assertEqual(fx.idInput.value, variantId(product, 'L'),
      'hidden variant id after clicking L — a mismatch here is the "ordered L, Printful got 2XS" bug');
  });
  check('size-only: every size reaches its own variant', () => {
    for (const s of SIZES) {
      clickValue(fx, s);
      assertEqual(fx.idInput.value, variantId(product, s), `hidden variant id after clicking ${s}`);
    }
  });
}

{
  // Future catalog shape: Color x Size.
  const product = makeProduct(['Color', 'Size'], [['Navy', 'Gold'], SIZES], {
    unavailable: ['Gold / 2XL'],
    prices: { 'Gold / L': 4900 },
  });
  const fx = runPicker(product);
  check('color x size: clicking a size keeps the selected color', () => {
    clickValue(fx, 'L');
    assertEqual(fx.idInput.value, variantId(product, 'Navy / L'), 'hidden variant id after Navy + L');
  });
  check('color x size: clicking a swatch combines with the selected size', () => {
    clickValue(fx, 'Gold');
    assertEqual(fx.idInput.value, variantId(product, 'Gold / L'), 'hidden variant id after Gold + L');
  });
  check('color x size: price and sticky bar follow the selected variant', () => {
    assertEqual(fx.byId['gk-price'].textContent, '$49.00', 'price element');
    assertEqual(fx.byId['gk-stickybar-meta'].textContent, 'Gold / L · $49.00', 'sticky bar meta');
  });
  check('color x size: unavailable combination is marked on the size button', () => {
    const btn2xl = fx.form.querySelectorAll('.gk-pdp-size').find((b) => b.dataset.value === '2XL');
    if (!btn2xl.classList.contains('is-unavailable')) {
      throw new Error('Gold / 2XL is sold out but the 2XL button is not flagged is-unavailable');
    }
  });
  check('color x size: sold-out combination disables add to cart when selected', () => {
    clickValue(fx, '2XL');
    if (!fx.form.querySelector('.gk-pdp-add').disabled) {
      throw new Error('Add to cart stayed enabled for the sold-out Gold / 2XL combination');
    }
    clickValue(fx, 'Navy');
    assertEqual(fx.idInput.value, variantId(product, 'Navy / 2XL'), 'hidden variant id after switching back to Navy + 2XL');
    if (fx.form.querySelector('.gk-pdp-add').disabled) {
      throw new Error('Add to cart still disabled after moving to the in-stock Navy / 2XL');
    }
  });
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('all checks passed');
