-- ══════════════════════════════════════════════════════════════════════
-- تنبيهات السائقين: يسمح لتذاكر البوت بالنوع الجديد 'n' (زرّ «🚨 تنبيه للمسؤولين» في التطبيق)
-- يُشغَّل مرة واحدة — آمن إن شُغّل أكثر من مرة
-- ══════════════════════════════════════════════════════════════════════
do $$
declare c record;
begin
  for c in select conname from pg_constraint
            where conrelid = 'public.tg_tickets'::regclass and contype = 'c'
              and pg_get_constraintdef(oid) ilike '%action%' loop
    execute format('alter table public.tg_tickets drop constraint %I', c.conname);
  end loop;
  alter table public.tg_tickets add constraint tg_tickets_action_check
    check (action in ('k', 'd', 'a', 'g', 'n'));
end $$;

select 'تم ✓ — زرّ التنبيه جاهز' as "النتيجة";
