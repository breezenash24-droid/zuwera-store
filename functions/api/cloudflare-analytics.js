function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

// Uses httpRequests1hGroups (hourly) — available on all Cloudflare plans.
// botManagement is Enterprise-only so it is intentionally omitted.
function buildGraphQLBody({ zoneTag, datetimeStart, datetimeEnd }) {
  const query = `query DashboardEdgeMetrics($zoneTag: String!, $datetimeStart: Time!, $datetimeEnd: Time!) {
    viewer {
      zones(filter: { zoneTag: $zoneTag }) {
        httpRequests1hGroups(
          limit: 168
          orderBy: [datetime_ASC]
          filter: { datetime_geq: $datetimeStart, datetime_lt: $datetimeEnd }
        ) {
          dimensions {
            datetime
          }
          sum {
            requests
            cachedRequests
            pageViews
            visits
            edgeResponseBytes
          }
          avg {
            edgeTimeToFirstByteMs
          }
          quantiles {
            edgeTimeToFirstByteMsP50
          }
        }
      }
    }
  }`;

  return JSON.stringify({
    query,
    variables: {
      zoneTag,
      datetimeStart,
      datetimeEnd
    }
  });
}

function aggregate(groups) {
  let requests = 0, cachedRequests = 0, pageViews = 0, visits = 0;
  const edgeTtfbSamples = [];
  const hourSeries = [];

  for (const row of groups || []) {
    const r = Number(row?.sum?.requests || 0);
    const c = Number(row?.sum?.cachedRequests || 0);
    const pv = Number(row?.sum?.pageViews || 0);
    const v = Number(row?.sum?.visits || 0);
    const p50 = Number(row?.quantiles?.edgeTimeToFirstByteMsP50 || row?.avg?.edgeTimeToFirstByteMs || 0);

    requests += r;
    cachedRequests += c;
    pageViews += pv;
    visits += v;
    if (p50 > 0) edgeTtfbSamples.push(p50);

    hourSeries.push({ t: row?.dimensions?.datetime, requests: r, pageViews: pv, edgeMs: p50 });
  }

  const sorted = [...edgeTtfbSamples].sort((a, b) => a - b);
  const medianEdgeMs = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;

  return {
    pageViews,
    uniqueVisitors: visits,
    cacheHitRatio: requests ? Number(((cachedRequests / requests) * 100).toFixed(2)) : 0,
    edgeResponseTime: Number(medianEdgeMs.toFixed(1)),
    totalRequests: requests,
    // Country/device breakdown not available in httpRequests1hGroups (free plan)
    bots: null,
    deviceVitals: [],
    topLocations: [],
    series: hourSeries
  };
}

export async function onRequestGet({ env }) {
  try {
    const accountId = env.CLOUDFLARE_ACCOUNT_ID || env.CF_ACCOUNT_ID || '';
    const zoneTag = env.CLOUDFLARE_ZONE_ID || env.CLOUDFLARE_ZONE_TAG || env.CF_ZONE_ID || '';
    const token = env.CLOUDFLARE_GRAPHQL_TOKEN || env.CLOUDFLARE_API_TOKEN || env.CF_API_TOKEN || '';

    if (!zoneTag || !token) {
      return json({
        success: false,
        error: 'Missing Cloudflare GraphQL configuration.',
        requiredEnv: ['CLOUDFLARE_ZONE_ID', 'CLOUDFLARE_GRAPHQL_TOKEN'],
      }, 200);
    }

    const now = new Date();
    // Look back 7 days (168 hours) for hourly data
    const start = new Date(now.getTime() - (7 * 24 * 60 * 60 * 1000));

    const gqlBody = buildGraphQLBody({
      zoneTag,
      datetimeStart: start.toISOString(),
      datetimeEnd: now.toISOString()
    });

    const resp = await fetch('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: gqlBody
    });

    const payload = await resp.json().catch(() => ({}));
    if (!resp.ok || payload?.errors) {
      return json({
        success: false,
        error: 'Cloudflare GraphQL request failed.',
        status: resp.status,
        details: payload?.errors || payload
      }, 200);
    }

    const groups = payload?.data?.viewer?.zones?.[0]?.httpRequests1hGroups || [];

    return json({
      success: true,
      metrics: aggregate(groups),
      accountId: accountId || null,
      zoneTag,
      granularity: 'hourly',
      windowDays: 7
    });
  } catch (err) {
    return json({ success: false, error: err?.message || 'Unexpected analytics error.' }, 200);
  }
}
