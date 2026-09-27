#!/usr/bin/env python3
"""Seed a DEMO store through the plugin's own API, for the public screenshots.

WHY A DEMO STORE AT ALL. The planner renders its operator's real venture register
— revenue, kill-switches, kill criteria — and a leak scan cannot see any of that,
because it is not a term. Committing that screenshot to a public repository would
publish a financial strategy. So the README's image is rendered from sample data,
and this is the script that makes that sample data reproducible instead of merely
asserted.

WHY THROUGH `/mutate` RATHER THAN BY WRITING JSON. The API runs every record
through the domain schema, so a demo store cannot contain a field the plugin would
drop on read. A store hand-written to the schema's older shape reopens missing
data and looks perfect in a file listing.

WHY EVERY DATE IS RELATIVE TO TODAY. The first version hardcoded its dates, so the
sample page was only correct on the day it was written: a reader a month later
would seed a planner whose "today" column is empty and whose check-ins are weeks
old. Everything here is derived from the host clock in the instance's own zone, so
the demo renders the same whenever it is run.

THE GUARDS EXIST BECAUSE THIS SCRIPT WRITES FAKE DATA. Pointed at a real instance
it would inject three invented projects and two invented plugins into the
operator's actual register — the one thing this repository's gate is built to
protect. Three checks, in order of how cheaply they catch that:

  1. PORT must be given explicitly. No default, so the target is always named.
  2. The reserved ports are refused (3080 is a default DSH server, 3099 is this
     machine's durable planner).
  3. The target's existing projects and plugins must be ones THIS script defines.
     Anything else means the store holds somebody's real work — and a store that
     already holds the demo set is refused too, because seeding it twice would
     double the check-ins and quietly change the picture.

    PORT=3098 python3 scripts/seed-demo-store.py
    PORT=3098 python3 scripts/seed-demo-store.py --force    # overrides 2, 3 and 4
"""

import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

FORCE = "--force" in sys.argv

# Named and refused rather than discovered: a default DSH server and this
# machine's durable planner. A reader's own ports differ, which is why the
# content check below exists as well.
RESERVED_PORTS = {"3080", "3099"}

TZ = os.environ.get("TZ_LABEL", "Africa/Nairobi")


def days_ago(n: int) -> str:
    """The date `n` days before the instance's today, as YYYY-MM-DD."""
    return (datetime.now(ZoneInfo(TZ)) - timedelta(days=n)).date().isoformat()


def today() -> str:
    return os.environ.get("TODAY") or datetime.now(ZoneInfo(TZ)).date().isoformat()


LIVE = "Trip split app"
WORKING = "Newsletter digester"
PENDING = "Recipe box"


def steps(today_iso: str) -> list[tuple[str, dict]]:
    """Every mutation, dated off `today_iso` so the page renders the same any day."""
    return [
        # ---- the board: one of each state a reader should see ---------------
        ("addProject", {
            "name": LIVE,
            "fulfills": "Splits group holiday costs without a spreadsheet: everyone photographs the receipt, nobody argues in December.",
            "summary": "Shipped. Two check-ins logged, churn is the open problem.",
            "ttfdDays": 14, "effortDays": 6, "revenuePerMonth": 400, "currency": "USD",
            "confidence": 0.5, "status": "shipped", "metricName": "active groups",
            "killSwitch": "first 20 paying groups by day 45",
        }),
        ("addProject", {
            "name": WORKING,
            "fulfills": "Turns a folder of newsletters into one five-minute morning read.",
            "summary": "Ranked second: less revenue, but a third of the build.",
            "ttfdDays": 21, "effortDays": 4, "revenuePerMonth": 250, "currency": "USD",
            "confidence": 0.4, "status": "active",
            "killSwitch": "first paid subscriber by day 40",
        }),
        ("addProject", {
            "name": PENDING,
            "fulfills": "Keeps a household's recipes in one place, offline first.",
            "summary": "Parked while the two above are in flight. Estimated, so it keeps its rank.",
            "ttfdDays": 30, "effortDays": 3, "revenuePerMonth": 120, "currency": "USD",
            "confidence": 0.3, "status": "idea",
            "killSwitch": "100 installs by day 60",
        }),
        # ---- the feedback loop: two check-ins, so a delta and a period show --
        ("logCheckin", {
            "project": LIVE, "date": days_ago(14), "revenue": 120, "metric": 9,
            "customers": 7, "verdict": "continue",
            "progress": "Group invites shipped; first ten groups onboarded by hand.",
            "hurdles": ["Churn spikes after the free trial ends"],
            "corrections": ["Tighten the day-7 onboarding email"],
        }),
        ("logCheckin", {
            "project": LIVE, "date": days_ago(2), "revenue": 180, "metric": 14,
            "customers": 11, "verdict": "fix",
            "progress": "Onboarding email rewritten; trial-to-paid up from 22% to 30%.",
            "hurdles": ["Churn spikes after the free trial ends"],
            "sparks": ["Charge separately for merging two trips after the fact"],
        }),
        # ---- the day: a filled banner, a partly-done list, a plan for tomorrow
        ("addItem", {"target": "today", "text": "Rewrite the trial reminder email",
                     "summary": "Directly addresses the open hurdle.", "project": LIVE}),
        ("addItem", {"target": "today", "text": "Reply to the two support threads",
                     "summary": "Both are the same bug in the split totals.", "project": LIVE}),
        ("addItem", {"target": "tomorrow", "text": "Price the newsletter tier",
                     "summary": "Needs three competitor prices before deciding.", "project": WORKING}),
        # ---- a candidate waiting in the backlog, and one carried from before --
        ("addBacklogItem", {"project": WORKING, "text": "Add a weekly digest layout",
                            "summary": "Cheap, and it is what the paid tier would sell."}),
        ("addBacklogItem", {"project": LIVE, "text": "Fix the rounding on odd splits",
                            "summary": "The support threads are this."}),
        # The matcher is `match`, never `task`: `task` means the new task TEXT
        # elsewhere in this API, and passing it here is refused with
        # "backlogItemId or match required" — which is what the first run of this
        # script reported, and why the carried item never reached the pool.
        ("planBacklogItem", {"match": "rounding on odd splits", "toDate": days_ago(2)}),
        # ---- sparks: an idea from feedback, and one with no project behind it -
        ("sparkAdd", {"text": "Charge separately for merging two trips after the fact",
                      "project": LIVE, "date": days_ago(2)}),
        ("sparkAdd", {"text": "A receipt-photo reader could be its own tool"}),
    ]


def plugins() -> list[tuple[str, dict]]:
    return [
        ("addPlugin", {
            "name": "md-table", "origin": "ours", "visibility": "showcase",
            "title": "Markdown table fixer",
            "summary": "Aligns pasted tables and wraps long cells. Sample row for this screenshot.",
            "licence": "MIT", "installed": True, "hasLicenseFile": True, "hasReadme": True,
            "hasScreenshot": True, "sourceOutsideProfile": True, "leakScanPassed": True,
            # WITHOUT a pasteable source path the row fails its own `address` gate
            # item, so it renders "11 of 12" and hands over no commands — which is
            # what a first run of this script produced, and what grading the render
            # caught. The picture is supposed to show a GREEN row.
            "sourcePath": "~/projects/plugins/md-table",
            "leakScanAt": days_ago(7), "preflightPassed": True, "preflightAt": days_ago(7),
            "preflightNote": "scan clean over 9 tracked files, 41 tests green",
            "gitReady": True, "verifiedAt": days_ago(3),
        }),
        ("addPlugin", {
            "name": "sample-widget", "origin": "third-party", "visibility": "internal",
            "title": "Sample third-party widget",
            "summary": "Not ours, so the gate refuses it rather than anyone remembering to.",
            "upstream": "someone/sample-widget@1.2.3", "installed": True,
            "hasLicenseFile": True, "hasReadme": True,
        }),
    ]


DEMO_PROJECTS = {LIVE, WORKING, PENDING}
DEMO_PLUGINS = {payload["name"] for _, payload in plugins()}


def fail(message: str) -> None:
    print(f"seed-demo-store: REFUSING — {message}", file=sys.stderr)
    print("                 This script writes INVENTED projects and plugins. Point it at a", file=sys.stderr)
    print("                 demo store, or pass --force if you truly mean this one.", file=sys.stderr)
    raise SystemExit(2)


def main() -> int:
    port = os.environ.get("PORT", "").strip()
    if not port:
        print("seed-demo-store: PORT is required — name the instance you mean to seed.", file=sys.stderr)
        print("                 e.g. PORT=3098 python3 scripts/seed-demo-store.py", file=sys.stderr)
        return 2
    if port in RESERVED_PORTS and not FORCE:
        fail(f"port {port} is a reserved port on this machine (a real DSH server / the durable planner)")

    day = today()
    base = f"http://127.0.0.1:{port}/daily-progress-tab"

    # Before writing anything: whose store is this? A store holding records this
    # script did not define is somebody's real register, and seeding it would put
    # invented revenue into it.
    try:
        with urllib.request.urlopen(f"{base}/state?localDate={day}&tz={TZ}", timeout=10) as res:
            state = json.load(res)
    except Exception as err:  # noqa: BLE001 - any failure here means "cannot verify, do not write"
        print(f"seed-demo-store: cannot read {base}/state ({err}).", file=sys.stderr)
        print("                 Start the target first (node scripts/render-ui.mjs) — this", file=sys.stderr)
        print("                 script will not seed a store it cannot inspect.", file=sys.stderr)
        return 2

    existing = {p["name"] for p in state.get("projects", [])}
    if not FORCE:
        foreign = sorted((existing | {p["name"] for p in state.get("portfolio", {}).get("entries", [])})
                         - DEMO_PROJECTS - DEMO_PLUGINS)
        if foreign:
            fail("the target holds records this script does not define: " + ", ".join(foreign))
        if existing & DEMO_PROJECTS:
            fail("the target is already seeded ("
                 + ", ".join(sorted(existing & DEMO_PROJECTS))
                 + ") — seeding again would double the check-ins")

    print(f"seeding  {base}  (today {day}, {TZ})")
    print(f"         already present: {sorted(existing) or 'nothing'}")

    def call(op: str, payload: dict) -> dict:
        body = json.dumps({"op": op, "localDate": day, "tz": TZ, "payload": payload}).encode()
        req = urllib.request.Request(base + "/mutate", data=body,
                                     headers={"content-type": "application/json"}, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=15) as res:
                return json.load(res)
        except urllib.error.HTTPError as err:
            return {"ok": False, "code": f"http-{err.code}", "message": err.read().decode()[:200]}

    failures = 0
    # Projects first: everything else addresses them by name.
    for op, payload in steps(day) + plugins():
        if op == "addProject" and payload["name"] in existing:
            print(f"  skip  {op:16s} {payload['name'][:52]}")
            continue
        reply = call(op, payload)
        label = payload.get("name") or payload.get("text") or payload.get("project") or op
        if reply.get("ok"):
            print(f"  ok    {op:16s} {str(label)[:52]}")
        else:
            failures += 1
            print(f"  FAIL  {op:16s} {str(label)[:52]} -> {reply.get('code')}: {reply.get('message')}")

    def read_state() -> dict:
        with urllib.request.urlopen(f"{base}/state?localDate={day}&tz={TZ}", timeout=15) as res:
            return json.load(res)

    # Two tasks done, so the page shows a real progress bar rather than a full one.
    state = read_state()
    for item in (state.get("today") or {}).get("items", []):
        if item["text"].startswith("Reply to the two support threads") and not item.get("done"):
            reply = call("toggleItem", {"itemId": item["id"], "done": True})
            print(f"  {'ok   ' if reply.get('ok') else 'FAIL '} toggleItem       {item['text'][:52]}")
            failures += 0 if reply.get("ok") else 1

    # Fill the banner, because "Now" is the feature the page is built around.
    state = read_state()
    if not state.get("now"):
        for item in (state.get("today") or {}).get("items", []):
            if item["text"].startswith("Rewrite the trial reminder"):
                reply = call("selectItem", {"itemId": item["id"], "date": day})
                print(f"  {'ok   ' if reply.get('ok') else 'FAIL '} selectItem       {item['text'][:52]}")
                failures += 0 if reply.get("ok") else 1

    print("\n" + ("seeded" if failures == 0 else f"{failures} step(s) failed"))
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
