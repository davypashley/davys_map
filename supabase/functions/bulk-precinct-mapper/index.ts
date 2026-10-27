import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type InputRow = {
  row_id: number;
  address: string;
  city: string;
  state?: string;
  zip: string;
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" },
});

function firstGeography(geographies: Record<string, unknown>, startsWith: string) {
  const key = Object.keys(geographies || {}).find((name) => name.startsWith(startsWith));
  const rows = key ? geographies[key] : null;
  return Array.isArray(rows) ? rows[0] || null : null;
}

// Select the latest available geography by type, regardless of Census vintage.
function newestDistrictGeography(geographies: Record<string, unknown>, pattern: RegExp) {
  const candidates = Object.entries(geographies || {})
    .filter(([name, rows]) => pattern.test(name) && Array.isArray(rows) && rows.length > 0)
    .sort(([a], [b]) => Number(b.match(/^\d+/)?.[0] || 0) - Number(a.match(/^\d+/)?.[0] || 0));
  return candidates.length ? (candidates[0][1] as Record<string, unknown>[])[0] : null;
}

// Invalid or absent district numbers are blank rather than "0".
function districtNumber(geography: Record<string, unknown> | null, fields: string[]) {
  if (!geography) return "";
  for (const field of [...fields, "BASENAME"]) {
    const value = String(geography[field] ?? "").trim();
    if (/^\d+$/.test(value) && Number(value) > 0) return String(Number(value));
  }
  return "";
}

async function fetchJson(url: URL, attempts = 2) {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`Upstream ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 350));
    }
  }
  throw lastError;
}

async function matchRow(row: InputRow) {
  const source = { ...row };
  const state = String(row.state || "PA").trim().toUpperCase();
  const address = String(row.address || "").trim();
  const city = String(row.city || "").trim();
  const zip = String(row.zip || "").trim().slice(0, 10);
  const base = {
    ...source,
    normalized_address: "",
    normalized_city: city.toUpperCase(),
    normalized_state: state || "PA",
    normalized_zip: zip,
    match_status: "UNMATCHED",
    match_warning: "",
    county: "",
    municipality: "",
    precinct_name: "",
    precinct_geoid: "",
    pa_house_district: "",
    pa_senate_district: "",
    congressional_district: "",
    city_council_district: "",
    longitude: null as number | null,
    latitude: null as number | null,
    geocoder_source: "US_CENSUS",
    precinct_boundary_version: "2020-vtd",
  };

  if (!address || (!city && !zip)) return { ...base, match_warning: "Missing address plus city or ZIP." };
  if (state && !["PA", "PENNSYLVANIA"].includes(state)) return { ...base, match_warning: "Only Pennsylvania addresses are supported." };

  try {
    const geocodeUrl = new URL("https://geocoding.geo.census.gov/geocoder/geographies/address");
    geocodeUrl.search = new URLSearchParams({
      street: address,
      city,
      state: "PA",
      zip,
      benchmark: "Public_AR_Current",
      vintage: "Current_Current",
      format: "json",
    }).toString();
    const payload = await fetchJson(geocodeUrl);
    const matches = payload?.result?.addressMatches || [];
    if (!matches.length) return { ...base, match_warning: "No Census address match." };

    const match = matches[0];
    const geographies = match.geographies || {};
    const county = firstGeography(geographies, "Counties");
    const incorporated = firstGeography(geographies, "Incorporated Places");
    const subdivision = firstGeography(geographies, "County Subdivisions");
    const house = newestDistrictGeography(geographies, /^(?:\d{4}\s+)?State Legislative Districts\s*-\s*Lower$/i);
    const senate = newestDistrictGeography(geographies, /^(?:\d{4}\s+)?State Legislative Districts\s*-\s*Upper$/i);
    const congress = newestDistrictGeography(geographies, /^(?:\d+(?:st|nd|rd|th)\s+)?Congressional Districts$/i);
    const houseNumber = districtNumber(house, ["SLDL"]);
    const senateNumber = districtNumber(senate, ["SLDU"]);
    const congressionalFields = Object.keys(congress || {}).filter((key) => /^CD\d+$/i.test(key))
      .sort((a, b) => Number(b.slice(2)) - Number(a.slice(2)));
    const congressNumber = districtNumber(congress, congressionalFields);
    const longitude = Number(match.coordinates?.x);
    const latitude = Number(match.coordinates?.y);
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) {
      return { ...base, match_warning: "Address matched without usable coordinates." };
    }

    const vtdUrl = new URL("https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Census2020/MapServer/58/query");
    vtdUrl.search = new URLSearchParams({
      f: "json",
      where: "STATE='42'",
      geometry: JSON.stringify({ x: longitude, y: latitude, spatialReference: { wkid: 4326 } }),
      geometryType: "esriGeometryPoint",
      inSR: "4326",
      spatialRel: "esriSpatialRelIntersects",
      outFields: "STATE,COUNTY,VTD,GEOID,NAME,BASENAME",
      returnGeometry: "false",
    }).toString();
    const vtdPayload = await fetchJson(vtdUrl);
    const vtd = vtdPayload?.features?.[0]?.attributes || null;
    const components = match.addressComponents || {};
    const warnings: string[] = [];
    if (!vtd) warnings.push("Address matched, but no 2020 VTD contained the point.");
    if (!houseNumber) warnings.push("PA House district unavailable from Census.");
    if (!senateNumber) warnings.push("PA Senate district unavailable from Census.");
    if (!congressNumber) warnings.push("Congressional district unavailable from Census.");

    let councilDistrict = "";
    const isPhiladelphia = String(county?.GEOID || "") === "42101"
      || String(county?.BASENAME || county?.NAME || "").replace(/ County$/i, "").toLowerCase() === "philadelphia"
      || city.toLowerCase() === "philadelphia";
    if (isPhiladelphia) {
      try {
        const response = await fetch(new URL("/rest/v1/rpc/bulk_city_council_at_point", Deno.env.get("SUPABASE_URL")!), {
          method: "POST",
          headers: {
            apikey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
            Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ p_longitude: longitude, p_latitude: latitude }),
          signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) throw new Error("Council lookup failed");
        const districts = await response.json();
        if (Array.isArray(districts) && districts.length === 1 && /^(?:[1-9]|10)$/.test(String(districts[0]))) {
          councilDistrict = String(districts[0]);
        } else {
          warnings.push("Philadelphia City Council district could not be uniquely determined.");
        }
      } catch {
        warnings.push("Philadelphia City Council district lookup unavailable.");
      }
    }

    return {
      ...base,
      city_council_district: councilDistrict,
      normalized_address: String(match.matchedAddress || address).toUpperCase(),
      normalized_city: String(components.city || city).toUpperCase(),
      normalized_state: "PA",
      normalized_zip: String(components.zip || zip),
      match_status: vtd && houseNumber && senateNumber && congressNumber && (!isPhiladelphia || councilDistrict) ? "MATCHED" : "REVIEW",
      match_warning: warnings.join(" "),
      county: String(county?.BASENAME || county?.NAME || "").replace(/ County$/i, ""),
      municipality: String(incorporated?.BASENAME || subdivision?.BASENAME || incorporated?.NAME || subdivision?.NAME || "").replace(/ (city|borough|township|town)$/i, ""),
      precinct_name: String(vtd?.NAME || vtd?.BASENAME || ""),
      precinct_geoid: String(vtd?.GEOID || ""),
      pa_house_district: houseNumber,
      pa_senate_district: senateNumber,
      congressional_district: congressNumber,
      longitude,
      latitude,
    };
  } catch (error) {
    return { ...base, match_warning: error instanceof Error ? error.message : "Lookup failed." };
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);

  try {
    const body = await req.json();
    const rows: InputRow[] = Array.isArray(body?.rows) ? body.rows : [];
    if (!rows.length) return json({ error: "No rows supplied." }, 400);
    if (rows.length > 25) return json({ error: "Maximum 25 rows per request." }, 413);
    const results = [];
    for (let i = 0; i < rows.length; i += 5) {
      results.push(...await Promise.all(rows.slice(i, i + 5).map(matchRow)));
    }
    return json({ results });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Invalid request." }, 400);
  }
});
