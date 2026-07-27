---
name: product-prep
description: Pre-publish checklist for store products — copy voice, SEO, images, size charts, publication. Use before setting a product ACTIVE, after major edits to a live product, or to audit the whole catalog.
---

# Product prep — Gotham Knights Shop

Every product that goes ACTIVE ships supplier boilerplate unless someone rewrites it.
This skill is the gate: run it on a product before publishing, or in audit mode across
the catalog.

## Fetch the product

```sh
shopify store execute --store q0951j-fv.myshopify.com --json --version 2026-07 -q '
query { productByHandle(handle: "HANDLE") {
  id title handle status vendor productType tags descriptionHtml
  seo { title description }
  featuredImage { id }
  hasOnlyDefaultVariant
  options { name }
  variants(first: 30) { nodes { title price sku image { id } } }
  sizeChart: metafield(namespace: "custom", key: "size_chart") { value }
} }' | sed -n '/^{/,$p'
```

Notes: API version rolls forward — if rejected, use a recent one from the error's
allowed list. Output has leading CLI log lines; always slice from the first `{`.
Mutations need `--allow-mutations`; big documents go via `--query-file`.

## Checklist

### 1. Copy — rewrite the supplier blurb
Reference products for voice and structure: `gotham-hawaiian-shirt`,
`gotham-camelbak-thrive-water-bottle`. The shape:

- **Opening paragraph**: club voice — what it is and where it lives in club life
  (training nights, touchline, clubhouse afters, the third half). Name brand-name
  goods explicitly (e.g. "a genuine CamelBak® Thrive").
- **Second paragraph**: how it works/feels; the one or two specs that matter.
- **`<strong>Details</strong>` list**: real specs (materials, capacity, dimensions),
  ending with "Printed to order — ships in 3–5 business days" when fulfilled on demand.
- **`<strong>Good to know</strong>` list**: honest care notes and caveats
  (hand-wash printed drinkware, print show-through, fabric softens after wash).

Never ship these supplier tells: "Blank product sourced from …", "Stay hydrated in
style", any sentence that could describe a competitor's product unchanged.

### 2. Title & handle
Title pattern: "Gotham Knights <Brand> <Product>" (brand included when it's a real
brand). Handle should match the title's key words. If renaming a product that has
ever been shared or ACTIVE, create a redirect in the same mutation:
`urlRedirectCreate(urlRedirect: {path: "/products/OLD", target: "/products/NEW"})`.

### 3. SEO
`seo.title` ≤ 60 chars; `seo.description` ≤ 160 chars and should work in
"NYC's inclusive rugby club" — it's the differentiator in generic search results.
Both are empty on new products; empty means Shopify falls back to raw title/description.

### 4. Tags
Category + brand tags (e.g. `drinkware, CamelBak`). Special tags drive PDP badges:
`new`, `limited`, `best-seller`. No tags = invisible to tag-based collections.

### 5. Images
- Featured image required.
- Products with a Color option: assign each variant its image in the admin — the
  PDP gallery swaps to the selected variant's image automatically.

### 6. Size chart (wearables only)
Wearables with a Size option need the `custom.size_chart` metafield
(multi-line HTML, drives the PDP "Size guide" modal; falls back to the theme's
generic setting otherwise). NOT needed for non-apparel that happens to have a
Size option — mugs (11oz/15oz), flags, posters. Judge by "does a human wear it".

### 7. Publish — status is not enough
Setting `status: ACTIVE` does NOT put the product on the storefront. It must also be
published to the Online Store sales channel or its URL 404s:
`publishablePublish(id: PRODUCT_GID, input: [{publicationId: "gid://shopify/Publication/281615466809"}])`
(needs write_publications scope). `onlineStoreUrl` is null without read_publications,
so verify on the storefront, not via that field.

### 8. Verify on the storefront
Password `gotham2025`. The CDN can serve stale HTML for up to ~45 minutes after
theme or content changes — don't diagnose "it didn't apply" until that window has
passed; `shopify theme pull` / the Admin API are the authoritative checks.

## Catalog-wide audit mode

Fetch all products (`products(first: 50)` with the fields above) into a JSON file,
then flag per product:

- `SUPPLIER-BLURB`: description contains "sourced from China" / "Blank product" /
  generic supplier openers
- `no-SEO`: both seo.title and seo.description empty
- `no-tags`, `no-image` (no featuredImage)
- `no-variant-images`: has variants but zero variant images (only meaningful for
  Color-variant products)
- `no-size-chart`: Size option + no custom.size_chart metafield — but apply the
  wearables-only rule from step 6 before reporting
- `thin-description`: descriptionHtml under ~120 chars

Report ACTIVE products first (customer-facing now), DRAFT products second
(pre-publish queue). Propose rewrites; apply via `productUpdate` only after the
user approves the copy direction.
