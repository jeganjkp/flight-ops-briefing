#!/usr/bin/env python3
"""
Fetches current METAR, TAF, international SIGMET data, and a 3-day layman
forecast (Open-Meteo) for every airport in the active Supabase roster.

Reads the active roster from Supabase on every run so new destinations are
picked up automatically — no manual edits needed when the roster changes.
Falls back to a hardcoded default set if Supabase is unreachable.

Run on a schedule by .github/workflows/update-weather.yml.
"""
import json
import urllib.request
from datetime import datetime, timezone

SUPABASE_ACTIVE_ROSTER_URL = (
    "https://juohlwflvehlctiutrcu.supabase.co/functions/v1/active-roster"
)

# Master airport database — add any new destination here once ever.
# key: IATA code  value: (ICAO, lat, lon, [FIR, ...])
AIRPORT_DB = {
    # Malaysia
    "KUL": ("WMKK",  2.7456,  101.7099, ["WMFC"]),
    # Australia
    "SYD": ("YSSY", -33.9461, 151.1772, ["YBBB", "YMMM"]),
    "MEL": ("YMML", -37.6690, 144.8410, ["YMMM"]),
    "PER": ("YPPH", -31.9385, 115.9672, ["YMMM"]),
    "ADL": ("YPAD", -34.9450, 138.5310, ["YMMM"]),
    "BNE": ("YBBN", -27.3842, 153.1175, ["YBBB"]),
    # Japan
    "KIX": ("RJBB",  34.4347, 135.2441, ["RJJJ"]),
    "NRT": ("RJAA",  35.7653, 140.3857, ["RJJJ"]),
    "HND": ("RJTT",  35.5494, 139.7798, ["RJJJ"]),
    "NGO": ("RJGG",  34.8583, 136.8047, ["RJJJ"]),
    # South Korea
    "ICN": ("RKSI",  37.4602, 126.4407, ["RKRR"]),
    # China
    "CAN": ("ZGGG",  23.3924, 113.2988, ["ZGZU"]),
    "PVG": ("ZSPD",  31.1443, 121.8083, ["ZSHA"]),
    "PEK": ("ZBAA",  40.0799, 116.5846, ["ZBPE"]),
    "CTU": ("ZUUU",  30.5785, 103.9469, ["ZGZU"]),
    "XIY": ("ZLXY",  34.4471, 108.7519, ["ZBPE"]),
    # Hong Kong
    "HKG": ("VHHH",  22.3080, 113.9185, ["VHHK"]),
    # Taiwan
    "TPE": ("RCTP",  25.0777, 121.2327, ["RCAA"]),
    # Thailand
    "BKK": ("VTBS",  13.6811, 100.7470, ["VVTS"]),
    # Indonesia
    "CGK": ("WIII",  -6.1256, 106.6559, ["WSJC"]),
    "DPS": ("WADD",  -8.7482, 115.1670, ["WSJC"]),
    # India
    "DEL": ("VIDP",  28.5665,  77.1031, ["VECF"]),
    "BOM": ("VABB",  19.0896,  72.8656, ["VECF"]),
    # Middle East
    "DXB": ("OMDB",  25.2528,  55.3644, ["OMAE"]),
    "DOH": ("OTHH",  25.2731,  51.6080, ["OBBB"]),
    # Europe
    "LHR": ("EGLL",  51.4775,  -0.4614, ["EGTT"]),
    "CDG": ("LFPG",  49.0097,   2.5478, ["LFFF"]),
    "FRA": ("EDDF",  50.0379,   8.5622, ["EDGG"]),
    "AMS": ("EHAM",  52.3086,   4.7639, ["EHAA"]),
    "ZRH": ("LSZH",  47.4647,   8.5492, ["LSAS"]),
    "MUC": ("EDDM",  48.3538,  11.7861, ["EDGG"]),
}

DEFAULT_IATAS = ["KUL", "SYD", "MEL", "PER", "ADL", "KIX", "CAN"]


def fetch_json(url, headers=None):
    req = urllib.request.Request(url, headers={"User-Agent": "flight-ops-briefing/1.0", **(headers or {})})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def get_roster_iatas():
    """Return the set of IATA airport codes from the active Supabase roster."""
    try:
        roster = fetch_json(SUPABASE_ACTIVE_ROSTER_URL)
        iatas = set()
        for leg in roster.get("legs", []):
            iatas.add(leg.get("dep_airport", "").upper())
            iatas.add(leg.get("arr_airport", "").upper())
        iatas.discard("")
        if iatas:
            print(f"Loaded active roster airports: {sorted(iatas)}")
            return iatas
    except Exception as e:
        print(f"Warning: could not fetch active roster from Supabase ({e}), using defaults")
    return set(DEFAULT_IATAS)


def fetch_forecast(lat, lon):
    url = (
        "https://api.open-meteo.com/v1/forecast"
        f"?latitude={lat}&longitude={lon}"
        "&hourly=temperature_2m,weather_code,precipitation_probability"
        "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset"
        "&timezone=auto&forecast_days=3"
    )
    data = fetch_json(url)
    return {
        "timezone": data.get("timezone"),
        "hourly": data.get("hourly", {}),
        "daily": data.get("daily", {}),
    }


def main():
    iatas = get_roster_iatas()

    # Resolve to known ICAO codes; skip unknown airports with a warning
    airports = {}
    for iata in iatas:
        if iata in AIRPORT_DB:
            airports[iata] = AIRPORT_DB[iata]
        else:
            print(f"Warning: {iata} not in AIRPORT_DB — skipping weather fetch")

    icaos = [v[0] for v in airports.values()]
    firs = set(fir for v in airports.values() for fir in v[3])

    ids = ",".join(icaos)
    metar = fetch_json(f"https://aviationweather.gov/api/data/metar?ids={ids}&format=json")
    taf   = fetch_json(f"https://aviationweather.gov/api/data/taf?ids={ids}&format=json")

    now = datetime.now(timezone.utc)
    sigmet = []
    try:
        all_sigmets = fetch_json("https://aviationweather.gov/api/data/isigmet?format=json")
        for s in all_sigmets:
            if s.get("firId") not in firs:
                continue
            vt = s.get("validTimeTo")
            if vt:
                try:
                    if datetime.fromisoformat(str(vt).replace("Z", "+00:00")) < now:
                        continue
                except ValueError:
                    pass
            sigmet.append(s)
    except Exception as e:
        sigmet = {"error": str(e)}

    forecast = {}
    for iata, (icao, lat, lon, _) in airports.items():
        try:
            forecast[icao] = fetch_forecast(lat, lon)
        except Exception as e:
            forecast[icao] = {"error": str(e)}

    data = {
        "fetched_at": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "metar": metar,
        "taf": taf,
        "sigmet": sigmet,
        "forecast": forecast,
    }

    with open("data.json", "w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
    print(f"data.json written for {sorted(iatas)}")


if __name__ == "__main__":
    main()
