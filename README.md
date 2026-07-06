<h1 align="center">Gotham</h1>

<p align="center">The storefront theme for <strong>Gotham Knights RFC</strong> — New York City's inclusive rugby club.<br>Built for the pitch, made for the city.</p>

<p align="center">
  <a href="./LICENSE.md"><img src="https://img.shields.io/badge/License-MIT-green.svg" alt="License"></a>
  <img alt="Theme version" src="https://img.shields.io/badge/theme-Gotham%201.0.0-0d1d41">
</p>

A custom Shopify theme for [shop.gotham.rugby](https://shop.gotham.rugby). It began life on Shopify's Skeleton theme and has been rebuilt into the Gotham Knights storefront: a shared design system, a custom hero, collection tiles, cart drawer, PDP, search, and footer — all `gk-*` sections.

## Getting started

### Prerequisites

- [Shopify CLI](https://shopify.dev/docs/api/shopify-cli) — download, preview, and push themes.
- [Shopify Liquid VS Code extension](https://shopify.dev/docs/storefronts/themes/tools/shopify-liquid-vscode) (optional) — Liquid syntax, linting, and completion.

### Preview

```bash
shopify theme dev --store=q0951j-fv.myshopify.com
```

Then open the local preview (default `http://127.0.0.1:9292`). The storefront token expires roughly every 24h — restart the command if you see an access-token error.

### Checks

```bash
shopify theme check
```

Pull requests also run Theme Check, a JSON validator, and Lighthouse CI. Keep Theme Check at **0 errors** (a handful of benign warnings are the baseline).

## Theme architecture

- **`assets/gotham-ds.css.liquid`** — the design system (tokens, type, buttons, cards, tiles, shared components). Start here for styling.
- **`assets/critical.css`** — critical CSS loaded on every page (reset, section grid, base layout).
- **`sections/gk-*.liquid`** — the storefront sections (hero, collection list, mission, featured products, community, email signup, cart drawer, header, footer, product, search).
- **`sections/*-group.json`** — section groups (`header-group`, `footer-group`) wiring sections into the layout.
- **`templates/*.json`** — page templates (JSON) that compose sections.

Footer navigation is driven by a single nested Shopify menu (Online Store → Navigation → **Footer**): top-level items become columns, nested items become links.

## Contributing

Branch off `main`, open a PR, and let CI go green before merging. Merges to `main` deploy to the connected theme via Shopify's GitHub integration.

> Note: section/template **settings** (the JSON in `templates/*.json` and `sections/*-group.json`) are also editable in the theme customizer, which is the source of truth for the live theme. A change to those files in Git may not override an editor-set value on the published theme — set it in the customizer if a deployed setting doesn't take.

## License

Open-sourced under the [MIT](./LICENSE.md) License. Originally derived from the [Shopify Skeleton Theme](https://github.com/Shopify/skeleton-theme).
