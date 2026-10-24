import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
const UPLOAD_SECRET = Deno.env.get("UPLOAD_SECRET")!

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

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
    const { id } = await req.json()
    if (!id)
      return new Response(JSON.stringify({ error: "id required" }), {
        status: 400,
        headers: { ...CORS, "Content-Type": "application/json" },
      })

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

    const { data: target, error: targetError } = await supabase
      .from("roster_versions")
      .select("roster_json")
      .eq("id", id)
      .single()
    if (targetError) throw new Error(targetError.message)
    const key = monthKey(target.roster_json)

    // Supersede only earlier versions of the same month; other months stay live.
    const { data: others, error: othersError } = await supabase
      .from("roster_versions")
      .select("id, roster_json")
      .neq("id", id)
      .in("status", ["active", "pending"])
    if (othersError) throw new Error(othersError.message)
    const sameMonth = (others ?? []).filter((r) => monthKey(r.roster_json) === key).map((r) => r.id)
    if (sameMonth.length) {
      const { error } = await supabase.from("roster_versions").update({ status: "archived" }).in("id", sameMonth)
      if (error) throw new Error(error.message)
    }

    const { data, error } = await supabase
      .from("roster_versions")
      .update({ status: "active", activated_at: new Date().toISOString() })
      .eq("id", id)
      .select("roster_json")
      .single()

    if (error) throw new Error(error.message)

    return new Response(JSON.stringify(data.roster_json), {
      headers: { ...CORS, "Content-Type": "application/json" },
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { ...CORS, "Content-Type": "application/json" },
    })
  }
})
