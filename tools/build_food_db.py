#!/usr/bin/env python3
"""Filtert den Open-Food-Facts-CSV-Dump (stdin, entpackt) auf Produkte aus DE/AT/CH
und schreibt eine kompakte, gzip-komprimierte TSV-Datei für die Web-App.

Aufruf:
  curl -sL https://static.openfoodfacts.org/data/en.openfoodfacts.org.products.csv.gz \
    | gunzip | python3 tools/build_food_db.py data/foods.tsv.gz
"""
import gzip, sys

COUNTRIES = {"en:germany", "en:austria", "en:switzerland"}
NUM = ["energy-kcal_100g", "proteins_100g", "carbohydrates_100g", "sugars_100g",
       "fat_100g", "saturated-fat_100g", "fiber_100g", "salt_100g"]

def num(s):
    if not s:
        return None
    try:
        v = float(s)
    except ValueError:
        return None
    return v if v == v else None  # NaN raus

def fmt(v):
    if v is None:
        return ""
    r = round(v, 1)
    return str(int(r)) if r == int(r) else str(r)

def clean(s):
    return " ".join(s.replace("\\n", " ").split())[:120]

def main(out_path):
    inp = sys.stdin.buffer
    header = inp.readline().decode("utf-8").rstrip("\n").split("\t")
    ix = {name: i for i, name in enumerate(header)}
    need = ["code", "product_name", "brands", "countries_tags", "serving_quantity",
            "quantity", "unique_scans_n", "energy-kj_100g"] + NUM
    for n in need:
        if n not in ix:
            sys.exit(f"Spalte fehlt: {n}")
    width = max(ix[n] for n in need)
    rows, seen, total = [], set(), 0
    for raw in inp:
        total += 1
        f = raw.decode("utf-8", "replace").rstrip("\n").split("\t")
        if len(f) <= width:
            continue
        tags = f[ix["countries_tags"]]
        if not any(c in tags for c in COUNTRIES):
            continue
        code = f[ix["code"]].strip()
        if not code.isdigit() or not (8 <= len(code) <= 14):
            continue
        name = clean(f[ix["product_name"]])
        if not name:
            continue
        vals = [num(f[ix[n]]) for n in NUM]
        kcal = vals[0]
        if kcal is None:
            kj = num(f[ix["energy-kj_100g"]])
            kcal = kj / 4.184 if kj is not None else None
            vals[0] = kcal
        if kcal is None or not (0 <= kcal <= 950):
            continue
        if any(v is not None and not (0 <= v <= 100) for v in vals[1:]):
            continue
        if vals[1] is None or vals[2] is None or vals[4] is None:
            continue  # Makros müssen vorhanden sein
        code = code.lstrip("0").zfill(13) if len(code) > 8 else code
        if code in seen:
            continue
        seen.add(code)
        brand = clean(f[ix["brands"]].split(",")[0])
        sq = num(f[ix["serving_quantity"]])
        sq = sq if sq and 0 < sq <= 2000 else None
        scans = int(num(f[ix["unique_scans_n"]]) or 0)
        rows.append((scans, [code, name, brand] + [fmt(v) for v in vals]
                     + [fmt(sq), clean(f[ix["quantity"]])[:30]]))
    rows.sort(key=lambda r: -r[0])
    with gzip.open(out_path, "wt", encoding="utf-8", compresslevel=9) as out:
        out.write("v1\t" + str(len(rows)) + "\n")
        for _, r in rows:
            out.write("\t".join(x.replace("\t", " ") for x in r) + "\n")
    print(f"{total} Produkte gelesen, {len(rows)} übernommen -> {out_path}", file=sys.stderr)

if __name__ == "__main__":
    main(sys.argv[1])
