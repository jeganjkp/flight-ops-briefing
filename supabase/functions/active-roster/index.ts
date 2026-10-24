import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
// Viewing accepts the upload secret, or an optional view-only VIEW_SECRET.
const UPLOAD_SECRET = Deno.env.get("UPLOAD_SECRET") ?? ""
const VIEW_SECRET = Deno.env.get("VIEW_SECRET") ?? ""

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

function authorized(req: Request) {
  const auth = req.headers.get("Authorization") ?? ""
  return [UPLOAD_SECRET, VIEW_SECRET].some((s) => s && auth === `Bearer ${s}`)
}

// "Oct-2026" -> "2026-10"; falls back to the month most legs depart in.
// deno-lint-ignore no-explicit-any
function monthKey(roster: any): string | null {
  const m = /^([A-Za-z]{3})[A-Za-z]*[-\s](\d{4})$/.exec(String(roster?.month ?? "").trim())
  if (m) {
    const idx = MONTHS.indexOf(m[1][0].toUpperCase() + m[1].slice(1, 3).toLowerCase())
    if (idx >= 0) return `${m[2]}-${String(idx + 1).padStart(2, "0")}`
  }
  const counts = new Map<string, number>()
  for (const leg of roster?.legs ?? []) {
    const k = String(leg.dep_date ?? "").slice(0, 7)
    if (k) counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
}

function monthLabel(key: string) {
  return `${MONTHS[Number(key.slice(5, 7)) - 1]}-${key.slice(0, 4)}`
}

// Merge one roster per month into a single roster. Every dated item (leg by
// dep_date, standby date, day off) comes from the roster of its own month when
// that month is loaded, so a trip spanning a month boundary is not doubled.
// deno-lint-ignore no-explicit-any
function mergeRosters(byMonth: Map<string, any>) {
  const keys = [...byMonth.keys()].sort()
  const owned = (key: string, date: string) => date.slice(0, 7) === key || !byMonth.has(date.slice(0, 7))
  // deno-lint-ignore no-explicit-any
  const legs: any[] = [], standby: any[] = []
  const seen = new Set<string>(), daysOff = new Set<string>()
  for (const key of keys) {
    const r = byMonth.get(key)
    for (const leg of r.legs ?? []) {
      const id = `${leg.flight}|${leg.dep_date}|${leg.dep_airport}`
      if (!owned(key, leg.dep_date) || seen.has(id)) continue
      seen.add(id)
      legs.push(leg)
    }
    for (const sb of r.standby ?? []) {
      const dates = (sb.dates ?? []).filter((d: string) => owned(key, d))
      if (dates.length) standby.push({ ...sb, dates })
    }
    for (const d of r.days_off ?? []) if (owned(key, d)) daysOff.add(d)
  }
  legs.sort((a, b) => `${a.dep_date} ${a.dep_time}`.localeCompare(`${b.dep_date} ${b.dep_time}`))
  const months = keys.map(monthLabel)
  return {
    pilot: byMonth.get(keys[keys.length - 1]).pilot,
    month: months.join(" · "),
    months,
    legs,
    standby,
    days_off: [...daysOff].sort(),
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS })

  if (!authorized(req)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...CORS, "Content-Type": "application/json" },
    })
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  const { data, error } = await supabase
    .from("roster_versions")
    .select("roster_json")
    .eq("status", "active")
    .order("activated_at", { ascending: true })

  // Last month onward: the previous month feeds the rolling 7/28-day totals.
  const now = new Date()
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
  const fromKey = prev.toISOString().slice(0, 7)
  // deno-lint-ignore no-explicit-any
  const byMonth = new Map<string, any>()
  for (const row of data ?? []) {
    const key = monthKey(row.roster_json)
    if (key && key >= fromKey) byMonth.set(key, row.roster_json) // later activation wins
  }

  if (error || !byMonth.size) {
    return new Response(JSON.stringify({ error: "No active roster" }), {
      status: 404,
      headers: { ...CORS, "Content-Type": "application/json" },
    })
  }

  return new Response(JSON.stringify(mergeRosters(byMonth)), {
    headers: { ...CORS, "Content-Type": "application/json" },
  })
})
