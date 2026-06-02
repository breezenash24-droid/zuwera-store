function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

// Uses httpRequests1dGroups (daily) — available on all Cloudflare plans.
// Hourly groups have very limited fields; daily groups expose more.
function buildGraphQLBody({ zoneTag, datetimeStart, datetimeEnd }) {
  const query = `query DashboardEdgeMetrics($zoneTag: String!, $datetimeStart: Date!, $datetimeEnd: Date!) {
    viewer {
      zones(filter: { zoneTag: $zoneTag }) {
        httpRequests1dGroups(
          limit: 30
          orderBy: [date_ASC]
          filter: { date_geq: $datetimeStart, date_lt: $datetimeEnd }
        ) {
          dimensions {
            date
          }
          sum {
            requests
            cachedRequests
            pageViews
            encryptedRequests
            bytes
          }
          uniq {
            uniques
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
  let requests = 0, cachedRequests = 0, pageViews = 0, uniques = 0;
  const daySeries = [];

  for (const row of groups || []) {
    const r = Number(row?.sum?.requests || 0);
    const c = Number(row?.sum?.cachedRequests || 0);
    const pv = Number(row?.sum?.pageViews || 0);
    const u = Number(row?.uniq?.uniques || 0);

    requests += r;
    cachedRequests += c;
    pageViews += pv;
    uniques += u;

    daySeries.push({ date: row?.dimensions?.date, requests: r, pageViews: pv });
  }

  return {
    pageViews,
    uniqueVisitors: uniques,
    totalRequests: requests,
    cacheHitRatio: requests ? Number(((cachedRequests / requests) * 100).toFixed(2)) : 0,
    // Edge response time not available in daily groups; needs hourly or minute groups (Pro+)
    edgeResponseTime: null,
    bots: null,
    deviceVitals: [],
    topLocations: [],
    series: daySeries
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
    const start = new Date(now.getTime() - (30 * 24 * 60 * 60 * 1000));
    // Daily groups use Date type (YYYY-MM-DD), not ISO timestamps
    const toDateStr = (d) => d.toISOString().slice(0, 10);

    const gqlBody = buildGraphQLBody({
      zoneTag,
      datetimeStart: toDateStr(start),
      datetimeEnd: toDateStr(now)
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

    const groups = payload?.data?.viewer?.zones?.[0]?.httpRequests1dGroups || [];

    return json({
      success: true,
      metrics: aggregate(groups),
      accountId: accountId || null,
      zoneTag,
      granularity: 'daily',
      windowDays: 30
    });
  } catch (err) {
    return json({ success: false, error: err?.message || 'Unexpected analytics error.' }, 200);
  }
}
