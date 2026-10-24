import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"

// Unauthenticated: returns only the IATA codes in the live rosters (this month
// onward), for the weather workflow. No names, dates or flight numbers.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS })

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  const { data, error } = await supabase
    .from("roster_versions")
    .select("roster_json")
    .eq("status", "active")

  const today = new Date().toISOString().slice(0, 10)
  const airports = new Set<string>()
  for (const row of data ?? []) {
    for (const leg of row.roster_json?.legs ?? []) {
      if (String(leg.arr_date ?? leg.dep_date ?? "") < today.slice(0, 7)) continue
      if (leg.dep_airport) airports.add(String(leg.dep_airport).toUpperCase())
      if (leg.arr_airport) airports.add(String(leg.arr_airport).toUpperCase())
    }
  }

  if (error || !airports.size) {
    return new Response(JSON.stringify({ error: "No active roster" }), {
      status: 404,
      headers: { ...CORS, "Content-Type": "application/json" },
    })
  }

  return new Response(JSON.stringify({ airports: [...airports].sort() }), {
    headers: { ...CORS, "Content-Type": "application/json" },
  })
})
