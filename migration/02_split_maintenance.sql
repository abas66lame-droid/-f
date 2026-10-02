-- ══════════════════════════════════════════════════════════════════════
-- تقسيم الصيانة إلى «الصيانة صباحي» و«الصيانة مسائي» — يُشغَّل مرة واحدة
-- يُشغَّل في: Supabase ← المشروع الجديد ← SQL Editor ← Run
--
-- ١) يغيّر اسم قسم الصيانة الحالي إلى «الصيانة صباحي» (سجلاته تبقى كما هي)
-- ٢) ينشئ «الصيانة مسائي» نسخةً طبق الأصل من هيكله: المواقع، الموظفون، المهام،
--    الأجهزة، المعايير، الأقسام المخصّصة بأعمدتها وصفوفها، إعداداته، وترتيب العرض
--    — بلا أي سجل يومي، فلا علاقة لتسجيلات أحدهما بالآخر
-- ٣) يربط كل مسؤول بقسمه
-- كله في عملية واحدة: إن فشلت خطوة لم يتغيّر شيء أبداً.
-- ══════════════════════════════════════════════════════════════════════

/* يولّد معرّفاً جديداً لصف في جدول، بنفس طريقة الجدول نفسه */
create or replace function pg_temp.neo_newid(tbl text) returns text language plpgsql as $f$
declare e text;
begin
  select pg_get_expr(d.adbin, d.adrelid) into e
    from pg_attribute a join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
   where a.attrelid = ('public.' || tbl)::regclass and a.attname = 'id';
  if e is null then
    select case when a.attidentity <> '' then format('nextval(%L)', pg_get_serial_sequence('public.' || tbl, 'id'))
                when format_type(a.atttypid, null) = 'uuid' then 'gen_random_uuid()' end
      into e from pg_attribute a where a.attrelid = ('public.' || tbl)::regclass and a.attname = 'id';
  end if;
  if e is null then raise exception 'لا أعرف كيف أولّد معرّفاً لجدول %', tbl; end if;
  execute 'select (' || e || ')::text' into e;
  return e;
end $f$;

/* يبدّل كل معرّف قديم بمعرّفه الجديد داخل الصف كله (الأعمدة والإعدادات المخزّنة نصّاً) */
create or replace function pg_temp.neo_remap(t text) returns text language plpgsql as $f$
declare m record;
begin
  for m in select old, new from neo_map loop t := replace(t, m.old, m.new); end loop;
  return t;
end $f$;

do $$
declare
  m_mgr  text := 'b5e1ca7d-9c18-416d-a3da-5468f50d7953';   -- مسؤول الصباحي
  e_mgr  text := 'e9451a6b-69c5-4db7-a292-35bed6e3df45';   -- مسؤول المسائي
  m_name text := 'الصيانة صباحي';
  e_name text := 'الصيانة مسائي';
  /* بالترتيب: كل جدول بعد الجداول التي يشير إليها */
  tbls text[] := array['locations','staff_criteria','point_criteria','staff','daily_tasks','ipads',
    'serial_readers','laptops','ipad_reader_devices','pos_devices','section_groups','custom_sections',
    'custom_section_columns','custom_section_rows','custom_fields'];
  uuid_re text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  src text; dst text; n int; tbl text; cond text; r record; j text; ctype text; pass int;
begin
  if not exists (select 1 from public.profiles where id::text = m_mgr) then
    raise exception 'لم يُعثر على مسؤول الصباحي بالمعرّف %', m_mgr; end if;
  if not exists (select 1 from public.profiles where id::text = e_mgr) then
    raise exception 'لم يُعثر على مسؤول المسائي بالمعرّف %', e_mgr; end if;
  if exists (select 1 from public.departments where name = e_name) then
    raise exception 'قسم «%» موجود مسبقاً — لم يُنفَّذ شيء', e_name; end if;

  /* قسم الصيانة الحالي: الوحيد الذي في اسمه «صيان»، وإلا قسم مسؤول الصباحي */
  select count(*) into n from public.departments where name like '%صيان%';
  if n = 1 then
    select id::text into src from public.departments where name like '%صيان%';
  else
    select d.id::text into src from public.departments d, public.profiles p
     where p.id::text = m_mgr and d.id::text = (p.department_ids)[1]::text and d.name like '%صيان%';
  end if;
  if src is null then
    raise exception 'لم أحدّد قسم الصيانة: يوجد % قسم في اسمه «صيان»، ومسؤول الصباحي غير مربوط بأحدها', n; end if;
  if src !~ uuid_re then
    raise exception 'معرّفات الأقسام ليست UUID (%) — أخبر Claude', src; end if;

  create temp table neo_map (old text primary key, new text) on commit drop;

  /* القسم المسائي: نسخة من صف القسم نفسه باسم جديد */
  dst := pg_temp.neo_newid('departments');
  insert into neo_map values (src, dst);
  select to_jsonb(d)::text into j from public.departments d where id::text = src;
  j := (pg_temp.neo_remap(j)::jsonb || jsonb_build_object('name', e_name))::text;
  execute 'insert into public.departments overriding system value
           select * from jsonb_populate_record(null::public.departments, $1::jsonb)' using j;
  update public.departments set name = m_name where id::text = src;

  /* الجولة ١: معرّف جديد لكل صف · الجولة ٢: النسخ مع تبديل كل المعرّفات */
  for pass in 1..2 loop
    foreach tbl in array tbls loop
      continue when to_regclass('public.' || tbl) is null;
      cond := case
        when tbl in ('custom_section_columns','custom_section_rows') then
          format('section_id::text in (select id::text from public.custom_sections where department_id::text = %L)', src)
        when tbl = 'custom_fields' then
          /* الإجازات و«ليس في الشفت» سجلات يومية — لا تُنسخ */
          format('department_id::text = %L and name not like %L and name not like %L', src, '⟦leave⟧%', '⟦ns:%')
        else format('department_id::text = %L', src) end;
      if pass = 1 then
        for r in execute format('select id::text as id from public.%I where %s', tbl, cond) loop
          if r.id !~ uuid_re then raise exception 'معرّفات جدول % ليست UUID — أخبر Claude', tbl; end if;
          insert into neo_map values (r.id, pg_temp.neo_newid(tbl));
        end loop;
      else
        for r in execute format('select to_jsonb(t)::text as j from public.%I t where %s', tbl, cond) loop
          execute format('insert into public.%I overriding system value
                          select * from jsonb_populate_record(null::public.%I, $1::jsonb)', tbl, tbl)
            using pg_temp.neo_remap(r.j);
        end loop;
      end if;
    end loop;
  end loop;

  /* ترتيب العرض لكل مستخدم — ومسؤول المسائي يرث ترتيب مسؤول الصباحي */
  if to_regclass('public.user_prefs') is not null then
    for r in select to_jsonb(u) as j from public.user_prefs u where dept_id::text = src loop
      j := pg_temp.neo_remap(r.j::text);
      if r.j ? 'id' then j := (j::jsonb || jsonb_build_object('id', pg_temp.neo_newid('user_prefs')))::text; end if;
      execute 'insert into public.user_prefs select * from jsonb_populate_record(null::public.user_prefs, $1::jsonb)
               on conflict do nothing' using j;
      if r.j->>'user_id' = m_mgr then
        j := (j::jsonb || jsonb_build_object('user_id', e_mgr)
              || case when r.j ? 'id' then jsonb_build_object('id', pg_temp.neo_newid('user_prefs')) else '{}'::jsonb end)::text;
        execute 'insert into public.user_prefs select * from jsonb_populate_record(null::public.user_prefs, $1::jsonb)
                 on conflict do nothing' using j;
      end if;
    end loop;
  end if;

  /* ربط كل مسؤول بقسمه */
  select format_type(atttypid, atttypmod) into ctype from pg_attribute
   where attrelid = 'public.profiles'::regclass and attname = 'department_ids';
  execute format('update public.profiles set role = %L, department_ids = array[%L]::%s where id::text = %L',
                 'shift', src, ctype, m_mgr);
  execute format('update public.profiles set role = %L, department_ids = array[%L]::%s where id::text = %L',
                 'shift', dst, ctype, e_mgr);
end $$;

/* النتيجة: القسمان، مسؤولاهما، وعدد ما في كل منهما */
select d.name as "القسم",
       (select string_agg(p.name, '، ') from public.profiles p where d.id::text = any (p.department_ids::text[])) as "المسؤول",
       (select count(*) from public.staff s where s.department_id = d.id) as "الموظفون",
       (select count(*) from public.locations l where l.department_id = d.id) as "المواقع",
       (select count(*) from public.daily_tasks t where t.department_id = d.id) as "المهام"
  from public.departments d where d.name like '%صيان%' order by d.name;
