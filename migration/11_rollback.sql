-- ══════════════════════════════════════════════════════════════════════
-- تراجع عن ١١ — يعيد القواعد كما كانت تماماً (من النسخة المحفوظة)
-- لا تشغّله إلا إن تعطّل شيء بعد ١١
-- ══════════════════════════════════════════════════════════════════════
do $$
declare r record;
begin
  drop policy if exists profiles_admin_update on public.profiles;
  for r in select * from public._policy_backup_11 loop
    if r.tablename = 'profiles' and r.cmd = 'UPDATE' then
      execute format('create policy %I on public.profiles for update to %s using (%s) with check (%s)',
        r.policyname, array_to_string(r.roles, ','), coalesce(r.qual, 'true'), coalesce(r.with_check, 'true'));
    else
      execute format('alter policy %I on public.%I to %s', r.policyname, r.tablename, array_to_string(r.roles, ','));
    end if;
  end loop;
end $$;
select 'تم التراجع ✓' as "النتيجة";
