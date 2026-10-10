-- ══════════════════════════════════════════════════════════════════════
-- ١١) إغلاق الوصول بدون تسجيل دخول + حماية الصلاحيات
--
-- المشكلة: أغلب الجداول لها قاعدة «anon … true»، والمفتاح العام (anon) موجود
-- داخل صفحة التطبيق المنشورة — فأي شخص على الإنترنت، بلا حساب، يستطيع قراءة
-- وتعديل وحذف الرحلات والمركبات والموظفين والنقاط والإعدادات… وجدول الحسابات
-- يسمح لأي مستخدم مسجّل بتغيير دور أي حساب (سائق يجعل نفسه مديراً).
--
-- الإصلاح:
--  ١) كل قاعدة كانت لـ anon أو public تصير لـ authenticated فقط (المسجّلين).
--     التطبيق لا يقرأ شيئاً قبل تسجيل الدخول، والبوت ودوالّه تستعمل مفتاح الخدمة،
--     فلا يتأثر شيء يعمل. (نسخة من القواعد الأصلية تُحفظ للتراجع)
--  ٢) تعديل جدول الحسابات (الاسم، الدور، الأقسام) لمدير المبيعات والمطوّر فقط.
--
-- يُشغَّل مرة واحدة — آمن إن شُغّل أكثر من مرة. للتراجع: 11_rollback.sql
-- ══════════════════════════════════════════════════════════════════════

/* نسخة احتياطية للقواعد قبل تعديلها */
create table if not exists public._policy_backup_11 (
  tablename name, policyname name, roles name[], cmd text, qual text, with_check text,
  saved_at timestamptz default now(),
  primary key (tablename, policyname)
);
alter table public._policy_backup_11 enable row level security;   -- بلا قواعد: لا يقرؤها أحد من التطبيق
insert into public._policy_backup_11 (tablename, policyname, roles, cmd, qual, with_check)
  select tablename, policyname, roles, cmd, qual, with_check from pg_policies
   where schemaname = 'public'
     and ((roles && array['anon','public']::name[]) or (tablename = 'profiles' and cmd = 'UPDATE'))
  on conflict do nothing;

/* ١) anon / public ← authenticated */
do $$
declare r record;
begin
  for r in select tablename, policyname from pg_policies
            where schemaname = 'public' and (roles && array['anon','public']::name[]) loop
    execute format('alter policy %I on public.%I to authenticated', r.policyname, r.tablename);
  end loop;
end $$;

/* ٢) دور المستخدم الحالي — دالة بصلاحية النظام حتى لا تدور قواعد profiles على نفسها */
create or replace function public.my_role() returns text
  language sql stable security definer set search_path = public as $$
  select role from public.profiles where id::text = auth.uid()::text
$$;
revoke all on function public.my_role() from public, anon;
grant execute on function public.my_role() to authenticated;

do $$
declare r record;
begin
  for r in select policyname from pg_policies
            where schemaname = 'public' and tablename = 'profiles' and cmd = 'UPDATE' loop
    execute format('drop policy %I on public.profiles', r.policyname);
  end loop;
end $$;
create policy profiles_admin_update on public.profiles for update to authenticated
  using (public.my_role() in ('sales', 'dev'))
  with check (public.my_role() in ('sales', 'dev'));

/* ── التحقق: يجب أن يكون العدد الأول صفراً ── */
select
  (select count(*) from pg_policies where schemaname = 'public' and roles && array['anon','public']::name[])
    as "قواعد مفتوحة لغير المسجّلين (يجب 0)",
  (select count(*) from public._policy_backup_11) as "قواعد محفوظة للتراجع",
  (select string_agg(policyname || ' (' || cmd || ')', ', ') from pg_policies
    where schemaname = 'public' and tablename = 'profiles') as "قواعد جدول الحسابات الآن";
