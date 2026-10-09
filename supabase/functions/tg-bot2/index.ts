// ══════════════════════════════════════════════════════════════════
//  بوت تلجرام للتوصيل — tg-bot2 (صور، فيديو، تتبّع الموقع، أسباب الوقفات)
//
//  دالة مستقلة عن tg-bot القديمة: تُنشأ بجانبها، وفتح <رابطها>?setup=1 ينقل
//  البوت إليها. للرجوع للقديمة افتح <رابط tg-bot>?setup=1.
//
//  السائق يرسل صورة أو فيديو (أو فيديو دائري، أو ملفاً من نوع صورة/فيديو)،
//  ويُحفظ كل واحد بعلامة تميّز نوعه في storage_path:
//    tg:<id> صورة · tgv:<id> فيديو · tgn:<id> فيديو دائري · tgd:<id> ملف
//  والألبوم (عدة صور/فيديوهات دفعة واحدة) يُحسب كلّه للمهمة نفسها.
//
//  الصور لا تمرّ أبداً بـ Supabase: السائق يرسلها لتلجرام، وتلجرام
//  يحفظها، والبوت يعيد إرسالها للمدقّق بمعرّفها (file_id) فقط.
//  ما يُكتب في قاعدة البيانات سطر نصّي: «المهمة كذا لها صورة».
//
//  التعرّف على الشخص: التطبيق يصنع «تذكرة» سرّية عند الضغط على الزر
//  (مربوطة بحسابه المسجّل فيه)، ويفتح البوت بها. البوت يقرأ التذكرة
//  فيعرف من هو ودوره وماذا يريد — بلا أرقام هواتف ولا تسجيل.
//
//  الإعداد مرة واحدة:
//   ١) أضف السرّ BOT_TOKEN في Edge Functions ← Secrets
//   ٢) أطفئ «Enforce JWT verification» لهذه الدالة
//   ٣) افتح في المتصفح:  <رابط الدالة>?setup=1
// ══════════════════════════════════════════════════════════════════

import jpeg from "npm:jpeg-js@0.4.4";
import jsQR from "npm:jsqr@1.4.0";

const TOKEN  = Deno.env.get("BOT_TOKEN") ?? "";
/* مفتاح كاميرا الأماني (نفس المفتاح داخل التطبيق) — يُضاف في Edge Functions ← Secrets باسم CAM_KEY */
const CAM_KEY = Deno.env.get("CAM_KEY") ?? "";
const SB_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SB_SECRET") ?? "";
const FN_NAME = "tg-bot2";
const FN_URL = SB_URL + "/functions/v1/" + FN_NAME;

const TICKET_TTL_MIN = 30;
const REVIEWERS = ["fleet", "sales", "dev"];
const ROLE_AR: Record<string, string> = {
  fleet: "مسؤول التوصيل", sales: "مدير المبيعات", driver: "سائق", dev: "المطوّر",
};

/* سرّ الـ webhook مشتقّ من التوكن — لا متغيّر إضافي يُضبط */
async function hookSecret(): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("tg-bot:" + TOKEN));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 48);
}

/* ── Telegram ── */
async function tg(method: string, body: unknown) {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) console.error(method, JSON.stringify(j).slice(0, 300));
  return j;
}
const say = (chat: number, text: string, extra: Record<string, unknown> = {}) =>
  tg("sendMessage", { chat_id: chat, text, ...extra });

/* ── قاعدة البيانات (نصوص فقط) ── */
async function db(path: string, init: RequestInit = {}, prefer = "return=representation") {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...init,
    signal: AbortSignal.timeout(10000),
    headers: {
      apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`,
      "Content-Type": "application/json", Prefer: prefer,
      ...(init.headers as Record<string, string> ?? {}),
    },
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
}
const one = async (path: string) => ((await db(path)) ?? [])[0] ?? null;

async function getState(chat: number): Promise<Record<string, any>> {
  const row = await one(`tg_state?chat_id=eq.${chat}&select=data`);
  return (row && row.data) || {};
}
async function setState(chat: number, data: Record<string, unknown>) {
  await db("tg_state?on_conflict=chat_id", {
    method: "POST",
    body: JSON.stringify({ chat_id: chat, data, updated_at: new Date().toISOString() }),
  }, "resolution=merge-duplicates,return=minimal");
}

/* التذكرة قد تصل بعد لحظات من فتح البوت — ننتظرها قليلاً */
async function takeTicket(code: string) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(code)) return null;
  for (let i = 0; i < 6; i++) {
    const t = await one(`tg_tickets?code=eq.${code}&select=*`);
    if (t) return t;
    await new Promise((r) => setTimeout(r, 800));
  }
  return null;
}

const when = (iso?: string | null) => {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("ar-IQ", {
      timeZone: "Asia/Baghdad", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit",
    });
  } catch { return iso; }
};
const vehName = (v: any) => (v ? `${v.kind === "bike" ? "🏍" : "🚗"} ${v.plate || ""}` : "مركبة");
const titleOf = (p: any) => (p.job_title && String(p.job_title).trim()) || ROLE_AR[p.role] || p.role || "";

/* ══ السائق: قائمة المهام التي تنتظر صورتها ══ */
async function startPhotos(chat: number, who: any, tk: any) {
  const trip = await one(`fleet_trips?id=eq.${tk.trip_id}&select=*`);
  if (!trip) return say(chat, "الرحلة غير موجودة.");
  if (String(trip.driver_id) !== String(who.id))
    return say(chat, "هذه الرحلة ليست باسمك — افتح البوت من زرّ رحلتك في التطبيق.");
  const veh = await one(`fleet_vehicles?id=eq.${trip.vehicle_id}&select=id,plate,kind`);
  const tasks: any[] = (await db(
    `fleet_tasks?vehicle_id=eq.${trip.vehicle_id}&active=eq.true&select=id,title,phase,sort&order=sort.asc,id.asc`,
  )) ?? [];
  const have = new Set(((await db(`fleet_task_proofs?trip_id=eq.${trip.id}&select=task_id`)) ?? [])
    .map((x: any) => String(x.task_id)));

  let phase = tk.phase as string | null;
  if (tk.action === "k") phase = (tasks.find((t) => String(t.id) === String(tk.task_id)) || {}).phase || phase;
  const ofPhase = tasks.filter((t) => !phase || t.phase === phase);

  let queue: any[];
  if (tk.action === "k") {
    const first = ofPhase.find((t) => String(t.id) === String(tk.task_id));
    queue = (first ? [first] : []).concat(ofPhase.filter((t) => t !== first && !have.has(String(t.id))));
  } else {
    queue = ofPhase.filter((t) => !have.has(String(t.id)));
    if (!queue.length) queue = ofPhase;
  }
  if (!queue.length) return say(chat, "لا توجد مهام تحتاج صورة في هذه الرحلة.");

  const job = {
    mode: "photo", trip: trip.id, vehicle: trip.vehicle_id, driver: String(who.id),
    plate: vehName(veh), queue: queue.map((t) => ({ id: t.id, title: t.title })), i: 0,
  };
  await setState(chat, { who, job });
  await say(chat,
    `أهلاً ${who.name || ""} 👋\n${job.plate} — ${phase === "in" ? "مهام التسليم" : "مهام الاستلام"}\n\n` +
    `📷 أرسل صورة أو فيديو: «${job.queue[0].title}» (1/${job.queue.length})\n` +
    `يمكنك إرسال عدة صور وفيديوهات دفعة واحدة، وتُحسب كلها لنفس المهمة.`);
}

async function gotPhoto(chat: number, st: any, fileRef: string, album?: string) {
  const job = st.job;
  if (!job || job.mode !== "photo")
    return say(chat, "افتح البوت من زرّ «📷 تصوير عبر تلجرام» في التطبيق أولاً.");
  /* بقية الألبوم نفسه: تُحفظ لنفس المهمة بصمت، بلا تقدّم ولا رسالة لكل عنصر */
  const sameAlbum = !!album && job.album === album;
  const i = sameAlbum ? job.albumI : Math.min(job.i, job.queue.length - 1);
  const task = job.queue[i];
  await db("fleet_task_proofs", {
    method: "POST",
    body: JSON.stringify({
      trip_id: job.trip, task_id: task.id, vehicle_id: job.vehicle, driver_id: job.driver,
      storage_path: fileRef, url: null, created_at: new Date().toISOString(),
    }),
  }, "return=minimal");
  if (sameAlbum) return;
  if (album) { job.album = album; job.albumI = i; } else { delete job.album; delete job.albumI; }
  job.i = i + 1;
  await setState(chat, { ...st, job });
  const again = { reply_markup: { inline_keyboard: [[{ text: "➕ صورة أو فيديو آخر لنفس المهمة", callback_data: "again" }]] } };
  if (job.i < job.queue.length) {
    return say(chat, `✓ حُفظت «${task.title}»\n\n📷 التالي: «${job.queue[job.i].title}» (${job.i + 1}/${job.queue.length})`, again);
  }
  return say(chat, `✓ حُفظت «${task.title}»\n\n🎉 اكتملت صور هذه المهام.\nارجع للتطبيق واضغط «تم إكمال المهمة» لكل مهمة.`, again);
}

/* ══ المدقّق: كل صور الرحلة مرتّبة بمهامها ══ */
async function sendTrip(chat: number, who: any, tripId: number) {
  const trip = await one(`fleet_trips?id=eq.${tripId}&select=*`);
  if (!trip) return say(chat, "الرحلة غير موجودة.");
  const veh = await one(`fleet_vehicles?id=eq.${trip.vehicle_id}&select=plate,kind`);
  const tasks: any[] = (await db(
    `fleet_tasks?vehicle_id=eq.${trip.vehicle_id}&select=id,title,phase,sort,active&order=phase.desc,sort.asc,id.asc`,
  )) ?? [];
  const proofs: any[] = (await db(
    `fleet_task_proofs?trip_id=eq.${trip.id}&select=task_id,storage_path&order=created_at.asc`,
  )) ?? [];

  await say(chat,
    `🔎 مرحباً ${who.name || ""} (${titleOf(who)})\n\n` +
    `رحلة ${vehName(veh)}\nالسائق: ${trip.driver_name || "—"}\n` +
    `الاستلام: ${when(trip.out_at)}\nالتسليم: ${trip.in_at ? when(trip.in_at) : "لم تُرجَع بعد"}` +
    (trip.note ? `\n📝 ${trip.note}` : ""));

  const missing: string[] = [];
  for (const t of tasks) {
    const refs = proofs.filter((p) => String(p.task_id) === String(t.id)).map((p) => String(p.storage_path || ""));
    /* الصور والفيديوهات تُخلط في ألبوم واحد (١٠ عناصر كحدّ أقصى لكل ألبوم) */
    const media = refs.flatMap((r) =>
      r.startsWith("tg:") ? [{ type: "photo", media: r.slice(3) }]
      : r.startsWith("tgv:") ? [{ type: "video", media: r.slice(4) }]
      : []);
    const notes = refs.filter((r) => r.startsWith("tgn:")).map((r) => r.slice(4));
    const docs = refs.filter((r) => r.startsWith("tgd:")).map((r) => r.slice(4));
    const label = `«${t.title}» — ${t.phase === "in" ? "تسليم" : "استلام"}`;
    if (!media.length && !notes.length && !docs.length) { if (t.active !== false) missing.push(label); continue; }
    for (let k = 0; k < media.length; k += 10) {
      const chunk = media.slice(k, k + 10);
      if (chunk.length === 1) {
        const x = chunk[0];
        if (x.type === "video") await tg("sendVideo", { chat_id: chat, video: x.media, caption: label });
        else await tg("sendPhoto", { chat_id: chat, photo: x.media, caption: label });
      } else await tg("sendMediaGroup", {
        chat_id: chat,
        media: chunk.map((x, n) => ({ ...x, ...(n === 0 ? { caption: label } : {}) })),
      });
    }
    /* الفيديو الدائري لا يقبل عنواناً ولا يدخل الألبوم — نسبقه باسم المهمة */
    if (notes.length) {
      if (!media.length) await say(chat, `🎥 ${label}`);
      for (const v of notes) await tg("sendVideoNote", { chat_id: chat, video_note: v });
    }
    for (const d of docs) await tg("sendDocument", { chat_id: chat, document: d, caption: label });
  }

  let tail = missing.length ? `⚠️ بلا صورة أو فيديو (${missing.length}):\n• ` + missing.join("\n• ") : "✓ كل المهام لها صور أو فيديو";
  if (trip.audited_at) {
    tail += `\n\n🔎 مدقّقة مسبقاً بواسطة ${[trip.audited_title, trip.audited_name].filter(Boolean).join(" — ")}`;
    return say(chat, tail);
  }
  return say(chat, tail, {
    reply_markup: { inline_keyboard: [[{ text: "✓ الرحلة سليمة — تدقيق", callback_data: `au:${trip.id}` }]] },
  });
}

/* ══ تتبّع الموقع المباشر للسائق ══
   السائق يفتح البوت من زرّ «📍 شارك موقعك المباشر» في رحلته، ثم يشارك «موقعي المباشر»
   في المحادثة. تلجرام يرسل التحديثات (edited_message) حتى والشاشة مطفأة، والبوت يخزّن
   نقطة لكل تحرّك يتجاوز ٢٥ متراً، ونقطةً كل دقيقة إن بقي في مكانه — فتُحسب الوقفات
   في التطبيق من هذه النقاط. */
/* 25 م لا 10: أقل من نصف قطر الوقفة (30 م) فلا تضيع وقفة، ويقلّ التخزين وقت القيادة للنصف تقريباً */
const GPS_MOVE_M = 25;
const GPS_STILL_MS = 60000;
function distM(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

async function openTripOf(driverId: string, prefer?: number | null) {
  if (prefer) {
    const t = await one(`fleet_trips?id=eq.${prefer}&select=id,driver_id,in_at`);
    if (t && !t.in_at && String(t.driver_id) === String(driverId)) return t;
  }
  return await one(`fleet_trips?driver_id=eq.${encodeURIComponent(driverId)}&in_at=is.null&select=id,driver_id,in_at&order=out_at.desc&limit=1`);
}

async function startGps(chat: number, who: any, tk: any) {
  const trip = await openTripOf(String(who.id), tk.trip_id);
  if (!trip) return say(chat, "لا توجد رحلة مفتوحة باسمك — استلم المركبة في التطبيق أولاً.");
  const st = await getState(chat);
  await setState(chat, { ...st, who, gps_trip: trip.id });
  return say(chat,
    `📍 تتبّع الرحلة\n\nشارك موقعك المباشر الآن:\n` +
    `١) اضغط 📎 (المرفقات) أسفل المحادثة\n٢) اختر «الموقع» (Location)\n` +
    `٣) اضغط «مشاركة موقعي المباشر» (Share My Live Location)\n٤) اختر أطول مدة (٨ ساعات)\n\n` +
    `بعدها ارجع للتطبيق — ستظهر مهام الاستلام. التتبع يستمر حتى والشاشة مطفأة، وينتهي عند إرجاع المركبة.`);
}

async function gotLocation(chat: number, st: any, m: any, edited: boolean) {
  const who = st.who;
  if (!who) {
    if (!edited) await say(chat, "افتح البوت من زرّ «📍 شارك موقعك المباشر» في رحلتك بالتطبيق أولاً.");
    return;
  }
  const loc = m.location;
  /* الموقع الثابت (مرة واحدة) لا يُعدّ تتبّعاً — التطبيق يفتح المهام عند أول نقطة مخزّنة */
  if (!edited && !loc.live_period) {
    return say(chat, "هذا موقعك الحالي فقط — المطلوب «الموقع المباشر».\n" +
      "اضغط 📎 ← «الموقع» ← «مشاركة موقعي المباشر» (Share My Live Location) ← ٨ ساعات.");
  }
  const pt = { lat: Number(loc.latitude), lng: Number(loc.longitude) };
  const at = new Date(((edited && m.edit_date) || m.date) * 1000);
  /* أغلب التحديثات تكرار لنفس المكان: نقارن بآخر نقطة محفوظة في حالة المحادثة
     ونخرج فوراً بلا أي طلب آخر للقاعدة — هذا أكبر توفير في الاستهلاك */
  const L = st.gps_last;
  if (edited && L && st.gps_trip &&
      distM(L, pt) <= GPS_MOVE_M && at.getTime() - Number(L.at) < GPS_STILL_MS) return;
  const trip = await openTripOf(String(who.id), st.gps_trip);
  if (!trip) {
    /* انتهت الرحلة (سُلّمت المركبة): يتوقف التسجيل، ونطلب من السائق إيقاف المشاركة مرة واحدة */
    if (st.gps_trip) {
      await setState(chat, { ...st, gps_trip: null, gps_last: null });
      return say(chat, "✓ انتهت رحلتك وتوقّف تسجيل موقعك.\n" +
        "أوقف مشاركة الموقع الآن: اضغط على رسالة «الموقع المباشر» في المحادثة ← «إيقاف المشاركة» (Stop Sharing).");
    }
    if (!edited) await say(chat, "لا توجد رحلة مفتوحة باسمك — الموقع لم يُسجَّل.");
    return;
  }
  /* نقطة عند تحرّك فعلي (أكثر من 25 م)، وإلا واحدة كل دقيقة — والمقارنة بما في الحالة لا بقراءة من القاعدة */
  await db("fleet_gps", {
    method: "POST",
    body: JSON.stringify({
      trip_id: trip.id, driver_id: String(who.id), lat: pt.lat, lng: pt.lng,
      acc: loc.horizontal_accuracy ?? null, at: at.toISOString(),
    }),
  }, "return=minimal");
  await setState(chat, { ...st, gps_trip: trip.id, gps_last: { lat: pt.lat, lng: pt.lng, at: at.getTime() } });
  try { await checkStop(chat, who, trip.id, { ...pt, at: at.getTime() }); } catch (e) { console.error("checkStop", e); }
  if (edited) return;
  return say(chat, "✓ بدأ تتبّع رحلتك — ارجع للتطبيق، ستظهر مهام الاستلام.\n" +
    "يستمر حتى والشاشة مطفأة، وينتهي تلقائياً عند إرجاع المركبة.");
}

/* ══ سبب الوقفة — يُسأل السائق في وقتها ══
   نفس قاعدة التطبيق: نقاط متتالية ضمن ٣٠ متراً من مركزها = وقفة، وأكثر من ٥ دقائق تُسأل.
   تُسأل الوقفة الجارية حين تبلغ ٥ دقائق، والتي انتهت للتو إن لم تُسأل (حين لا يصل تحديث
   والسائق واقف). كل وقفة تُسأل مرة واحدة: صفّها في fleet_stop_reasons هو علامة السؤال. */
const STOP_MS = 5 * 60000;
/* نصف قطر الوقفة 30 م (مثل التطبيق): الموقع وهو واقف يتذبذب 15–40 م، وبـ10 م لا تُكتشف وقفة.
   والنقاط ضعيفة الدقة (أكثر من 100 م) لا تُعتمد */
const STOP_R_M = 30;
const BAD_ACC_M = 100;
const STOP_REASONS: Record<string, string> = {
  t: "🚦 إشارة مرور", j: "🚗 زحام", d: "📦 تسليم/استلام طلب", f: "⛽ وقود",
  z: "🛢 تبديل زيت", m: "🔧 تصليح", r: "☕ استراحة", o: "✏️ أخرى",
};
function stopClusters(pts: { lat: number; lng: number; at: number }[]) {
  const out: { lat: number; lng: number; from: number; last: number; end: number; closed: boolean }[] = [];
  let i = 0;
  while (i < pts.length) {
    let c = { lat: pts[i].lat, lng: pts[i].lng }, n = 1, j = i + 1;
    while (j < pts.length && distM(c, pts[j]) <= STOP_R_M) {
      n++; c = { lat: c.lat + (pts[j].lat - c.lat) / n, lng: c.lng + (pts[j].lng - c.lng) / n }; j++;
    }
    const closed = j < pts.length;
    out.push({ ...c, from: pts[i].at, last: pts[j - 1].at, end: closed ? pts[j].at : pts[j - 1].at, closed });
    i = j;
  }
  return out;
}
const hmB = (ms: number) => {
  try { return new Date(ms).toLocaleTimeString("ar-IQ", { timeZone: "Asia/Baghdad", hour: "numeric", minute: "2-digit" }); }
  catch { return ""; }
};
async function checkStop(chat: number, who: any, tripId: number, cur: { lat: number; lng: number; at: number }) {
  const rows: any[] = (await db(`fleet_gps?trip_id=eq.${tripId}&select=lat,lng,at,acc&order=at.desc&limit=200`)) ?? [];
  const pts = rows.reverse().filter((r) => !(Number(r.acc) > BAD_ACC_M))
    .map((r) => ({ lat: Number(r.lat), lng: Number(r.lng), at: new Date(r.at).getTime() }));
  if (!pts.length || pts[pts.length - 1].at < cur.at) pts.push(cur);
  const cl = stopClusters(pts).slice(-2);
  const due = cl.filter((c) => c.end - c.from >= STOP_MS);
  if (!due.length) return;
  const asked = new Set(((await db(`fleet_stop_reasons?trip_id=eq.${tripId}&select=from_s`)) ?? [])
    .map((r: any) => String(r.from_s)));
  for (const c of due) {
    const fromS = Math.floor(c.from / 1000);
    if (asked.has(String(fromS))) continue;
    await db("fleet_stop_reasons?on_conflict=trip_id,from_s", {
      method: "POST",
      body: JSON.stringify({
        trip_id: tripId, from_s: fromS, from_at: new Date(c.from).toISOString(),
        lat: c.lat, lng: c.lng, driver_id: String(who.id),
      }),
    }, "resolution=ignore-duplicates,return=minimal");
    const mins = Math.round((c.end - c.from) / 60000);
    const keys = Object.keys(STOP_REASONS);
    const kb = [];
    for (let k = 0; k < keys.length; k += 2) {
      kb.push(keys.slice(k, k + 2).map((x) => ({ text: STOP_REASONS[x], callback_data: `sr:${tripId}:${fromS}:${x}` })));
    }
    await say(chat,
      (c.closed ? `⏸ توقفت ${mins} دقيقة عند ${hmB(c.from)}` : `⏸ أنت متوقف منذ ${hmB(c.from)} (أكثر من ٥ دقائق)`) +
      " — ما السبب؟", { reply_markup: { inline_keyboard: kb } });
  }
}
async function saveStopReason(tripId: string, fromS: string, reason: string) {
  await db(`fleet_stop_reasons?trip_id=eq.${tripId}&from_s=eq.${fromS}`, {
    method: "PATCH", body: JSON.stringify({ reason, answered_at: new Date().toISOString() }),
  }, "return=minimal");
}

/* ══ التحقق من صور كاميرا الأماني ══
   المسؤول (مدير المبيعات أو أحد مسؤولي التوصيل) يرسل الصورة للبوت، فيقرأ البوت رمز QR من
   شريطها السفلي، ويعيد حساب رمز التحقق بالمفتاح السرّي، ويردّ بالنتيجة واسم المصوِّر. */
const CAM_ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
async function camSign(text: string) {
  const raw = new Uint8Array((CAM_KEY.match(/../g) || []).map((h) => parseInt(h, 16)));
  const key = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text)));
  let o = ""; for (let i = 0; i < 8; i++) o += CAM_ALPHA[mac[i] % 32];
  return o;
}
function camUser(id: string) {
  let h = 2166136261; for (const ch of String(id)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  let o = ""; for (let i = 0; i < 4; i++) { o += CAM_ALPHA[h % 32]; h = Math.floor(h / 32); }
  return o;
}
/* من يرسل؟ من حالة المحادثة، وإلا من آخر تذكرة فتح بها البوت من التطبيق */
async function whoOf(st: any, fromId: number) {
  if (st.who) return st.who;
  const t = await one(`tg_tickets?tg_user=eq.${fromId}&select=profile_id&order=used_at.desc&limit=1`);
  if (!t) return null;
  const p = await one(`profiles?id=eq.${t.profile_id}&select=id,name,role,job_title`);
  return p ? { id: p.id, name: p.name, role: p.role, job_title: p.job_title } : null;
}
async function verifyCamPhoto(chat: number, fileId: string) {
  if (!CAM_KEY) return say(chat, "⚠️ مفتاح الكاميرا CAM_KEY غير مضبوط في أسرار الدالة — أضفه من Edge Functions ← Secrets.");
  await tg("sendChatAction", { chat_id: chat, action: "typing" });
  const f = await tg("getFile", { file_id: fileId });
  if (!f.ok) return say(chat, "تعذّر تنزيل الصورة من تلجرام.");
  const bin = new Uint8Array(await (await fetch(`https://api.telegram.org/file/bot${TOKEN}/${f.result.file_path}`)).arrayBuffer());
  let img: any;
  try { img = jpeg.decode(bin, { useTArray: true, maxMemoryUsageInMB: 256 }); }
  catch { return say(chat, "❌ هذه ليست صورة JPG من كاميرا الأماني."); }
  const rgba = new Uint8ClampedArray(img.data.buffer, img.data.byteOffset, img.data.byteLength);
  /* الرمز في الربع السفلي: نبحث فيه أولاً (أسرع وأدق)، ثم في الصورة كلها */
  let qr: any = null;
  const top = Math.floor(img.height * 0.7);
  const part = rgba.subarray(top * img.width * 4);
  qr = jsQR(part, img.width, img.height - top) || jsQR(rgba, img.width, img.height);
  if (!qr) {
    return say(chat, "❌ لا يوجد رمز تحقق مقروء في هذه الصورة.

إمّا أنها ليست من كاميرا الأماني، أو أن الشريط السفلي قُصّ أو غُطّي، أو أن الصورة صغيرة جداً — جرّب إرسالها «كملف» بدل صورة.");
  }
  const parts = String(qr.data).split("|");
  if (parts.length !== 5 || parts[0] !== "AMANI1") return say(chat, "❌ الرمز في الصورة ليس رمز كاميرا الأماني.");
  const [, id, when, uc, code] = parts;
  const ok = (await camSign([id, when, uc].join("|"))) === code;
  /* اسم المصوِّر: نبحث عن الحساب الذي يعطي هذا الرمز */
  let name = "";
  try {
    const ps: any[] = (await db("profiles?select=id,name")) ?? [];
    const m = ps.find((p) => camUser(p.id) === uc); if (m) name = m.name || "";
  } catch { /* الاسم اختياري */ }
  if (!ok) {
    return say(chat, "❌ الصورة مزوّرة أو معدّلة

البيانات المكتوبة على الصورة لا تطابق رمزها السرّي — غُيّر التاريخ أو الوقت أو الرقم، أو صُنعت خارج التطبيق.");
  }
  return say(chat,
    `✅ صورة أصلية من كاميرا الأماني

` +
    `📅 التُقطت: ${when}
👤 المصوِّر: ${name || "غير معروف"} (${uc})
🔢 رقم الصورة: ${id}

` +
    `ملاحظة: الرمز يضمن صحة الوقت والمصوِّر ورقم الصورة. تعديل محتوى الصورة نفسها لا يمكن كشفه بدون النسخة الأصلية.`);
}

/* ══ الرسائل ══ */
async function onMessage(m: any) {
  const chat = m.chat?.id;
  if (!chat || m.chat.type !== "private") return;
  const text: string = m.text || "";

  if (text.startsWith("/start")) {
    const code = text.split(/\s+/)[1] || "";
    if (!code) return say(chat, "أهلاً 👋\nهذا البوت يُفتح من أزرار التصوير والتدقيق داخل تطبيق الأماني.");
    const tk = await takeTicket(code);
    if (!tk) return say(chat, "الرابط غير صالح أو لم يُفعَّل بعد — ارجع للتطبيق واضغط الزر مرة أخرى.");
    if (tk.used_at) return say(chat, "هذا الرابط استُعمل مسبقاً — اضغط الزر في التطبيق مرة أخرى.");
    if (Date.now() - new Date(tk.created_at).getTime() > TICKET_TTL_MIN * 60000)
      return say(chat, "انتهت صلاحية الرابط — اضغط الزر في التطبيق مرة أخرى.");
    await db(`tg_tickets?code=eq.${code}`, {
      method: "PATCH", body: JSON.stringify({ used_at: new Date().toISOString(), tg_user: m.from?.id ?? null }),
    }, "return=minimal");

    const p = await one(`profiles?id=eq.${tk.profile_id}&select=id,name,role,job_title,removed`);
    if (!p || p.removed) return say(chat, "الحساب غير موجود أو موقوف.");
    const who = { id: p.id, name: p.name, role: p.role, job_title: p.job_title };

    if (tk.action === "a") {
      if (!REVIEWERS.includes(p.role)) return say(chat, "التدقيق لمسؤولي التوصيل ومدير المبيعات فقط.");
      await setState(chat, { who });
      if (!tk.trip_id) return say(chat, `🔍 أهلاً ${who.name || ""}

أرسل هنا أي صورة من كاميرا الأماني (أو حوّلها من محادثة أخرى) وسأتحقق منها فوراً.`);
      return sendTrip(chat, who, tk.trip_id);
    }
    if (tk.action === "g") return startGps(chat, who, tk);
    return startPhotos(chat, who, tk);
  }

  const st = await getState(chat);
  if (m.location) return gotLocation(chat, st, m, false);
  if (st.await_reason && text && !text.startsWith("/")) {
    const ar = st.await_reason;
    await saveStopReason(String(ar.trip), String(ar.from), text.trim().slice(0, 200));
    await setState(chat, { ...st, await_reason: null });
    return say(chat, `✓ سُجّل سبب الوقفة: ${text.trim().slice(0, 200)}`);
  }
  const album = m.media_group_id ? String(m.media_group_id) : undefined;
  /* صورة من مسؤول (لا من سائق في مهمة تصوير) = طلب تحقق */
  const isImg = (m.photo && m.photo.length) || (m.document && /^image\/jpe?g$/.test(String(m.document.mime_type || "")));
  if (isImg && !(st.job && st.job.mode === "photo")) {
    const who = await whoOf(st, m.from?.id);
    if (who && REVIEWERS.includes(who.role)) {
      const fid = m.photo && m.photo.length ? m.photo[m.photo.length - 1].file_id : m.document.file_id;
      try { return await verifyCamPhoto(chat, fid); }
      catch (e) { console.error("verify", e); return say(chat, "تعذّر فحص الصورة — حاول مرة أخرى."); }
    }
  }
  if (m.photo && m.photo.length) return gotPhoto(chat, st, "tg:" + m.photo[m.photo.length - 1].file_id, album);
  if (m.video) return gotPhoto(chat, st, "tgv:" + m.video.file_id, album);
  if (m.video_note) return gotPhoto(chat, st, "tgn:" + m.video_note.file_id, album);
  if (m.document && /^(image|video)\//.test(String(m.document.mime_type || "")))
    return gotPhoto(chat, st, "tgd:" + m.document.file_id, album);
  if (st.job && st.job.mode === "photo" && st.job.i < st.job.queue.length)
    return say(chat, `📷 أرسل صورة أو فيديو (وليس نصّاً): «${st.job.queue[st.job.i].title}»`);
  return say(chat, "استعمل أزرار التطبيق لفتح التصوير أو التدقيق.");
}

async function onCallback(q: any) {
  const chat = q.message?.chat?.id;
  const data: string = q.data || "";
  const st = chat ? await getState(chat) : {};

  if (data === "again" && st.job) {
    st.job.i = Math.max(0, st.job.i - 1);
    delete st.job.album; delete st.job.albumI;
    await setState(chat, st);
    await tg("answerCallbackQuery", { callback_query_id: q.id });
    return say(chat, `📷 أرسل صورة أو فيديو آخر: «${st.job.queue[st.job.i].title}»`);
  }

  if (data.startsWith("sr:")) {
    const [, tripId, fromS, code] = data.split(":");
    const trip = await one(`fleet_trips?id=eq.${tripId}&select=driver_id`);
    if (!trip || !st.who || String(trip.driver_id) !== String(st.who.id))
      return tg("answerCallbackQuery", { callback_query_id: q.id, text: "غير مسموح", show_alert: true });
    if (code === "o") {
      await setState(chat, { ...st, await_reason: { trip: tripId, from: fromS } });
      await tg("answerCallbackQuery", { callback_query_id: q.id });
      return say(chat, "✏️ اكتب سبب الوقفة في رسالة:");
    }
    const reason = STOP_REASONS[code] || code;
    await saveStopReason(tripId, fromS, reason);
    await tg("answerCallbackQuery", { callback_query_id: q.id, text: "✓ سُجّل السبب" });
    await tg("editMessageText", {
      chat_id: chat, message_id: q.message.message_id,
      text: (q.message.text || "") + `\n\n✓ السبب: ${reason}`,
    });
    /* تسليم طلب: تذكير الزبون بالتوقيع وكتابة الوقت على الفاتورة */
    if (code === "d") await say(chat, "✍️ تذكير: اطلب من الزبون التوقيع وكتابة الوقت على الفاتورة.");
    return;
  }

  if (data.startsWith("au:")) {
    const who = st.who;
    if (!who || !REVIEWERS.includes(who.role))
      return tg("answerCallbackQuery", { callback_query_id: q.id, text: "غير مسموح", show_alert: true });
    const tid = Number(data.slice(3));
    await db(`fleet_trips?id=eq.${tid}`, {
      method: "PATCH",
      body: JSON.stringify({
        audited_at: new Date().toISOString(), audited_by: String(who.id),
        audited_name: who.name || "", audited_title: titleOf(who),
      }),
    }, "return=minimal");
    await tg("answerCallbackQuery", { callback_query_id: q.id, text: "تم التدقيق ✓" });
    return tg("editMessageText", {
      chat_id: chat, message_id: q.message.message_id,
      text: (q.message.text || "") + `\n\n✅ دُقّقت الآن بواسطة ${titleOf(who)} — ${who.name || ""}`,
    });
  }
  return tg("answerCallbackQuery", { callback_query_id: q.id });
}

/* ══ نقطة الدخول ══ */
let SECRET = "";

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (!SECRET) SECRET = await hookSecret();
  if (req.method === "GET") {
    if (url.searchParams.get("setup") === "1") {
      if (!TOKEN) return Response.json({ ok: false, error: "BOT_TOKEN غير مضبوط في Secrets" });
      const hook = await tg("setWebhook", {
        url: FN_URL, secret_token: SECRET, allowed_updates: ["message", "edited_message", "callback_query"],
        drop_pending_updates: true,
        /* رسالة واحدة في كل مرة: عناصر الألبوم تصل متتابعة فلا تتسابق على حالة السائق */
        max_connections: 1,
      });
      const me = await tg("getMe", {});
      /* فحص ذاتي: يقول بالضبط ما الناقص إن وُجد */
      let tables = "ok";
      try { await db("tg_state?select=chat_id&limit=1"); await db("tg_tickets?select=code&limit=1"); }
      catch (e) { tables = "جدولا tg_state و tg_tickets غير موجودين — شغّل كود SQL أولاً (" + String(e).slice(0, 80) + ")"; }
      return Response.json({
        ok: !!hook.ok && tables === "ok", bot: me?.result?.username ?? null,
        webhook: hook.ok ? "ok" : hook, database: SB_KEY ? tables : "مفتاح الخدمة غير متاح للدالة",
      });
    }
    return new Response("tg-bot ok");
  }
  if (req.headers.get("x-telegram-bot-api-secret-token") !== SECRET)
    return new Response("forbidden", { status: 403 });
  try {
    const u = await req.json();
    if (u.message) await onMessage(u.message);
    else if (u.edited_message?.location && u.edited_message.chat?.type === "private") {
      /* تحديثات الموقع المباشر — تُخزَّن بصمت */
      const em = u.edited_message;
      await gotLocation(em.chat.id, await getState(em.chat.id), em, true);
    }
    else if (u.callback_query) await onCallback(u.callback_query);
  } catch (e) {
    console.error(e);
  }
  return new Response("ok");
});
