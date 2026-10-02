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

/* معرّف جديد لصف: بطريقة الجدول نفسه، وإلا على نمط المعرّف القديم (dept10 ← dept11) */
create or replace function pg_temp.neo_newid(tbl text, old text) returns text language plpgsql as $f$
declare e text; typ text; pre text; nxt bigint;
begin
  select pg_get_expr(d.adbin, d.adrelid) into e
    from pg_attribute a join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
   where a.attrelid = ('public.' || tbl)::regclass and a.attname = 'id';
  select format_type(a.atttypid, null),
         case when a.attidentity <> '' then pg_get_serial_sequence('public.' || tbl, 'id') end
    into typ, pre from pg_attribute a where a.attrelid = ('public.' || tbl)::regclass and a.attname = 'id';
  if e is null and pre is not null then e := format('nextval(%L)', pre); end if;
  if e is null and typ = 'uuid' then e := 'gen_random_uuid()'; end if;
  if e is not null then
    execute 'select (' || e || ')::text' into e;
    return e;
  end if;
  /* نصّ بلا قيمة افتراضية: نفس البادئة ورقم أكبر من كل ما هو موجود */
  pre := coalesce(substring(old from '^(.*?)\d+$'), old || '_');
  execute format('select coalesce(max(substring(id::text from %L)::bigint), 0) + 1 from public.%I where id::text ~ %L',
                 '^' || pre || '(\d+)$', tbl, '^' || pre || '\d+$') into nxt;
  select greatest(nxt, coalesce(max(substring(new from '^' || pre || '(\d+)$')::bigint), 0) + 1)
    into nxt from neo_map where neo_map.tbl = neo_newid.tbl and new ~ ('^' || pre || '\d+$');
  return pre || nxt;
end $f$;

/* أي جدول يشير إليه هذا العمود (department_id ← الأقسام ...) — المعرّفات الرقمية تتكرر بين الجداول */
create or replace function pg_temp.neo_fk(k text, own text) returns text language sql immutable as $f$
  select case k
    when 'id' then own when 'order_json' then own
    when 'department_id' then 'departments' when 'dept_id' then 'departments' when 'department_ids' then 'departments'
    when 'section_id' then 'custom_sections' when 'group_id' then 'section_groups'
    when 'location_id' then 'locations' when 'staff_id' then 'staff' when 'task_id' then 'daily_tasks'
    when 'criterion_id' then 'staff_criteria' when 'ipad_id' then 'ipads' when 'reader_id' then 'serial_readers'
    when 'laptop_id' then 'laptops' when 'device_id' then 'ipad_reader_devices' when 'pos_device_id' then 'pos_devices'
    when 'row_id' then 'custom_section_rows' when 'column_id' then 'custom_section_columns' end
$f$;

/* المعرّف الجديد: من جدوله إن عُرف، وإلا فقط إن كان المعرّف القديم لا يتكرر بين الجداول */
create or replace function pg_temp.neo_look(tb text, o text) returns text language plpgsql as $f$
declare nv text;
begin
  if tb is not null then
    select new into nv from neo_map where tbl = tb and old = o;
  else
    select max(new) into nv from neo_map where old = o having count(*) = 1;
  end if;
  return nv;
end $f$;

/* تبديل المعرّفات داخل نصّ (علامات الإعدادات مثل ⟦off⟧<معرّف>) — جولة واحدة لا تتسلسل */
create or replace function pg_temp.neo_tok(s text) returns text language plpgsql as $f$
declare out text := ''; p record; nv text; prev text; sep text;
begin
  for p in select m[1] as piece from regexp_matches(s, '([A-Za-z0-9-]+|[^A-Za-z0-9-]+)', 'g') as m loop
    if p.piece ~ '^[A-Za-z0-9-]+$' then
      /* «locations:12» — اسم الجدول قبل النقطتين يحدّد صاحب المعرّف */
      nv := case when sep = ':' and prev in (select distinct tbl from neo_map) then pg_temp.neo_look(prev, p.piece)
                 when sep = '_' and prev = 'extra' then pg_temp.neo_look('staff_criteria', p.piece)
                 else pg_temp.neo_look(null, p.piece) end;
      prev := p.piece;
    else
      nv := null; sep := p.piece;
    end if;
    out := out || coalesce(nv, p.piece);
  end loop;
  return out;
end $f$;

/* تبديل المعرّفات داخل صف كامل (JSON) — own: جدول الصف نفسه */
create or replace function pg_temp.neo_rj(v jsonb, k text, own text, numeric_ids boolean) returns jsonb language plpgsql as $f$
declare t text := jsonb_typeof(v); res jsonb; e record; s text; nv text; tb text := pg_temp.neo_fk(k, own);
begin
  if t = 'object' then
    res := '{}'::jsonb;
    for e in select * from jsonb_each(v) loop
      s := e.key;
      if not numeric_ids or s ~ '^[A-Za-z0-9_:|=,.⟦⟧-]*$' then s := pg_temp.neo_tok(s); end if;
      res := res || jsonb_build_object(s, pg_temp.neo_rj(e.value, e.key, own, numeric_ids));
    end loop;
    return res;
  elsif t = 'array' then
    select coalesce(jsonb_agg(pg_temp.neo_rj(x, k, own, numeric_ids) order by o), '[]'::jsonb)
      into res from jsonb_array_elements(v) with ordinality a(x, o);
    return res;
  elsif t = 'string' then
    s := v #>> '{}';
    nv := pg_temp.neo_look(tb, s);
    if nv is not null then return to_jsonb(nv); end if;
    if tb is not null then return v; end if;
    /* معرّفات رقمية: لا نلمس نصوص البشر (مثل «مولدة 5») — فقط العلامات والمفاتيح */
    if not numeric_ids or s like '⟦%' or s ~ '^[A-Za-z0-9_:|=,.-]*$' then return to_jsonb(pg_temp.neo_tok(s)); end if;
    return v;
  elsif t = 'number' and tb is not null then
    nv := pg_temp.neo_look(tb, v #>> '{}');
    if nv is not null then return to_jsonb(nv::numeric); end if;
  end if;
  return v;
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
  src text; dst text; n int; tbl text; cond text; r record; j jsonb; ctype text; pass int;
  e_dept text; num boolean;
begin
  if not exists (select 1 from public.profiles where id::text = m_mgr) then
    raise exception 'لم يُعثر على مسؤول الصباحي بالمعرّف %', m_mgr; end if;

  /* معرّف المسائي: مسؤول، أو حساب دخول بلا صف مسؤول، أو قسم أُنشئ مسبقاً */
  if not exists (select 1 from public.profiles where id::text = e_mgr) then
    if exists (select 1 from public.departments where id::text = e_mgr) then
      e_dept := e_mgr; e_mgr := null;
    elsif exists (select 1 from auth.users where id::text = e_mgr) then
      execute format('insert into public.profiles (id, name, role) values (%L, %L, %L)', e_mgr,
        (select coalesce(nullif(raw_user_meta_data->>'name', ''), split_part(email, '@', 1), 'مسؤول المسائي')
           from auth.users where id::text = e_mgr), 'shift');
    else
      raise exception 'المعرّف % ليس مسؤولاً ولا حساب دخول ولا قسماً — تأكد منه', e_mgr;
    end if;
  end if;
  if e_dept is null then
    select id::text into e_dept from public.departments where name = e_name;
  end if;
  if e_dept is not null and (
       exists (select 1 from public.staff where department_id::text = e_dept)
    or exists (select 1 from public.locations where department_id::text = e_dept)) then
    raise exception 'القسم المسائي موجود مسبقاً وفيه بيانات — لم يُنفَّذ شيء';
  end if;

  /* قسم الصيانة الحالي: الوحيد الذي في اسمه «صيان»، وإلا قسم مسؤول الصباحي */
  select count(*) into n from public.departments
   where name like '%صيان%' and id::text is distinct from e_dept;
  if n = 1 then
    select id::text into src from public.departments
     where name like '%صيان%' and id::text is distinct from e_dept;
  else
    select d.id::text into src from public.departments d, public.profiles p
     where p.id::text = m_mgr and d.id::text = (p.department_ids)[1]::text and d.name like '%صيان%';
  end if;
  if src is null then
    raise exception 'لم أحدّد قسم الصيانة: يوجد % قسم في اسمه «صيان»، ومسؤول الصباحي غير مربوط بأحدها', n; end if;

  create temp table neo_map (tbl text, old text, new text, primary key (tbl, old)) on commit drop;

  /* الجولة ١: معرّف جديد للقسم ولكل صف */
  if e_dept is not null then dst := e_dept; else dst := pg_temp.neo_newid('departments', src); end if;
  insert into neo_map values ('departments', src, dst);
  foreach tbl in array tbls loop
    continue when to_regclass('public.' || tbl) is null;
    cond := case
      when tbl in ('custom_section_columns','custom_section_rows') then
        format('section_id::text in (select id::text from public.custom_sections where department_id::text = %L)', src)
      when tbl = 'custom_fields' then
        /* الإجازات و«ليس في الشفت» سجلات يومية — لا تُنسخ */
        format('department_id::text = %L and name not like %L and name not like %L', src, '⟦leave⟧%', '⟦ns:%')
      else format('department_id::text = %L', src) end;
    for r in execute format('select id::text as id from public.%I where %s order by 1', tbl, cond) loop
      insert into neo_map values (tbl, r.id, pg_temp.neo_newid(tbl, r.id));
    end loop;
  end loop;
  num := exists (select 1 from neo_map where old ~ '^\d+$');
  /* مفاتيح الأعمدة المختصرة x_<أول ١٢ حرفاً من المعرّف بلا شرطات> */
  insert into neo_map
    select m.tbl || ':short', left(replace(m.old, '-', ''), 12), left(replace(m.new, '-', ''), 12)
      from neo_map m where m.old ~ '^[0-9a-f]{8}-[0-9a-f]{4}-' and m.new ~ '^[0-9a-f]{8}-[0-9a-f]{4}-'
    on conflict do nothing;

  /* القسم المسائي: الموجود الفارغ، أو نسخة من صف القسم نفسه */
  if e_dept is not null then
    update public.departments set name = e_name where id::text = dst;
  else
    select pg_temp.neo_rj(to_jsonb(d), '', 'departments', num) || jsonb_build_object('name', e_name) into j
      from public.departments d where id::text = src;
    execute 'insert into public.departments overriding system value
             select * from jsonb_populate_record(null::public.departments, $1)' using j;
  end if;
  update public.departments set name = m_name where id::text = src;

  /* الجولة ٢: النسخ مع تبديل كل المعرّفات */
  foreach tbl in array tbls loop
    continue when to_regclass('public.' || tbl) is null;
    cond := case
      when tbl in ('custom_section_columns','custom_section_rows') then
        format('section_id::text in (select id::text from public.custom_sections where department_id::text = %L)', src)
      when tbl = 'custom_fields' then
        format('department_id::text = %L and name not like %L and name not like %L', src, '⟦leave⟧%', '⟦ns:%')
      else format('department_id::text = %L', src) end;
    for r in execute format('select to_jsonb(t) as j from public.%I t where %s', tbl, cond) loop
      execute format('insert into public.%I overriding system value
                      select * from jsonb_populate_record(null::public.%I, $1)', tbl, tbl)
        using pg_temp.neo_rj(r.j, '', tbl, num);
    end loop;
  end loop;

  /* ترتيب العرض لكل مستخدم — ومسؤول المسائي يرث ترتيب مسؤول الصباحي */
  if to_regclass('public.user_prefs') is not null then
    for r in select to_jsonb(u) as j from public.user_prefs u where dept_id::text = src loop
      /* ترتيب كل نوع يشير إلى جدوله */
      j := pg_temp.neo_rj(r.j, '', case r.j->>'scope'
             when 'loc' then 'locations' when 'staff' then 'staff' when 'tasks' then 'daily_tasks'
             when 'ipad' then 'ipads' when 'reader' then 'serial_readers' when 'ipadreader' then 'ipad_reader_devices'
             when 'laptop' then 'laptops' when 'pos' then 'pos_devices' end, num);
      if r.j ? 'id' then j := j || jsonb_build_object('id', pg_temp.neo_newid('user_prefs', r.j->>'id')); end if;
      execute 'insert into public.user_prefs select * from jsonb_populate_record(null::public.user_prefs, $1)
               on conflict do nothing' using j;
      if r.j->>'user_id' = m_mgr and e_mgr is not null then
        j := j || jsonb_build_object('user_id', e_mgr);
        if r.j ? 'id' then j := j || jsonb_build_object('id', pg_temp.neo_newid('user_prefs', r.j->>'id')); end if;
        execute 'insert into public.user_prefs select * from jsonb_populate_record(null::public.user_prefs, $1)
                 on conflict do nothing' using j;
      end if;
    end loop;
  end if;

  /* ربط كل مسؤول بقسمه */
  select format_type(atttypid, atttypmod) into ctype from pg_attribute
   where attrelid = 'public.profiles'::regclass and attname = 'department_ids';
  execute format('update public.profiles set role = %L, department_ids = array[%L]::%s where id::text = %L',
                 'shift', src, ctype, m_mgr);
  if e_mgr is not null then
    execute format('update public.profiles set role = %L, department_ids = array[%L]::%s where id::text = %L',
                   'shift', dst, ctype, e_mgr);
  end if;
end $$;

/* النتيجة: القسمان، مسؤولاهما، وعدد ما في كل منهما */
select d.name as "القسم", d.id::text as "المعرّف",
       (select string_agg(p.name, '، ') from public.profiles p where d.id::text = any (p.department_ids::text[])) as "المسؤول",
       (select count(*) from public.staff s where s.department_id::text = d.id::text) as "الموظفون",
       (select count(*) from public.locations l where l.department_id::text = d.id::text) as "المواقع",
       (select count(*) from public.daily_tasks t where t.department_id::text = d.id::text) as "المهام"
  from public.departments d where d.name like '%صيان%' order by d.name;
