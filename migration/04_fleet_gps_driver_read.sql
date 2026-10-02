-- ══════════════════════════════════════════════════════════════════════
-- يسمح للسائق برؤية نقاط موقعه هو فقط — ليعرف التطبيق أن موقعه المباشر وصل
-- فيفتح له مهام الاستلام. لا يرى مواقع غيره أبداً.
-- يُشغَّل مرة واحدة بعد 03_fleet_gps.sql
-- ══════════════════════════════════════════════════════════════════════
drop policy if exists fleet_gps_read_own on public.fleet_gps;
create policy fleet_gps_read_own on public.fleet_gps for select to authenticated
  using (driver_id = auth.uid()::text);

select 'تم ✓ — السائق يرى موقعه فقط' as "النتيجة";
