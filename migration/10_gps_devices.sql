-- ══════════════════════════════════════════════════════════════════════
-- أجهزة Traccar: ربط «معرّف الجهاز» في تطبيق Traccar Client بالسائق
-- الدالة gps-in لا تقبل إلا الأجهزة المسجّلة هنا، وتحفظ نقاطها في fleet_gps
-- أثناء رحلة السائق المفتوحة فقط — مثل موقع تلجرام تماماً.
-- يُشغَّل مرة واحدة — آمن إن شُغّل أكثر من مرة
-- ══════════════════════════════════════════════════════════════════════
create table if not exists public.fleet_gps_devices (
  device_id text primary key,       -- «معرّف الجهاز» كما يظهر في Traccar Client
  driver_id text not null,          -- profiles.id للسائق
  note text,
  created_at timestamptz default now()
);
alter table public.fleet_gps_devices enable row level security;
drop policy if exists fgd_all on public.fleet_gps_devices;
create policy fgd_all on public.fleet_gps_devices for all to authenticated
  using (exists (select 1 from public.profiles p where p.id::text = auth.uid()::text and p.role in ('fleet', 'sales', 'dev')))
  with check (exists (select 1 from public.profiles p where p.id::text = auth.uid()::text and p.role in ('fleet', 'sales', 'dev')));

/* شحن البطارية مع كل نقطة (من Traccar) — يبيّن إن كان الانقطاع بسبب نفاد البطارية */
alter table public.fleet_gps add column if not exists batt real;

select 'تم ✓ — جدول أجهزة Traccar جاهز' as "النتيجة";

-- ── تسجيل جهاز: غيّر الرقم والاسم ثم شغّل هذا السطر وحده ──
-- insert into public.fleet_gps_devices (device_id, driver_id, note)
--   select '34541113', id, name from public.profiles where name = 'اسم السائق كما في التطبيق'
--   on conflict (device_id) do update set driver_id = excluded.driver_id, note = excluded.note;
