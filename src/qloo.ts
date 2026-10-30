// Qloo Taste AI client (hackathon environment). The key stays on the server (QLOO_API_KEY).
// Docs: https://docs.qloo.com/reference/qloo-llm-hackathon-developer-guide
// - Base URL must be https://hackathon.api.qloo.com
// - Auth header: X-Api-Key
// - /v2/insights is GET with query-string params

const BASE_URL = process.env.QLOO_BASE_URL?.trim() || "https://hackathon.api.qloo.com";
const TIMEOUT_MS = 12000;

type Params = Record<string, string | number | string[] | undefined | null>;

export interface QlooEntity {
  name: string;
  entityId: string;
  type?: string;
  affinity?: number;
  popularity?: number;
  address?: string;
  priceLevel?: number;
  description?: string;
  website?: string;
  image?: string;
  tags?: string[];
}

export class QlooError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

export function qlooConfigured(): boolean {
  return Boolean(process.env.QLOO_API_KEY?.trim());
}

function query(params: Params): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v)) {
      if (v.length) q.set(k, v.join(","));
    } else q.set(k, String(v));
  }
  return q.toString();
}

async function get(path: string, params: Params): Promise<any> {
  const key = process.env.QLOO_API_KEY?.trim();
  if (!key) throw new QlooError("QLOO_API_KEY is not set on the server.");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}${path}?${query(params)}`, {
      headers: { "X-Api-Key": key, Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new QlooError(`Qloo ${path} ${res.status}: ${body.slice(0, 200)}`, res.status);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function list(payload: any, key: string): any[] {
  const r = payload?.results;
  if (Array.isArray(r)) return r;
  if (r && Array.isArray(r[key])) return r[key];
  return [];
}

function slim(e: any): QlooEntity {
  const p = e?.properties ?? {};
  const image = p?.image?.url ?? (Array.isArray(p?.images) ? p.images[0]?.url : undefined);
  const description = p?.short_description ?? p?.description;
  return {
    name: String(e?.name ?? ""),
    entityId: String(e?.entity_id ?? ""),
    type: e?.subtype ?? e?.type ?? (Array.isArray(e?.types) ? e.types[0] : undefined),
    affinity: typeof e?.query?.affinity === "number" ? Number(e.query.affinity.toFixed(3)) : undefined,
    popularity: typeof e?.popularity === "number" ? Number(e.popularity.toFixed(3)) : undefined,
    address: p?.address ?? undefined,
    priceLevel: typeof p?.price_level === "number" ? p.price_level : undefined,
    description: typeof description === "string" ? description.slice(0, 200) : undefined,
    website: p?.website ?? undefined,
    image: typeof image === "string" ? image : undefined,
    tags: Array.isArray(e?.tags) ? e.tags.map((t: any) => t?.name).filter(Boolean).slice(0, 5) : undefined,
  };
}

/** Resolve a name to Qloo entities (brands, places, artists…). */
export async function qlooSearch(text: string, types: string[], take = 3): Promise<QlooEntity[]> {
  const data = await get("/search", { query: text, types, take });
  return list(data, "entities").map(slim).filter((e) => e.entityId);
}

/** Find tag IDs for a vibe/style/cuisine keyword. */
export async function qlooTags(text: string, take = 3): Promise<{ id: string; name: string }[]> {
  const data = await get("/v2/tags", { "filter.query": text, take });
  return list(data, "tags")
    .map((t: any) => ({ id: String(t?.tag_id ?? t?.id ?? ""), name: String(t?.name ?? "") }))
    .filter((t) => t.id);
}

/** Qloo Insights: taste-based recommendations. */
export async function qlooInsights(opts: {
  type: "urn:entity:brand" | "urn:entity:place" | "urn:entity:artist";
  entities?: string[];
  tags?: string[];
  location?: string;
  take?: number;
}): Promise<QlooEntity[]> {
  const params: Params = {
    "filter.type": opts.type,
    "signal.interests.entities": opts.entities,
    "signal.interests.tags": opts.tags,
    take: opts.take ?? 6,
  };
  if (opts.location) params[opts.type === "urn:entity:place" ? "filter.location.query" : "signal.location.query"] = opts.location;
  const data = await get("/v2/insights", params);
  return list(data, "entities").map(slim).filter((e) => e.entityId);
}
