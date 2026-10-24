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
    const mediaType = (file.type && file.type.startsWith("image/")) ? file.type : "image/jpeg"

    const prompt = `You are parsing a Malaysia Airlines (MAB) pilot roster image. Extract ALL flights, standby duties, and days off into this exact JSON structure. Be precise with dates (YYYY-MM-DD), times (HH:MM 24-hour LOCAL at each station), IATA airport codes, and flight numbers.

Return ONLY valid JSON — no markdown fences, no explanation:
{
  "pilot": {"name":"FULL NAME AS SHOWN","staff_number":"7-digit number","rank":"FO","base":"KUL","fleet":"330"},
  "month": "Mon-YYYY",
  "legs": [
    {"flight":"MHxxx","dep_date":"YYYY-MM-DD","dep_airport":"XXX","dep_time":"HH:MM","arr_airport":"XXX","arr_date":"YYYY-MM-DD","arr_time":"HH:MM","ac_type":"33x"}
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
- Leave days with no code out of every list; do not put them in days_off.`

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
            { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
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
