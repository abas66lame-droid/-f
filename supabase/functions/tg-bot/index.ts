// ══════════════════════════════════════════════════════════════════
//  بوت تلجرام لصور التوصيل — tg-bot
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

const TOKEN  = Deno.env.get("BOT_TOKEN") ?? "";
const SB_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SB_SECRET") ?? "";
const FN_URL = SB_URL + "/functions/v1/tg-bot";

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
    `📷 أرسل صورة: «${job.queue[0].title}» (1/${job.queue.length})`);
}

async function gotPhoto(chat: number, st: any, fileRef: string) {
  const job = st.job;
  if (!job || job.mode !== "photo")
    return say(chat, "افتح البوت من زرّ «📷 تصوير عبر تلجرام» في التطبيق أولاً.");
  const i = Math.min(job.i, job.queue.length - 1);
  const task = job.queue[i];
  await db("fleet_task_proofs", {
    method: "POST",
    body: JSON.stringify({
      trip_id: job.trip, task_id: task.id, vehicle_id: job.vehicle, driver_id: job.driver,
      storage_path: fileRef, url: null, created_at: new Date().toISOString(),
    }),
  }, "return=minimal");
  job.i = i + 1;
  await setState(chat, { ...st, job });
  const again = { reply_markup: { inline_keyboard: [[{ text: "➕ صورة أخرى لنفس المهمة", callback_data: "again" }]] } };
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
    const photos = refs.filter((r) => r.startsWith("tg:")).map((r) => r.slice(3));
    const docs = refs.filter((r) => r.startsWith("tgd:")).map((r) => r.slice(4));
    const label = `«${t.title}» — ${t.phase === "in" ? "تسليم" : "استلام"}`;
    if (!photos.length && !docs.length) { if (t.active !== false) missing.push(label); continue; }
    for (let k = 0; k < photos.length; k += 10) {
      const chunk = photos.slice(k, k + 10);
      if (chunk.length === 1) await tg("sendPhoto", { chat_id: chat, photo: chunk[0], caption: label });
      else await tg("sendMediaGroup", {
        chat_id: chat,
        media: chunk.map((id, n) => ({ type: "photo", media: id, ...(n === 0 ? { caption: label } : {}) })),
      });
    }
    for (const d of docs) await tg("sendDocument", { chat_id: chat, document: d, caption: label });
  }

  let tail = missing.length ? `⚠️ بلا صورة (${missing.length}):\n• ` + missing.join("\n• ") : "✓ كل المهام لها صور";
  if (trip.audited_at) {
    tail += `\n\n🔎 مدقّقة مسبقاً بواسطة ${[trip.audited_title, trip.audited_name].filter(Boolean).join(" — ")}`;
    return say(chat, tail);
  }
  return say(chat, tail, {
    reply_markup: { inline_keyboard: [[{ text: "✓ الرحلة سليمة — تدقيق", callback_data: `au:${trip.id}` }]] },
  });
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
      return sendTrip(chat, who, tk.trip_id);
    }
    return startPhotos(chat, who, tk);
  }

  const st = await getState(chat);
  if (m.photo && m.photo.length) return gotPhoto(chat, st, "tg:" + m.photo[m.photo.length - 1].file_id);
  if (m.document && String(m.document.mime_type || "").startsWith("image/"))
    return gotPhoto(chat, st, "tgd:" + m.document.file_id);
  if (st.job && st.job.mode === "photo" && st.job.i < st.job.queue.length)
    return say(chat, `📷 أرسل صورة (وليس نصّاً): «${st.job.queue[st.job.i].title}»`);
  return say(chat, "استعمل أزرار التطبيق لفتح التصوير أو التدقيق.");
}

async function onCallback(q: any) {
  const chat = q.message?.chat?.id;
  const data: string = q.data || "";
  const st = chat ? await getState(chat) : {};

  if (data === "again" && st.job) {
    st.job.i = Math.max(0, st.job.i - 1);
    await setState(chat, st);
    await tg("answerCallbackQuery", { callback_query_id: q.id });
    return say(chat, `📷 أرسل صورة أخرى: «${st.job.queue[st.job.i].title}»`);
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
const SECRET = await hookSecret();

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (req.method === "GET") {
    if (url.searchParams.get("setup") === "1") {
      if (!TOKEN) return Response.json({ ok: false, error: "BOT_TOKEN غير مضبوط في Secrets" });
      const hook = await tg("setWebhook", {
        url: FN_URL, secret_token: SECRET, allowed_updates: ["message", "callback_query"],
        drop_pending_updates: true,
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
    else if (u.callback_query) await onCallback(u.callback_query);
  } catch (e) {
    console.error(e);
  }
  return new Response("ok");
});
