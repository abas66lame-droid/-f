-- ══════════════════════════════════════════════════════════════════════
-- تصدير دفعة من المشروع القديم (vedmymtutjqjtkyejdpk)
-- يُشغَّل في: Supabase ← المشروع القديم ← SQL Editor ← Run
-- لا يغيّر أي بيانات — يقرأ فقط.
--
-- غيّر التاريخين في آخر سطر فقط لكل دفعة:
--   البداية داخلة، والنهاية غير داخلة (بتوقيت بغداد)
--   الدفعة ١: '2026-08-25' → '2026-08-27'  (يوم 25 و 26)
--   الدفعة ٢: '2026-08-27' → '2026-08-29'  (يوم 27 و 28)
--   الدفعة ٣: '2026-08-29' → '2026-09-01'  (يوم 29 و 30 و 31)
-- الرقم الثالث (true/false): هل يُصدَّر معها جداول الهيكل التي بلا تاريخ
--   (الأقسام، الموظفين، المواقع...). اجعله true في الدفعة الأولى فقط.
-- ══════════════════════════════════════════════════════════════════════
create or replace function pg_temp.neo_export(p_from date, p_to date, p_static boolean)
returns jsonb language plpgsql as $$
declare
  r record; col text; typ text; expr text; j jsonb; n bigint;
  info jsonb := '{}'::jsonb; res jsonb := '{}'::jsonb;
begin
  for r in select c.relname::text as t
             from pg_class c join pg_namespace s on s.oid = c.relnamespace
            where s.nspname = 'public' and c.relkind in ('r','p')
            order by 1
  loop
    begin
      col := null; typ := null;
      select column_name::text, data_type::text into col, typ
        from information_schema.columns
       where table_schema = 'public' and table_name = r.t
         and column_name in ('log_date','date','created_at')
       order by array_position(array['log_date','date','created_at'], column_name::text)
       limit 1;

      if col is null then
        execute format('select count(*) from public.%I', r.t) into n;
        info := info || jsonb_build_object(r.t, jsonb_build_object('date_col', null, 'total', n));
        if p_static then
          execute format('select coalesce(jsonb_agg(to_jsonb(x)), ''[]'') from public.%I x', r.t) into j;
          res := res || jsonb_build_object(r.t, j);
        end if;
      else
        if typ like 'timestamp%' then
          expr := format('(x.%I::timestamptz at time zone ''Asia/Baghdad'')::date', col);
        elsif typ = 'date' then
          expr := format('x.%I', col);
        else  /* تاريخ مخزّن كنص 'YYYY-MM-DD' */
          expr := format('(case when left(x.%I::text,10) ~ ''^\d{4}-\d{2}-\d{2}$'' then left(x.%I::text,10)::date end)', col, col);
        end if;
        execute format('select count(*), coalesce(jsonb_agg(to_jsonb(x)), ''[]'') from public.%I x where %s >= $1 and %s < $2',
                       r.t, expr, expr)
          using p_from, p_to into n, j;
        info := info || jsonb_build_object(r.t, jsonb_build_object('date_col', col, 'rows', n));
        if n > 0 then res := res || jsonb_build_object(r.t, j); end if;
      end if;
    exception when others then
      info := info || jsonb_build_object(r.t, jsonb_build_object('error', sqlerrm));
    end;
  end loop;

  return jsonb_build_object('from', p_from, 'to', p_to, 'tables', info, 'data', res);
end $$;

select pg_temp.neo_export('2026-08-25', '2026-08-27', true) as result;
