"""Generate strict zod schemas for every dataset collection, inferred from the data itself.

Rules (so nothing loosely typed gets in):
- every object is .strict(): an unknown key is a validation error
- a key absent from some rows is .optional(); a key whose value can be null is .nullable(); both only when the data shows both
- strings become z.enum when every value is a code (UPPER_SNAKE, lower_snake, dotted.code, ISO codes) and there are <= 80 distinct values;
  documented states missing from this packet are added from EXTRA (each cited to dataset/SCHEMA.md or README.md)
- timestamps -> IsoDateTime, dates -> IsoDate, ids -> Id (lowercase slug; referential integrity is checked by the builder, not here)
- payloads whose shape depends on a discriminator (operational_events.changes by command, agent_proposals payloads by command)
  become a z.discriminatedUnion on that discriminator, one exact shape per value
Usage: gen_records.py <dataset dir> <out.ts>
"""
import json, os, re, sys, collections
D, OUT = sys.argv[1], sys.argv[2]
ISO = re.compile(r'^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?(Z|[+-]\d\d:\d\d)$')
DATE = re.compile(r'^\d{4}-\d\d-\d\d$')
CODE = re.compile(r'^([A-Z][A-Z0-9_]*|[a-z][a-z0-9_]*(\.[a-z0-9_]+)*|[A-Z]{2,3})$')
IDV = re.compile(r'^[a-z][a-z0-9]*(-[a-z0-9]+)+$')
ZONE = re.compile(r'^[A-Z][a-z]+/[A-Za-z_]+$')
HOURS = re.compile(r'^\d\d:\d\d-\d\d:\d\d$')
DISC = {"operational_events": ("command", ["changes"]),
        "agent_proposals": ("command", ["proposed_payload", "review.final_payload"])}
# Documented states with no row in this packet. Source: dataset/SCHEMA.md and dataset/README.md.
EXTRA = {
  "alerts.status": ["DISMISSED"],                                   # SCHEMA: DISMISSED means its triggering source was invalid or stale
  "proofs.status": ["WAIVED"],                                      # SCHEMA: A WAIVED requirement has its own authority and scope
  "work_items.status": ["NEEDS_EXTERNAL_INPUT", "DONE"],            # SCHEMA: OPEN and NEEDS_EXTERNAL_INPUT remain unfinished; A DONE item has a closed_at
  "internal_notifications.activity": ["SOURCE_RESOLVED"],           # SCHEMA: SOURCE_RESOLVED a change on the underlying alert
  "internal_notifications.delivery_state": ["SUPPRESSED", "FAILED"],# README: Suppressed or failed deliveries can occur in the generator
  "market_offer_exposures.status": ["SHOWN", "NOTIFIED", "VIEWED", "REJECTED", "EXPIRED", "ACCEPTED"],  # SCHEMA: exposure outcomes
  "expenses.status": ["SUBMITTED", "APPROVED", "REJECTED", "SUPERSEDED"],
  "expenses.receipt_state": ["ATTACHED_SAMPLED", "ATTACHED_NOT_SAMPLED", "MISSING"],
  "documents.medium": ["DIGITAL", "PAPER"],
  "documents.signature_scope": ["NONE", "COLLECTION_ONLY", "SELLER_ONLY", "BOTH"],
  "orders.status": ["NEW", "WAITING_FOR_PICKUP", "IN_TRANSIT", "DELIVERED"],
}
def kind(v):
    if v is None: return "null"
    if isinstance(v, bool): return "bool"
    if isinstance(v, int): return "int"
    if isinstance(v, float): return "num"
    if isinstance(v, str): return "str"
    if isinstance(v, list): return "list"
    return "obj"
used_extra = set()
def infer(vals, path):
    """vals: every value observed at this path (absent keys excluded). Returns a TS zod expression."""
    ks = collections.Counter(kind(v) for v in vals)
    nullable = "null" in ks
    ks.pop("null", None)
    if not ks:
        return "z.null()"
    if set(ks) <= {"int", "num"}:
        e = "z.number().int()" if set(ks) == {"int"} else "z.number()"
    elif len(ks) > 1:
        raise SystemExit(f"mixed types at {path}: {dict(ks)} - refusing to emit a loose union")
    else:
        k = next(iter(ks)); nn = [v for v in vals if v is not None]
        if k == "bool": e = "z.boolean()"
        elif k == "str": e = string_expr(nn, path)
        elif k == "obj": e = obj_expr(nn, path)
        elif k == "list":
            items = [x for v in nn for x in v]
            e = f"z.array({infer(items, path + '[]') if items else 'z.never()'})"
    return e + (".nullable()" if nullable else "")
def string_expr(vals, path):
    s = set(vals); leaf = path.split(".")[-1].replace("[]", "")
    extra = EXTRA.get(path, [])
    if extra: used_extra.add(path)
    if all(ISO.match(v) for v in s): return "IsoDateTime"
    if all(DATE.match(v) for v in s): return "IsoDate"
    if leaf.endswith("timezone") or leaf == "zone":
        if all(ZONE.match(v) for v in s): return "IanaZone"
    if all(HOURS.match(v) for v in s): return "HoursRange"
    is_idish = leaf == "id" or leaf.endswith("_id") or leaf.endswith("_ids") or path.endswith("_refs[].id") or path.endswith("refs[].id")
    if is_idish and all(IDV.match(v) for v in s): return "Id"
    if (all(CODE.match(v) for v in s) and len(s | set(extra)) <= 80 and not is_idish) or extra:
        allv = sorted(s | set(extra))
        return "z.enum([" + ", ".join(json.dumps(v) for v in allv) + "])"
    return "Text"
def obj_expr(objs, path):
    keys = []
    for o in objs:
        for k in o:
            if k not in keys: keys.append(k)
    n = len(objs); fields = []
    for k in keys:
        present = [o[k] for o in objs if k in o]
        e = infer(present, f"{path}.{k}" if path else k)
        if len(present) < n: e += ".optional()"
        fields.append(f"  {json.dumps(k) if not re.match(r'^[A-Za-z_][A-Za-z0-9_]*$', k) else k}: {e},")
    body = "\n".join(fields).replace("\n", "\n  ")
    return "z.object({\n  " + body + "\n}).strict()"
def pascal(s): return "".join(p.capitalize() for p in re.split(r"[_\W]+", s) if p)
out = ['// GENERATED by tools/gen_records.py from data/dataset - do not edit by hand. Re-run `npm run gen`.',
       'import { z } from "zod"',
       'import { HoursRange, IanaZone, Id, IsoDate, IsoDateTime, Text } from "./primitives"', '']
names = []
for f in sorted(x for x in os.listdir(D) if x.endswith(".jsonl")):
    coll = f[:-6]; rows = [json.loads(l) for l in open(os.path.join(D, f)) if l.strip()]
    name = pascal(coll) + "Record"; names.append((coll, name))
    if coll in DISC:
        key, subpaths = DISC[coll]
        def strip(r):
            r = json.loads(json.dumps(r))
            for sp in subpaths:
                parts = sp.split("."); o = r
                for p in parts[:-1]: o = o.get(p) if isinstance(o, dict) else None
                if isinstance(o, dict) and parts[-1] in o: o[parts[-1]] = "__DISC__"
            return r
        base = infer([strip(r) for r in rows], coll)  # shared shape, placeholders where the payloads go
        groups = collections.defaultdict(list)
        for r in rows: groups[r[key]].append(r)
        variants = []
        for val, grp in sorted(groups.items()):
            v = base.replace('"__DISC__"', "X")  # not used; we rebuild per group below
            # infer each payload per discriminator value
            subs = {}
            for sp in subpaths:
                parts = sp.split("."); vals = []
                for r in grp:
                    o = r
                    for p in parts[:-1]: o = o.get(p) if isinstance(o, dict) else None
                    if isinstance(o, dict) and parts[-1] in o: vals.append(o[parts[-1]])
                subs[sp] = infer(vals, f"{coll}.{sp}") if vals else "z.never()"
            variants.append((val, subs))
        # emit: base object with the payload keys swapped per variant
        out.append(f"const {name}Base = {base}")
        out.append("")
        vnames = []
        for val, subs in variants:
            vn = f"{name}_{pascal(val)}"; vnames.append(vn)
            ext = [f"  {key}: z.literal({json.dumps(val)}),"]
            for sp, e in subs.items():
                if "." not in sp:
                    ext.append(f"  {sp}: {e},")
                else:
                    a, b = sp.split(".")
                    ext.append(f"  {a}: {name}Base.shape.{a}.unwrap().extend({{ {b}: {e} }}).nullable(),")
            out.append(f"const {vn} = {name}Base.extend({{\n" + "\n".join(ext) + "\n})")
        out.append(f"export const {name} = z.discriminatedUnion({json.dumps(key)}, [{', '.join(vnames)}])")
    else:
        out.append(f"export const {name} = {infer(rows, coll)}")
    out.append(f"export type {name} = z.infer<typeof {name}>")
    out.append("")
out.append("/** Every collection, keyed by its file name. */")
out.append("export const RECORDS = {\n" + "\n".join(f"  {c}: {n}," for c, n in names) + "\n} as const")
out.append("export type CollectionName = keyof typeof RECORDS")
open(OUT, "w").write("\n".join(out) + "\n")
missing = set(EXTRA) - used_extra
print(f"wrote {OUT}: {len(names)} collections; EXTRA paths not found in data: {sorted(missing) or 'none'}")
