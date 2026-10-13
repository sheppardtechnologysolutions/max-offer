// Max Offer: RentCast lookup (Supabase Edge Function)
// Keeps the RentCast key on the server, caches results for 30 days,
// and caps fresh RentCast requests per calendar month so the free plan never overruns.
//
// Secrets (Dashboard → Edge Functions → Secrets):
//   RENTCAST_API_KEY        required
//   MAX_MONTHLY_REQUESTS    optional, default 45 (free plan includes 50)
//   CACHE_DAYS              optional, default 30
// SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are provided automatically.

import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const RC = "https://api.rentcast.io/v1";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const keyOf = (a: string) => a.toLowerCase().replace(/[.,#]/g, " ").replace(/\s+/g, " ").trim();

async function rc(path: string, params: Record<string, string>, apiKey: string) {
  const url = `${RC}${path}?${new URLSearchParams(params)}`;
  const res = await fetch(url, { headers: { "X-Api-Key": apiKey, Accept: "application/json" } });
  if (res.status === 404) return { ok: false, status: 404, data: null, billed: false };
  const text = await res.text();
  let data: unknown = null;
  try { data = JSON.parse(text); } catch { data = text; }
  return { ok: res.ok, status: res.status, data, billed: res.status === 200 };
}

// deno-lint-ignore no-explicit-any
function latestTax(rec: any): number | null {
  const t = rec?.propertyTaxes;
  if (!t || typeof t !== "object") return null;
  const years = Object.keys(t).filter((y) => t[y] && typeof t[y].total === "number").sort();
  return years.length ? t[years[years.length - 1]].total : null;
}

// deno-lint-ignore no-explicit-any
const comp = (c: any) => ({
  address: c.formattedAddress ?? c.addressLine1 ?? "",
  type: c.propertyType ?? null,
  beds: c.bedrooms ?? null, baths: c.bathrooms ?? null, sqft: c.squareFootage ?? null,
  year: c.yearBuilt ?? null, price: c.price ?? null, status: c.status ?? null,
  listed: c.listedDate ?? c.lastSeenDate ?? null, dom: c.daysOnMarket ?? null,
  distance: c.distance ?? null, match: c.correlation ?? null,
});

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);

  // 1. Signed-in users only.
  const authHeader = req.headers.get("Authorization") ?? "";
  const userClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return json({ error: "Sign in to look up properties." }, 401);

  let address = "";
  let refresh = false;
  try { const b = await req.json(); address = String(b.address ?? "").trim(); refresh = !!b.refresh; } catch { /* empty */ }
  if (address.length < 8) return json({ error: "Enter a full address: street, city, state and ZIP." }, 400);

  const apiKey = Deno.env.get("RENTCAST_API_KEY");
  if (!apiKey) return json({ error: "The RentCast key isn't set. Add RENTCAST_API_KEY in Edge Function secrets." }, 500);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const key = keyOf(address);
  const cacheDays = Number(Deno.env.get("CACHE_DAYS") ?? 30);
  const cap = Number(Deno.env.get("MAX_MONTHLY_REQUESTS") ?? 45);

  // 2. Serve from cache when fresh enough.
  const { data: cached } = await admin.from("property_cache").select("data, fetched_at").eq("address_key", key).maybeSingle();
  if (cached && !refresh && Date.now() - new Date(cached.fetched_at).getTime() < cacheDays * 864e5) {
    return json({ ...cached.data, cached: true, fetchedAt: cached.fetched_at });
  }

  // 3. Enforce the monthly cap before spending requests.
  const monthStart = new Date(); monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
  const { data: used } = await admin.from("lookup_log").select("requests").gte("created_at", monthStart.toISOString());
  const spent = (used ?? []).reduce((s, r) => s + (r.requests ?? 0), 0);
  if (spent + 3 > cap) {
    if (cached) return json({ ...cached.data, cached: true, fetchedAt: cached.fetched_at, note: "Monthly lookup limit reached; showing saved data." });
    return json({ error: `Monthly lookup limit reached (${spent} of ${cap} RentCast requests used). It resets on the 1st.`, spent, cap }, 429);
  }

  // 4. Three RentCast calls in parallel: property record, value estimate, rent estimate.
  const [rec, val, rent] = await Promise.all([
    rc("/properties", { address, limit: "1" }, apiKey),
    rc("/avm/value", { address, compCount: "10" }, apiKey),
    rc("/avm/rent/long-term", { address, compCount: "10" }, apiKey),
  ]);
  const billed = [rec, val, rent].filter((r) => r.billed).length;
  if (billed) await admin.from("lookup_log").insert({ user_id: user.id, address_key: key, requests: billed });

  if (rec.status === 401 || val.status === 401) return json({ error: "RentCast rejected the API key. Check RENTCAST_API_KEY." }, 502);
  if (!val.ok && !rent.ok && !rec.ok) return json({ error: "RentCast couldn't find that address. Check the spelling and include the ZIP." }, 404);

  // deno-lint-ignore no-explicit-any
  const r0: any = Array.isArray(rec.data) ? rec.data[0] : null;
  // deno-lint-ignore no-explicit-any
  const v: any = val.ok ? val.data : null;
  // deno-lint-ignore no-explicit-any
  const rn: any = rent.ok ? rent.data : null;
  const subj = r0 ?? v?.subjectProperty ?? rn?.subjectProperty ?? {};

  const result = {
    address: subj.formattedAddress ?? address,
    property: {
      type: subj.propertyType ?? null, beds: subj.bedrooms ?? null, baths: subj.bathrooms ?? null,
      sqft: subj.squareFootage ?? null, lot: subj.lotSize ?? null, year: subj.yearBuilt ?? null,
      units: r0?.features?.unitCount ?? null,
      lastSalePrice: subj.lastSalePrice ?? null, lastSaleDate: subj.lastSaleDate ?? null,
      annualTaxes: latestTax(r0), hoaMonthly: r0?.hoa?.fee ?? null,
      owner: r0?.owner?.names?.join(", ") ?? null, ownerOccupied: r0?.ownerOccupied ?? null,
    },
    value: v ? { estimate: v.price ?? null, low: v.priceRangeLow ?? null, high: v.priceRangeHigh ?? null, comps: (v.comparables ?? []).slice(0, 10).map(comp) } : null,
    rent: rn ? { estimate: rn.rent ?? null, low: rn.rentRangeLow ?? null, high: rn.rentRangeHigh ?? null, comps: (rn.comparables ?? []).slice(0, 10).map(comp) } : null,
  };

  const fetchedAt = new Date().toISOString();
  await admin.from("property_cache").upsert({ address_key: key, data: result, fetched_at: fetchedAt });
  return json({ ...result, cached: false, fetchedAt, usage: { spent: spent + billed, cap } });
});
