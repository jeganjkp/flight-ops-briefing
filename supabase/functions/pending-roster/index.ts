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

function authorized(req: Request) {
  const auth = req.headers.get("Authorization") ?? ""
  return [UPLOAD_SECRET, VIEW_SECRET].some((s) => s && auth === `Bearer ${s}`)
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
    .select("id, month, created_at")
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error || !data) {
    return new Response(JSON.stringify({ pending: false }), {
      headers: { ...CORS, "Content-Type": "application/json" },
    })
  }

  return new Response(
    JSON.stringify({ pending: true, id: data.id, month: data.month, created_at: data.created_at }),
    { headers: { ...CORS, "Content-Type": "application/json" } },
  )
})
