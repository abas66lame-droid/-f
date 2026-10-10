// ══════════════════════════════════════════════════════════════════
//  gps-in — يستقبل الموقع من تطبيق Traccar Client ويحفظه في fleet_gps
//
//  في Traccar Client ← الإعدادات ← عنوان الخادم:
//    https://<المشروع>.supabase.co/functions/v1/gps-in
//  و«معرّف الجهاز» يُسجَّل باسم السائق في جدول fleet_gps_devices.
//
//  يقبل الصيغتين: JSON (Traccar Client الجديد) وOsmAnd (?id=&lat=&lon=...).
//  تُحفظ النقطة فقط إن كان الجهاز مسجّلاً ولسائقه رحلة مفتوحة — بين الرحلات لا يُحفظ شيء.
//
//  الإعداد مرة واحدة: أطفئ «Enforce JWT verification» لهذه الدالة
//  (Traccar لا يرسل مفتاح دخول).
// ══════════════════════════════════════════════════════════════════

const SB_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SB_SECRET") ?? "";

async function db(path: string, init: RequestInit = {}, prefer = "return=representation") {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...init,
    signal: AbortSignal.timeout(10000),
    headers: {
      apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`,
      "Content-Type": "application/json", Prefer: prefer,
    },
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
}

type Pt = { dev: string; lat: number; lng: number; acc: number | null; at: string; batt: number | null };

/* كل الصيغ إلى نقاط موحّدة */
function parse(q: URLSearchParams, body: any): Pt[] {
  const out: Pt[] = [];
  const num = (v: unknown) => (v == null || v === "" || !isFinite(Number(v)) ? null : Number(v));
  /* JSON: { device_id, location: {...} | [...] } */
  if (body && typeof body === "object") {
    const dev = String(body.device_id ?? body.id ?? q.get("id") ?? "");
    const locs = Array.isArray(body.location) ? body.location : body.location ? [body.location]
      : Array.isArray(body.locations) ? body.locations : [];
    for (const l of locs) {
      const c = l.coords || l;
      const lat = num(c.latitude ?? c.lat), lng = num(c.longitude ?? c.lon ?? c.lng);
      if (lat == null || lng == null) continue;
      const lv = num(l.battery?.level);
      out.push({ dev, lat, lng, acc: num(c.accuracy),
        at: new Date(l.timestamp ?? Date.now()).toISOString(), batt: lv == null ? null : (lv <= 1 ? lv * 100 : lv) });
    }
  }
  /* OsmAnd: ?id=..&lat=..&lon=..&timestamp=..&accuracy=..&batt=.. */
  const lat = num(q.get("lat")), lng = num(q.get("lon") ?? q.get("lng"));
  if (!out.length && lat != null && lng != null) {
    const ts = q.get("timestamp");
    const at = !ts ? new Date() : /^\d+$/.test(ts) ? new Date(Number(ts) * (ts.length > 11 ? 1 : 1000)) : new Date(ts);
    out.push({ dev: String(q.get("id") ?? q.get("deviceid") ?? ""), lat, lng, acc: num(q.get("accuracy")),
      at: (isNaN(at.getTime()) ? new Date() : at).toISOString(), batt: num(q.get("batt")) });
  }
  /* معرّف الجهاز أرقام وحروف فقط — يدخل في عنوان الاستعلام */
  return out.filter((p) => /^[A-Za-z0-9_-]{1,64}$/.test(p.dev) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180);
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  let body: any = null;
  if (req.method === "POST") {
    const t = await req.text();
    try { body = JSON.parse(t); } catch {
      /* form-urlencoded */
      for (const [k, v] of new URLSearchParams(t)) url.searchParams.set(k, v);
    }
  }
  const pts = parse(url.searchParams, body);
  if (!pts.length) return new Response("gps-in ok");
  try {
    const devs = [...new Set(pts.map((p) => p.dev))];
    const rows: any[] = (await db(`fleet_gps_devices?device_id=in.(${devs.map((d) => `"${d.replace(/"/g, "")}"`).join(",")})&select=device_id,driver_id`)) ?? [];
    const drv: Record<string, string> = {}; rows.forEach((r) => (drv[r.device_id] = String(r.driver_id)));
    const trips: Record<string, number | null> = {};
    const ins: any[] = [];
    for (const p of pts) {
      const d = drv[p.dev];
      if (!d) { console.log("unknown device", p.dev); continue; }
      if (!(d in trips)) {
        const t = ((await db(`fleet_trips?driver_id=eq.${encodeURIComponent(d)}&in_at=is.null&select=id&order=out_at.desc&limit=1`)) ?? [])[0];
        trips[d] = t ? t.id : null;
      }
      if (!trips[d]) continue;                       /* بين الرحلات: لا يُحفظ */
      ins.push({ trip_id: trips[d], driver_id: d, lat: p.lat, lng: p.lng, acc: p.acc, at: p.at, batt: p.batt });
    }
    if (ins.length) await db("fleet_gps", { method: "POST", body: JSON.stringify(ins) }, "return=minimal");
  } catch (e) {
    /* خطأ عندنا: 500 فيعيد Traccar الإرسال لاحقاً (يحفظ النقاط في الهاتف) */
    console.error(e);
    return new Response("error", { status: 500 });
  }
  /* 200 دائماً للجهاز غير المسجّل أو بلا رحلة — وإلا يكرّر Traccar الإرسال بلا نهاية */
  return new Response("ok");
});
