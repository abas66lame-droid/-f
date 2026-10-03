-- ══════════════════════════════════════════════════════════════════════
-- موقع الشركة — يحفظه مسؤول تدقيق التوصيل في app_settings بالمفتاح company_geo
-- الكل يقرؤه (لحساب المغادرة والرجوع)، ومسؤول التدقيق وحده يكتبه
-- آمن إن شُغّل أكثر من مرة
-- ══════════════════════════════════════════════════════════════════════
drop policy if exists app_settings_geo_read on public.app_settings;
drop policy if exists app_settings_geo_ins on public.app_settings;
drop policy if exists app_settings_geo_upd on public.app_settings;
create policy app_settings_geo_read on public.app_settings for select to authenticated
  using (key = 'company_geo');
create policy app_settings_geo_ins on public.app_settings for insert to authenticated
  with check (key = 'company_geo' and exists (select 1 from public.profiles p
    where p.id::text = auth.uid()::text and p.role = 'fleet' and p.job_title like '%تدقيق%'));
create policy app_settings_geo_upd on public.app_settings for update to authenticated
  using (key = 'company_geo' and exists (select 1 from public.profiles p
    where p.id::text = auth.uid()::text and p.role = 'fleet' and p.job_title like '%تدقيق%'))
  with check (key = 'company_geo');

select 'تم ✓ — مسؤول التدقيق يستطيع حفظ موقع الشركة' as "النتيجة";
