-- ══════════════════════════════════════════════════════════════════════
-- بيانات الرحلة التي يسجّلها السائق: عدد الفواتير، اسم المجهّز، وقت التجهيز
-- آمن إن شُغّل أكثر من مرة
-- ══════════════════════════════════════════════════════════════════════
alter table public.fleet_trips add column if not exists invoices int;
alter table public.fleet_trips add column if not exists preparer text;
alter table public.fleet_trips add column if not exists prep_at text;

select 'تم ✓ — أعمدة الفواتير والمجهّز جاهزة' as "النتيجة";
