create or replace function public.bulk_city_council_at_point(p_longitude double precision, p_latitude double precision)
returns jsonb language sql stable security invoker set search_path = '' as $$
select coalesce(jsonb_agg(distinct d.district_number), '[]'::jsonb)
from public.districts d
where d.district_type = 'city_council' and d.is_current = true
and p_longitude between -180 and 180 and p_latitude between -90 and 90
and extensions.st_covers(d.geom, extensions.st_setsrid(extensions.st_makepoint(p_longitude,p_latitude),4326));
$$;
revoke all on function public.bulk_city_council_at_point(double precision,double precision) from public,anon,authenticated;
grant execute on function public.bulk_city_council_at_point(double precision,double precision) to service_role;