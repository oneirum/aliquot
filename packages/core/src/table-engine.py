# data_query's engine. Runs inside the sandbox container (no network, read-only root, uid 65534) with the table at
# /in/table.csv and the query at /in/query.json. Prints one JSON object: the aggregate, or a refusal code. It never
# prints a row, a cell of a restricted column, or the size of a cell under the minimum. Standard library only, so the
# same image and the same input give the same bytes.

import csv
import json
import math
import statistics
import sys


def emit(obj):
    sys.stdout.write(json.dumps(obj, sort_keys=True, separators=(",", ":"), allow_nan=False))
    sys.exit(0)


def refuse(code, column=None):
    obj = {"ok": False, "refusal": code}
    if column is not None:
        obj["column"] = column
    emit(obj)


with open("/in/query.json", encoding="utf-8") as f:
    envelope = json.load(f)
query = envelope["query"]
free = set(envelope["free"])
min_cell = envelope["minCell"]
max_groups = envelope["maxGroups"]
where = query.get("where", [])
group_by = query.get("groupBy", [])
measures = query["measures"]

with open("/in/table.csv", newline="", encoding="utf-8-sig") as f:
    reader = csv.DictReader(f)
    header = set(reader.fieldnames or [])
    rows = list(reader)

# A REDCap user in a Data Access Group sees only its records, so every other row is dropped before anything is counted.
scope = envelope.get("scope")
if scope is not None:
    if scope["column"] not in header:
        refuse("missing-scope")
    rows = [r for r in rows if (r.get(scope["column"]) or "") == scope["value"]]

for column in [w["column"] for w in where] + group_by + [m["column"] for m in measures if m.get("column") is not None]:
    if column not in free:
        refuse("restricted-column", column)
    if column not in header:
        refuse("missing-column", column)


def number(text):
    try:
        x = float(text)
    except ValueError:
        return None
    return x if math.isfinite(x) else None


def equals(cell, target):
    if isinstance(target, str):
        return cell == target
    x = number(cell)
    return x is not None and x == target


def matches(row, w):
    cell = (row.get(w["column"]) or "").strip()
    op = w["op"]
    if op == "present":
        return cell != ""
    if op == "absent":
        return cell == ""
    if op == "eq":
        return equals(cell, w["value"])
    if op == "ne":
        return not equals(cell, w["value"])
    if op == "in":
        return any(equals(cell, t) for t in w["value"])
    x = number(cell)
    if x is None:
        return False
    t = w["value"]
    return {"lt": x < t, "le": x <= t, "gt": x > t, "ge": x >= t}[op]


groups = {}
matched = 0
for row in rows:
    if all(matches(row, w) for w in where):
        matched += 1
        key = tuple((row.get(c) or "").strip() for c in group_by)
        groups.setdefault(key, []).append(row)
        if len(groups) > max_groups:
            refuse("too-many-groups")

if not group_by and not groups:
    groups[()] = []


def small(n):
    return 0 < n < min_cell


out = []
for key in sorted(groups):
    members = groups[key]
    if small(len(members)):
        refuse("cell-size")
    values = {}
    for m in measures:
        fn = m["fn"]
        column = m.get("column")
        name = fn + "(" + (column or "*") + ")"
        if fn == "count":
            n = len(members) if column is None else sum(1 for r in members if (r.get(column) or "").strip() != "")
            if small(n):
                refuse("cell-size")
            values[name] = n
            continue
        xs = []
        for r in members:
            cell = (r.get(column) or "").strip()
            if cell == "":
                continue
            x = number(cell)
            if x is None:
                refuse("not-numeric", column)
            xs.append(x)
        if small(len(xs)):
            refuse("cell-size")
        if not xs:
            values[name] = None
        elif fn == "sum":
            values[name] = round(math.fsum(xs), 6)
        elif fn == "mean":
            values[name] = round(math.fsum(xs) / len(xs), 6)
        else:
            values[name] = round(statistics.stdev(xs), 6) if len(xs) > 1 else None
    out.append({"key": dict(zip(group_by, key)), "n": len(members), "values": values})

emit({"ok": True, "rowsRead": len(rows), "rowsMatched": matched, "groups": out})
