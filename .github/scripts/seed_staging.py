#!/usr/bin/env python3
"""Seed (or re-seed) the staging shop from the production catalog.

Copies products (copy, options, variants, prices, SKUs, media, variant-image
assignments, custom.* metafields, SEO), collections (smart rules + custom
membership), and navigation menus from the production store to the staging
store, then publishes active products and collections to staging's Online
Store channel.

Safe to re-run: products and collections are matched by handle and updated
in place; media is only uploaded when the staging product has none, so
re-runs never duplicate images. Menus are updated in place.

Prerequisites — an authed Shopify CLI session against BOTH stores:

  shopify store auth --store q0951j-fv.myshopify.com --scopes read_products,read_publications,read_online_store_navigation
  shopify store auth --store gotham-rugby-staging.myshopify.com --scopes read_products,write_products,read_publications,write_publications,read_online_store_navigation,write_online_store_navigation

(`store auth` REPLACES the scope set for that store — pass the full list.)

Usage:
  python3 .github/scripts/seed_staging.py [--source SHOP.myshopify.com] [--target SHOP.myshopify.com]

Not copied (by design): pages, blogs, theme settings (come from the git
branch), Shopify taxonomy metafields (shopify.*, store-specific metaobject
refs), and app-owned metafields (printify_custom.*, mc-facebook.*).
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile

VERSION = '2026-07'


class E(str):
    """Raw GraphQL token (enum) — rendered unquoted."""


def lit(v):
    if isinstance(v, E):
        return str(v)
    if isinstance(v, bool):
        return 'true' if v else 'false'
    if v is None:
        return 'null'
    if isinstance(v, (int, float)):
        return str(v)
    if isinstance(v, str):
        return json.dumps(v)
    if isinstance(v, list):
        return '[' + ', '.join(lit(x) for x in v) + ']'
    if isinstance(v, dict):
        return '{' + ', '.join(f'{k}: {lit(x)}' for k, x in v.items()) + '}'
    raise TypeError(f'cannot render {type(v)}')


def run(store, query, mutate=False):
    with tempfile.NamedTemporaryFile('w', suffix='.graphql', delete=False) as f:
        f.write(query)
        path = f.name
    cmd = ['shopify', 'store', 'execute', '--store', store, '--json', '--version', VERSION,
           '--query-file', path]
    if mutate:
        cmd.append('--allow-mutations')
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
    finally:
        os.unlink(path)
    txt = out.stdout
    i = txt.find('{')
    if i < 0:
        msg = (txt + out.stderr).strip()
        if 'auth' in msg.lower() or 'login' in msg.lower():
            msg += f"\n\nRun the `shopify store auth --store {store} ...` command from this script's docstring."
        raise RuntimeError(f'{store}: no JSON in CLI output:\n{msg}')
    return json.loads(txt[i:])


PRODUCTS_QUERY = '''query { products(first: 100) { nodes {
  id title handle descriptionHtml vendor productType tags status
  seo { title description }
  options { name position optionValues { name } }
  media(first: 50) { nodes { ... on MediaImage { id image { url altText } } } }
  variants(first: 100) { nodes { title price compareAtPrice sku selectedOptions { name value } image { url } } }
  metafields(first: 30) { nodes { namespace key value type } }
} } }'''

NAV_QUERY = '''query {
  collections(first: 50) { nodes { title handle descriptionHtml sortOrder
    ruleSet { appliedDisjunctively rules { column relation condition } }
    products(first: 100) { nodes { handle } } } }
  menus(first: 20) { nodes { handle title items { title type url items { title type url items { title type url } } } } }
}'''


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('--source', default='q0951j-fv.myshopify.com')
    ap.add_argument('--target', default='gotham-rugby-staging.myshopify.com')
    args = ap.parse_args()

    errors = []

    print(f'exporting catalog from {args.source} ...')
    catalog = run(args.source, PRODUCTS_QUERY)['products']['nodes']
    nav = run(args.source, NAV_QUERY)
    print(f'  {len(catalog)} products, {len(nav["collections"]["nodes"])} collections, {len(nav["menus"]["nodes"])} menus')

    pubs = run(args.target, 'query { publications(first: 10) { nodes { id name } } }')['publications']['nodes']
    online_store = next((p['id'] for p in pubs if p['name'] == 'Online Store'), None)
    if not online_store:
        sys.exit(f'no Online Store publication found on {args.target}')

    existing = run(args.target, '''query { products(first: 100) { nodes { id handle
      media(first: 50) { nodes { id } } variants(first: 100) { nodes { id } } } } }''')['products']['nodes']
    existing = {p['handle']: p for p in existing}

    # ---------------- Products (upsert by handle) ----------------
    created = {}
    for p in catalog:
        media_urls = [m['image']['url'] for m in p['media']['nodes'] if m.get('image')]
        prior = existing.get(p['handle'])
        inp = {
            'title': p['title'], 'handle': p['handle'],
            'descriptionHtml': p['descriptionHtml'] or '',
            'vendor': p['vendor'], 'productType': p['productType'],
            'tags': p['tags'], 'status': E(p['status']),
            'productOptions': [
                {'name': o['name'], 'position': o['position'],
                 'values': [{'name': ov['name']} for ov in o['optionValues']]}
                for o in p['options']],
            'variants': [],
        }
        if prior:
            inp['id'] = prior['id']
        for v in p['variants']['nodes']:
            vv = {'optionValues': [{'optionName': so['name'], 'name': so['value']} for so in v['selectedOptions']],
                  'price': v['price'], 'inventoryPolicy': E('CONTINUE')}
            if v['sku']:
                vv['sku'] = v['sku']
            if v['compareAtPrice']:
                vv['compareAtPrice'] = v['compareAtPrice']
            inp['variants'].append(vv)
        upload_media = media_urls and not (prior and prior['media']['nodes'])
        if upload_media:
            inp['files'] = [{'originalSource': u, 'contentType': E('IMAGE'),
                             'alt': (m['image'].get('altText') or '')}
                            for u, m in zip(media_urls, p['media']['nodes'])]
        if p['seo']['title'] or p['seo']['description']:
            inp['seo'] = {'title': p['seo']['title'] or '', 'description': p['seo']['description'] or ''}
        custom_mfs = [m for m in p['metafields']['nodes'] if m['namespace'] == 'custom']
        if custom_mfs:
            inp['metafields'] = [{'namespace': 'custom', 'key': m['key'], 'type': m['type'], 'value': m['value']}
                                 for m in custom_mfs]

        r = run(args.target,
                'mutation { productSet(synchronous: true, input: ' + lit(inp) + ') { '
                'product { id handle variants(first: 100) { nodes { id } } media(first: 50) { nodes { id } } } '
                'userErrors { field message } } }', mutate=True)
        ps = r.get('productSet') or {}
        if ps.get('userErrors'):
            errors.append((p['handle'], ps['userErrors']))
            print(f"ERR  {p['handle']}: {ps['userErrors']}")
            continue
        prod = ps['product']
        created[p['handle']] = {
            'id': prod['id'], 'status': p['status'], 'src': p,
            'variant_ids': [n['id'] for n in prod['variants']['nodes']],
            'media_ids': [n['id'] for n in prod['media']['nodes']],
            'media_urls': media_urls,
        }
        print(f"ok   {p['handle']} ({'updated' if prior else 'created'}, {p['status']}, {len(media_urls)} media)")

    # ------------- Variant images (prod media position -> staging media position) -------------
    for handle, info in created.items():
        p = info['src']
        updates = []
        for i, v in enumerate(p['variants']['nodes']):
            if not v.get('image') or i >= len(info['variant_ids']):
                continue
            try:
                idx = info['media_urls'].index(v['image']['url'])
            except ValueError:
                continue
            if idx < len(info['media_ids']):
                updates.append({'id': info['variant_ids'][i], 'mediaId': info['media_ids'][idx]})
        if not updates:
            continue
        r = run(args.target, 'mutation { productVariantsBulkUpdate(productId: ' + lit(info['id']) +
                ', variants: ' + lit(updates) + ') { userErrors { field message } } }', mutate=True)
        ue = (r.get('productVariantsBulkUpdate') or {}).get('userErrors')
        if ue:
            errors.append((handle + ' variant-images', ue))
            print(f"ERR  {handle} variant images: {ue}")

    # ---------------- Collections (upsert by handle) ----------------
    existing_colls = run(args.target, '''query { collections(first: 50) { nodes { id handle
      products(first: 100) { nodes { handle } } } } }''')['collections']['nodes']
    existing_colls = {c['handle']: c for c in existing_colls}
    coll_ids = {}
    for c in nav['collections']['nodes']:
        if c['handle'] == 'frontpage':
            continue
        prior = existing_colls.get(c['handle'])
        if prior:
            coll_ids[c['handle']] = prior['id']
            print(f"ok   collection {c['handle']} (exists)")
        else:
            inp = {'title': c['title'], 'handle': c['handle'], 'descriptionHtml': c['descriptionHtml'] or ''}
            if c.get('sortOrder'):
                inp['sortOrder'] = E(c['sortOrder'])
            if c['ruleSet']:
                inp['ruleSet'] = {
                    'appliedDisjunctively': c['ruleSet']['appliedDisjunctively'],
                    'rules': [{'column': E(r_['column']), 'relation': E(r_['relation']), 'condition': r_['condition']}
                              for r_ in c['ruleSet']['rules']]}
            r = run(args.target, 'mutation { collectionCreate(input: ' + lit(inp) +
                    ') { collection { id } userErrors { field message } } }', mutate=True)
            cc = r.get('collectionCreate') or {}
            if cc.get('userErrors'):
                errors.append((c['handle'], cc['userErrors']))
                print(f"ERR  collection {c['handle']}: {cc['userErrors']}")
                continue
            coll_ids[c['handle']] = cc['collection']['id']
            print(f"ok   collection {c['handle']} (created)")
        if not c['ruleSet']:
            have = {n['handle'] for n in prior['products']['nodes']} if prior else set()
            pids = [created[n['handle']]['id'] for n in c['products']['nodes']
                    if n['handle'] in created and n['handle'] not in have]
            if pids:
                r = run(args.target, 'mutation { collectionAddProducts(id: ' + lit(coll_ids[c['handle']]) +
                        ', productIds: ' + lit(pids) + ') { userErrors { field message } } }', mutate=True)
                ue = (r.get('collectionAddProducts') or {}).get('userErrors')
                if ue:
                    errors.append((c['handle'] + ' add-products', ue))
                else:
                    print(f"     added {len(pids)} products")

    # ---------------- Publish actives + collections ----------------
    to_publish = [i['id'] for i in created.values() if i['status'] == 'ACTIVE'] + list(coll_ids.values())
    for gid in to_publish:
        r = run(args.target, 'mutation { publishablePublish(id: ' + lit(gid) +
                ', input: [{publicationId: ' + lit(online_store) + '}]) { userErrors { field message } } }',
                mutate=True)
        ue = (r.get('publishablePublish') or {}).get('userErrors')
        if ue:
            errors.append((gid, ue))
    print(f'published {len(to_publish)} items to Online Store')

    # ---------------- Menus (update in place, create if missing) ----------------
    def menu_items(items):
        out = []
        for it in items:
            t, url = it['type'], it['url']
            entry = {'title': it['title']}
            handle = (url or '').rstrip('/').split('/')[-1]
            if t == 'COLLECTION' and handle in coll_ids:
                entry['type'] = E('COLLECTION')
                entry['resourceId'] = coll_ids[handle]
            elif t == 'PRODUCT' and handle in created:
                entry['type'] = E('PRODUCT')
                entry['resourceId'] = created[handle]['id']
            elif t in ('FRONTPAGE', 'CATALOG', 'SEARCH', 'SHOP_POLICY'):
                entry['type'] = E(t)
            else:  # PAGE/BLOG/HTTP or unmapped resource: keep the link, lose the binding
                entry['type'] = E('HTTP')
                entry['url'] = url
            kids = it.get('items') or []
            if kids:
                entry['items'] = menu_items(kids)
            out.append(entry)
        return out

    staging_menus = run(args.target, 'query { menus(first: 20) { nodes { id handle } } }')['menus']['nodes']
    staging_menu_ids = {m['handle']: m['id'] for m in staging_menus}
    for m in nav['menus']['nodes']:
        if m['handle'] == 'customer-account-main-menu':
            continue
        items = menu_items(m['items'])
        if m['handle'] in staging_menu_ids:
            q = ('mutation { menuUpdate(id: ' + lit(staging_menu_ids[m['handle']]) + ', title: ' + lit(m['title']) +
                 ', items: ' + lit(items) + ') { userErrors { field message } } }')
            key = 'menuUpdate'
        else:
            q = ('mutation { menuCreate(title: ' + lit(m['title']) + ', handle: ' + lit(m['handle']) +
                 ', items: ' + lit(items) + ') { userErrors { field message } } }')
            key = 'menuCreate'
        r = run(args.target, q, mutate=True)
        ue = (r.get(key) or {}).get('userErrors')
        if ue:
            errors.append((f"menu {m['handle']}", ue))
            print(f"ERR  menu {m['handle']}: {ue}")
        else:
            print(f"ok   menu {m['handle']} ({key})")

    # ---------------- Drift report + summary ----------------
    orphans = set(existing) - {p['handle'] for p in catalog}
    if orphans:
        print(f"note: on {args.target} but not in prod (left untouched): {', '.join(sorted(orphans))}")
    print('\n=== SUMMARY ===')
    print(f'products upserted: {len(created)}/{len(catalog)}')
    print(f'collections: {len(coll_ids)}')
    print(f'errors: {len(errors)}')
    for name, ue in errors:
        print(f'  {name}: {ue}')
    sys.exit(1 if errors else 0)


if __name__ == '__main__':
    main()
