// Nearby hospitals/clinics from OpenStreetMap (Overpass API), sorted by distance.

// Each public instance gets one attempt, keeping the total network wait at 20s.
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

async function queryOverpass(query) {
  let lastError;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        body: query,
        signal: AbortSignal.timeout(7000),
      });
      if (!res.ok) throw new Error(`Overpass error ${res.status}`);
      const data = await res.json();
      if (!Array.isArray(data.elements) || data.remark) {
        throw new Error("Overpass returned an incomplete response");
      }
      return data;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * @param {{lat:number,lng:number}} c  search centre
 * @param {number} radiusKm
 * @returns {Promise<Array<{place_id,name,address,phone,emergency,lat,lng,isHospital,rating,distKm}>>}
 */
/** Photon (Komoot, OpenStreetMap data) — used when every Overpass instance fails or blocks us. */
export async function fetchPhotonHospitals(c, radiusKm, fetchFn = fetch) {
  const seen = new Map();
  const url = new URL("https://photon.komoot.io/api/");
  const params = new URLSearchParams({ q: "hospital", lat: String(c.lat), lon: String(c.lng), limit: "50" });
  for (const tag of ["amenity:hospital", "amenity:clinic", "healthcare:hospital"]) params.append("osm_tag", tag);
  url.search = params.toString();
  const res = await fetchFn(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Photon error ${res.status}`);
  const data = await res.json();
  for (const f of data.features ?? []) {
    const [lng, lat] = f.geometry?.coordinates ?? [];
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const p = f.properties ?? {};
    const distKm = haversine(c.lat, c.lng, lat, lng);
    if (distKm > radiusKm) continue;
    const id = `${p.osm_type ?? ""}${p.osm_id ?? `${lat},${lng}`}`;
    if (seen.has(id)) continue;
    seen.set(id, {
      place_id: id,
      name: p.name || "Hospital",
      address: [p.housenumber, p.street, p.district || p.city].filter(Boolean).join(" "),
      phone: "",
      emergency: false,
      lat, lng,
      isHospital: p.osm_value === "hospital",
      rating: null,
      distKm,
    });
  }
  return [...seen.values()].sort((a, b) => a.distKm - b.distKm);
}

export async function fetchNearbyHospitals(c, radiusKm) {
  try {
    return await fetchOverpassHospitals(c, radiusKm);
  } catch (error) {
    try {
      return await fetchPhotonHospitals(c, radiusKm);
    } catch {
      throw error;
    }
  }
}

async function fetchOverpassHospitals(c, radiusKm) {
  const r = radiusKm * 1000;
  const overpassQuery = `[out:json][timeout:25];(node["amenity"="hospital"](around:${r},${c.lat},${c.lng});way["amenity"="hospital"](around:${r},${c.lat},${c.lng});node["amenity"="clinic"](around:${r},${c.lat},${c.lng});node["healthcare"="hospital"](around:${r},${c.lat},${c.lng}););out center;`;
  const data = await queryOverpass(overpassQuery);
  return (data.elements ?? [])
    .filter((e) => (e.lat && e.lon) || (e.center?.lat && e.center?.lon))
    .map((e) => {
      const lat = e.lat ?? e.center.lat;
      const lng = e.lon ?? e.center.lon;
      const tags = e.tags ?? {};
      return {
        place_id: String(e.id),
        name: tags.name || tags["name:en"] || "Hospital",
        address: tags["addr:street"]
          ? `${tags["addr:housenumber"] || ""} ${tags["addr:street"]}`.trim()
          : tags["addr:full"] || "",
        phone: tags.phone || tags["contact:phone"] || "",
        emergency: tags.emergency === "yes",
        lat, lng,
        isHospital: tags.amenity === "hospital" || tags.healthcare === "hospital",
        rating: null,
        distKm: haversine(c.lat, c.lng, lat, lng),
      };
    })
    .sort((a, b) => a.distKm - b.distKm);
}
