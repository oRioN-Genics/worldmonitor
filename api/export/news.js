import { getCorsHeaders, isDisallowedOrigin } from "../_cors.js";
import { validateApiKey } from "../_api-key.js";
import { checkRateLimit } from "../_rate-limit.js";

export const config = { runtime: "edge" };

const VALID_VARIANTS = new Set(["full", "tech", "finance", "happy"]);
const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 50;

const THREAT_LEVEL_IMPORTANCE = {
  THREAT_LEVEL_UNSPECIFIED: 0.2,
  THREAT_LEVEL_LOW: 0.35,
  THREAT_LEVEL_MEDIUM: 0.55,
  THREAT_LEVEL_HIGH: 0.8,
  THREAT_LEVEL_CRITICAL: 1.0,
};

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function toBoolean(value) {
  if (value == null) return false;
  const normalized = String(value).trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function parseCsv(value) {
  if (!value) return [];
  return String(value)
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

function parseSince(value) {
  if (!value) return null;
  const ts = Date.parse(value);
  if (Number.isNaN(ts)) return null;
  return ts;
}

function importanceFromThreat(item) {
  const level = item?.threat?.level || "THREAT_LEVEL_UNSPECIFIED";
  const levelWeight =
    THREAT_LEVEL_IMPORTANCE[level] ??
    THREAT_LEVEL_IMPORTANCE.THREAT_LEVEL_UNSPECIFIED;
  const confidence = clamp(Number(item?.threat?.confidence ?? 0), 0, 1);
  return Number(
    (
      Math.max(levelWeight, confidence) * 0.7 +
      Math.min(levelWeight, confidence) * 0.3
    ).toFixed(3),
  );
}

function hashKey(input) {
  let hash = 5381;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash << 5) + hash + input.charCodeAt(i);
    hash |= 0;
  }
  return `n_${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function normalizeText(v) {
  return String(v || "")
    .trim()
    .toLowerCase();
}

function inferRegion(category, locationName) {
  const c = normalizeText(category);
  const loc = normalizeText(locationName);
  if (c.includes("middleeast") || loc.includes("middle east"))
    return "middleeast";
  if (c.includes("europe") || loc.includes("europe")) return "europe";
  if (c.includes("africa") || loc.includes("africa")) return "africa";
  if (c.includes("latam") || c.includes("americas") || loc.includes("latin"))
    return "latam";
  if (c.includes("asia") || loc.includes("asia")) return "asia";
  if (c === "us" || loc.includes("united states") || loc.includes("usa"))
    return "us";
  return "";
}

export default async function handler(req) {
  // Origin protection (keep as-is)
  if (isDisallowedOrigin(req)) {
    return new Response(JSON.stringify({ error: "Origin not allowed" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  const cors = getCorsHeaders(req, "GET, OPTIONS");

  // Preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }

  // Method guard
  if (req.method !== "GET") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  // API key validation (repo’s built-in)
  const apiKeyResult = validateApiKey(req);
  if (apiKeyResult.required && !apiKeyResult.valid) {
    return new Response(JSON.stringify({ error: apiKeyResult.error }), {
      status: 401,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  // Rate limit (repo’s built-in)
  const rateLimited = await checkRateLimit(req, cors);
  if (rateLimited) return rateLimited;

  const url = new URL(req.url);

  const variantRaw = url.searchParams.get("variant") || "full";
  const variant = VALID_VARIANTS.has(variantRaw) ? variantRaw : "full";
  const lang = (url.searchParams.get("lang") || "en").trim() || "en";

  const limitRaw = parseInt(
    url.searchParams.get("limit") || String(DEFAULT_LIMIT),
    10,
  );
  const limit = clamp(
    Number.isNaN(limitRaw) ? DEFAULT_LIMIT : limitRaw,
    1,
    MAX_LIMIT,
  );

  const sinceParam = url.searchParams.get("since");
  const sinceTs = parseSince(sinceParam);
  if (sinceParam && sinceTs === null) {
    return new Response(
      JSON.stringify({
        error: "Invalid since parameter. Use ISO-8601 date-time.",
      }),
      {
        status: 400,
        headers: { ...cors, "Content-Type": "application/json" },
      },
    );
  }

  const sourceFilter = new Set(
    parseCsv(url.searchParams.get("source")).map(normalizeText),
  );
  const categoryFilter = new Set(
    parseCsv(url.searchParams.get("category")).map(normalizeText),
  );
  const keywordFilter = parseCsv(url.searchParams.get("keywords")).map(
    normalizeText,
  );
  const regionFilter = new Set(
    parseCsv(url.searchParams.get("region")).map(normalizeText),
  );

  const importanceMin = clamp(
    Number(url.searchParams.get("importanceMin") || 0),
    0,
    1,
  );
  const alertOnly = toBoolean(url.searchParams.get("alertOnly"));

  const forwardedApiKey =
    req.headers.get("X-WorldMonitor-Key") ||
    req.headers.get("x-worldmonitor-key");

  const digestPath = `/api/news/v1/list-feed-digest?variant=${encodeURIComponent(
    variant,
  )}&lang=${encodeURIComponent(lang)}`;
  const digestUrl = `${url.origin}${digestPath}`;

  let digest;
  try {
    const headers = new Headers({ Accept: "application/json" });

    if (forwardedApiKey) {
      headers.set("X-WorldMonitor-Key", forwardedApiKey);
    }

    const resp = await fetch(digestUrl, {
      headers,
      signal: AbortSignal.timeout(15000),
    });

    if (!resp.ok) {
      return new Response(
        JSON.stringify({
          error: `Digest endpoint failed with status ${resp.status}`,
        }),
        {
          status: 502,
          headers: { ...cors, "Content-Type": "application/json" },
        },
      );
    }

    digest = await resp.json();
  } catch (err) {
    return new Response(
      JSON.stringify({
        error: "Failed to fetch digest endpoint",
        detail: String(err),
      }),
      {
        status: 502,
        headers: { ...cors, "Content-Type": "application/json" },
      },
    );
  }

  const categories = digest?.categories ?? {};
  const items = [];
  const seen = new Set();

  for (const [category, bucket] of Object.entries(categories)) {
    const categoryName = String(category);
    const categoryNorm = normalizeText(categoryName);
    const bucketItems = Array.isArray(bucket?.items) ? bucket.items : [];

    for (const item of bucketItems) {
      const source = String(item?.source || "");
      const title = String(item?.title || "");
      const link = String(item?.link || "");
      const publishedAt = Number(item?.publishedAt || 0);
      const locationName = String(item?.locationName || "");
      const threatLevel = item?.threat?.level || "THREAT_LEVEL_UNSPECIFIED";
      const threatCategory = String(item?.threat?.category || "");
      const confidence = clamp(Number(item?.threat?.confidence ?? 0), 0, 1);
      const importance = importanceFromThreat(item);
      const region = inferRegion(categoryName, locationName);

      if (!publishedAt || Number.isNaN(publishedAt)) continue;
      if (sinceTs != null && publishedAt <= sinceTs) continue;

      const sourceNorm = normalizeText(source);
      if (sourceFilter.size > 0 && !sourceFilter.has(sourceNorm)) continue;
      if (categoryFilter.size > 0 && !categoryFilter.has(categoryNorm))
        continue;
      if (regionFilter.size > 0 && !regionFilter.has(normalizeText(region)))
        continue;
      if (alertOnly && !item?.isAlert) continue;
      if (importance < importanceMin) continue;

      if (keywordFilter.length > 0) {
        const text = `${title} ${threatCategory}`.toLowerCase();
        const hasKeyword = keywordFilter.some((kw) => text.includes(kw));
        if (!hasKeyword) continue;
      }

      const dedupeBase = `${sourceNorm}|${normalizeText(link)}|${normalizeText(
        title,
      )}`;
      const id = hashKey(dedupeBase);
      if (seen.has(id)) continue;
      seen.add(id);

      items.push({
        id,
        source,
        title,
        link,
        publishedAt,
        publishedAtIso: new Date(publishedAt).toISOString(),
        category: categoryName,
        region,
        isAlert: !!item?.isAlert,
        threatLevel,
        threatCategory,
        confidence,
        importance,
        locationName,
      });
    }
  }

  items.sort((a, b) => b.publishedAt - a.publishedAt);

  const sliced = items.slice(0, limit);

  const nextCursor =
    sliced.length > 0
      ? new Date(Math.max(...sliced.map((i) => i.publishedAt))).toISOString()
      : sinceTs != null
        ? new Date(sinceTs).toISOString()
        : null;

  return new Response(
    JSON.stringify({
      meta: {
        generatedAt: digest?.generatedAt || new Date().toISOString(),
        variant,
        lang,
        since: sinceTs != null ? new Date(sinceTs).toISOString() : null,
        limit,
        totalFetched: items.length,
        returned: sliced.length,
        nextCursor,
        filters: {
          source: [...sourceFilter],
          category: [...categoryFilter],
          keywords: keywordFilter,
          region: [...regionFilter],
          importanceMin,
          alertOnly,
        },
      },
      items: sliced,
    }),
    {
      status: 200,
      headers: {
        ...cors,
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    },
  );
}
