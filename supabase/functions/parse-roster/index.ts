import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!
const UPLOAD_SECRET = Deno.env.get("UPLOAD_SECRET")!

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
}

// Local clock difference (arrival minus departure) outside this range means a
// misread date or time: MAB block times plus time-zone shifts stay well inside it.
const MIN_LOCAL_HOURS = -10
const MAX_LOCAL_HOURS = 20

// deno-lint-ignore no-explicit-any
function legWarnings(legs: any[]): string[] {
  const warnings: string[] = []
  for (const l of legs ?? []) {
    const dep = Date.parse(`${l.dep_date}T${l.dep_time}:00Z`)
    const arr = Date.parse(`${l.arr_date}T${l.arr_time}:00Z`)
    const hours = (arr - dep) / 3600000
    if (!Number.isFinite(hours)) {
      warnings.push(`${l.flight}: unreadable date or time`)
    } else if (hours < MIN_LOCAL_HOURS || hours > MAX_LOCAL_HOURS) {
      warnings.push(`${l.flight} ${l.dep_airport}→${l.arr_airport}: arrival ${l.arr_date} ${l.arr_time} does not fit departure ${l.dep_date} ${l.dep_time}`)
    }
    if (!/^(MH|DH)\d{2,4}$/.test(String(l.flight ?? ""))) warnings.push(`${l.flight}: unusual flight number`)
  }
  return warnings
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  const CHUNK = 8192
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS })

  const auth = req.headers.get("Authorization")
  if (auth !== `Bearer ${UPLOAD_SECRET}`) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...CORS, "Content-Type": "application/json" },
    })
  }

  try {
    const form = await req.formData()
    const file = form.get("file") as File
    if (!file)
      return new Response(JSON.stringify({ error: "No file uploaded" }), {
        status: 400,
        headers: { ...CORS, "Content-Type": "application/json" },
      })

    const bytes = await file.arrayBuffer()
    const base64 = arrayBufferToBase64(bytes)
    const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")
    const mediaType = (file.type && file.type.startsWith("image/")) ? file.type : "image/jpeg"
    const rosterBlock = isPdf
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } }
      : { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } }

    const prompt = `You are parsing a Malaysia Airlines (MAB) pilot roster (an image or PDF). Extract ALL flights, standby duties, and days off into this exact JSON structure. Be precise with dates (YYYY-MM-DD), times (HH:MM 24-hour LOCAL at each station), IATA airport codes, and flight numbers.

Return ONLY valid JSON — no markdown fences, no explanation:
{
  "pilot": {"name":"FULL NAME AS SHOWN","staff_number":"7-digit number","rank":"FO","base":"KUL","fleet":"330"},
  "month": "Mon-YYYY",
  "legs": [
    {"flight":"MHxxx","dep_date":"YYYY-MM-DD","dep_airport":"XXX","dep_time":"HH:MM","arr_airport":"XXX","arr_date":"YYYY-MM-DD","arr_time":"HH:MM","ac_type":"33x","work_type":"OP"}
  ],
  "standby": [
    {"code":"S4-330","dates":["YYYY-MM-DD"],"location":"KUL","report":"HH:MM","release":"HH:MM"}
  ],
  "days_off": ["YYYY-MM-DD"]
}

Rules:
- arr_time is BLOCK-DOWN (landing time), NOT duty end. Duty end = arr_time + 45 min.
- All times are LOCAL at the station.
- ac_type: 339 for A330-900neo, 333 for A330-300.
- Flight numbers: copy the prefix exactly as printed — "MH" for operating flights (e.g. MH251, MH130), "DH" for deadhead/positioning sectors (e.g. "DH 2521" -> "DH2521"). Never turn a DH sector into an MH flight.
- Days off: a day whose code is "D" alone, or "DO" optionally followed by digits (DO, DO1, DO2, ...), is a day off — put its date in days_off. Only those codes count; "DH" is a deadhead flight, not a day off.
- Standby: codes starting with "S" (any case, e.g. "S2-330", "s4-330") are standby duties. Put them in standby with the code in uppercase, the station, and the report/release times shown (e.g. "S4-330 KUL 17:00 - KUL 23:59" -> location KUL, report 17:00, release 23:59). Group consecutive or repeated dates with the same code, station and times into one entry.
- "LO <station>" is a layover, and REPORT/DEBRIEF lines are duty times for the flights on that day — neither is a leg, a standby, or a day off.
- Leave days with no code out of every list; do not put them in days_off.

Tabular "Roster Report" layout (columns Date, Pairing/Activity, Duty Report, Item, Work Type, Dep Stn / Dep Time, Arr. Stn / Arr. Time, Duty Debrief, Flying Hrs, Duty Hrs, A/C Type, ...):
- The Date column is the date of that row's duty report. Every time in the row is on that date unless the time itself carries "(+1)", which means the following day. A "(+1)" applies only to the cell it is printed in: a "(+1)" on Duty Debrief does NOT move the arrival date, and a "(+1)" on Dep Time DOES move dep_date.
  Example: Date 12-Nov-2026, Dep "KUL 19:00", Arr "JED 23:40", Duty Debrief "00:25(+1)" -> dep_date and arr_date are both 2026-11-12.
  Example: Date 29-Nov-2026, Duty Report 23:10, Dep "ICN 00:10(+1)", Arr "KUL 05:55(+1)" -> dep_date and arr_date are both 2026-11-30.
- The flight number is the Item column, copied digit for digit (e.g. MH6178, MH366, MH6075, MH251 — 3 or 4 digits; do not drop or add digits). Do not take it from the Pairing/Activity column.
- work_type is the Work Type column, copied as printed (OP, PS, SFP, ...). OP is operating at the controls. PS is positioning (deadheading): add "deadhead": true. SFP is safety pilot: a working flight duty, but not at the controls — do NOT mark it deadhead.
- If a row's Flying Hrs is 0:00 (PS, SFP, or any other work type), add "logs_flight_time": false to that leg.
- Rows whose Item is a day-off code (D, DO2, ...) are days off, not legs.

Dates must be read, never inferred: do not work out a row's date from neighbouring rows, pairing codes or typical trip lengths. If the Date column (or any row's date) is cut off or not legible, return ONLY {"error": "Date column not readable — save the roster in landscape or fit to page width"} instead of a roster.`

    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-opus-4-5",
        max_tokens: 4096,
        messages: [{
          role: "user",
          content: [
            rosterBlock,
            { type: "text", text: prompt },
          ],
        }],
      }),
    })

    const anthropicData = await anthropicRes.json()
    if (!anthropicRes.ok) throw new Error(anthropicData.error?.message ?? "Claude API error")

    const text = (anthropicData.content[0].text as string).trim()
    let roster
    try {
      roster = JSON.parse(text)
    } catch {
      const match = text.match(/\{[\s\S]*\}/)
      if (!match) throw new Error("Claude returned non-JSON: " + text.slice(0, 300))
      roster = JSON.parse(match[0])
    }

    if (roster.error) throw new Error(roster.error)

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    const { data, error } = await supabase
      .from("roster_versions")
      .insert({ month: roster.month, roster_json: roster, status: "pending" })
      .select("id, month")
      .single()

    if (error) throw new Error(error.message)

    return new Response(
      JSON.stringify({
        id: data.id,
        month: roster.month,
        leg_count: roster.legs?.length ?? 0,
        standby_count: roster.standby?.length ?? 0,
        days_off_count: roster.days_off?.length ?? 0,
        warnings: legWarnings(roster.legs),
      }),
      { headers: { ...CORS, "Content-Type": "application/json" } },
    )
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { ...CORS, "Content-Type": "application/json" },
    })
  }
})
