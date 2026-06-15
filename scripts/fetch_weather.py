#!/usr/bin/env python3
"""
Fetches current METAR, TAF and international SIGMET data for the airports
on Jegan's MH A330 roster and writes data.json at the repo root for the
flight-ops-briefing static page (served via GitHub Pages).

Run on a schedule by .github/workflows/update-weather.yml — no external
dependencies (stdlib only) so it runs on a bare ubuntu-latest runner.

In your repo, place this file at: scripts/fetch_weather.py
"""
import json
import urllib.request
from datetime import datetime, timezone

# All airports that currently appear anywhere on the roster.
ICAOS = ["WMKK", "YSSY", "YMML", "YPPH", "RJBB", "ZGGG"]

# FIRs relevant to those airports (for SIGMET filtering).
FIRS = {"WMFC", "YBBB", "YMMM", "RJJJ", "ZGZU"}


def fetch_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "flight-ops-briefing/1.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def main():
    ids = ",".join(ICAOS)

    metar = fetch_json(f"https://aviationweather.gov/api/data/metar?ids={ids}&format=json")
    taf = fetch_json(f"https://aviationweather.gov/api/data/taf?ids={ids}&format=json")

    now = datetime.now(timezone.utc)
    sigmet = []
    try:
        all_sigmets = fetch_json("https://aviationweather.gov/api/data/isigmet?format=json")
        for s in all_sigmets:
            if s.get("firId") not in FIRS:
                continue
            vt = s.get("validTimeTo")
            if vt:
                try:
                    vt_dt = datetime.fromisoformat(str(vt).replace("Z", "+00:00"))
                    if vt_dt < now:
                        continue
                except ValueError:
                    pass
            sigmet.append(s)
    except Exception as e:
        # Don't fail the whole update if the SIGMET feed has a hiccup —
        # keep METAR/TAF fresh and just note the issue.
        sigmet = {"error": str(e)}

    data = {
        "fetched_at": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "metar": metar,
        "taf": taf,
        "sigmet": sigmet,
    }

    with open("data.json", "w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")


if __name__ == "__main__":
    main()
