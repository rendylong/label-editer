#!/usr/bin/env python3
"""query_labels.py — 贴标知识查询 (stdlib-only). Reads data/kb/labels.jsonl.
  query_labels.py --category CAT --tier T --layout L --typo C --print P --script S
  --format json|table --check --stats
Portable: resolves data/kb under this package, else cosmetics_assets/kb."""
import argparse, json, os, re, sys, unicodedata
from collections import Counter

_BASE = os.path.abspath(__file__)
_PKG = os.path.join(os.path.dirname(_BASE), "..")  # <skill>/scripts -> <skill>
_DATA_DIR = os.path.join(_PKG, "data", "kb")
if not os.path.exists(_DATA_DIR):
    _DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(_BASE)), "kb")  # cosmetics_assets/kb
SRC = os.path.join(_DATA_DIR, "labels.jsonl")

def slug(s):
    s = unicodedata.normalize("NFKD", s or "").encode("ascii","ignore").decode()
    return re.sub(r"[^a-z0-9]+","", s.lower())

def load():
    if not os.path.exists(SRC):
        print(json.dumps({"error":"labels_not_built","hint":"run tools/merge_labels.py"})); sys.exit(2)
    return [json.loads(l) for l in open(SRC)]

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--category", action="append", default=[])
    ap.add_argument("--tier"); ap.add_argument("--layout"); ap.add_argument("--typo")
    ap.add_argument("--print"); ap.add_argument("--script"); ap.add_argument("--brand")
    ap.add_argument("--format", choices=["json","table"], default="json")
    ap.add_argument("--check", action="store_true"); ap.add_argument("--stats", action="store_true")
    args=ap.parse_args()
    rows=load()
    if args.check:
        ext=[r for r in rows if r["label_status"]=="extracted"]
        stamped=all(r.get("_meta",{}).get("prompt_version") for r in ext)
        print(json.dumps({"records":len(rows),"extracted":len(ext),"stamped":stamped})); sys.exit(0 if stamped else 2)
    if args.stats:
        from collections import Counter as C
        print(json.dumps({"records":len(rows),"extracted":sum(1 for r in rows if r["label_status"]=="extracted"),
          "tiers":dict(C(r["tier"] for r in rows if r["label_status"]=="extracted")),
          "cats":dict(C(r["category"] for r in rows if r["label_status"]=="extracted"))}, ensure_ascii=False, indent=1)); return
    def m(r):
        if r["label_status"]!="extracted": return False
        L=r.get("label",{})
        if args.category and r["category"] not in args.category: return False
        if args.tier and r["tier"]!=args.tier: return False
        if args.brand and slug(args.brand) not in slug(r["brand"]): return False
        if args.layout and L.get("layout_pattern")!=args.layout: return False
        if args.typo and L.get("typography_class")!=args.typo: return False
        if args.script and L.get("brand_script")!=args.script: return False
        if args.print and args.print not in (L.get("print_method") or []): return False
        return True
    hits=[r for r in rows if m(r)]
    if args.format=="table":
        for r in hits[:40]:
            L=r.get("label",{})
            print(f"{r['key']:52s} {r['brand'][:16]:16s} {r['tier']:9s} lay={L.get('layout_pattern','-'):18s} typo={L.get('typography_class','-'):16s} print={','.join((L.get('print_method') or [])[:2])}")
        print(f"-- {len(hits)} records --")
    else:
        print(json.dumps(hits, ensure_ascii=False, indent=1))
    sys.exit(0 if hits else 1)

if __name__=="__main__":
    main()
