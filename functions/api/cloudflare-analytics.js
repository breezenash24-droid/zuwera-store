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
          orderBy: [datetimeHour_ASC]
          filter: { datetimeHour_geq: $datetimeStart, datetimeHour_lt: $datetimeEnd }
        ) {
          dimensions {
            datetimeHour
            clientCountryName
            deviceType
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
            edgeTimeToFirstByteMsP95
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
  const totals = {
    requests: 0,
    cachedRequests: 0,
    pageViews: 0,
    uniqueVisitorsEstimate: 0,
    edgeTtfbSamples: [],
    deviceLcpApproxMs: {},
    topLocations: {},
    hourSeries: []
  };

  for (const row of groups || []) {
    const requests = Number(row?.sum?.requests || 0);
    const cachedRequests = Number(row?.sum?.cachedRequests || 0);
    const pageViews = Number(row?.sum?.pageViews || 0);
    const visits = Number(row?.sum?.visits || 0);
    const p50 = Number(row?.quantiles?.edgeTimeToFirstByteMsP50 || row?.avg?.edgeTimeToFirstByteMs || 0);
    const country = row?.dimensions?.clientCountryName || 'Unknown';
    const device = row?.dimensions?.deviceType || 'unknown';

    totals.requests += requests;
    totals.cachedRequests += cachedRequests;
    totals.pageViews += pageViews;
    totals.uniqueVisitorsEstimate += visits;
    if (p50 > 0) totals.edgeTtfbSamples.push(p50);

    totals.topLocations[country] = (totals.topLocations[country] || 0) + requests;

    if (!totals.deviceLcpApproxMs[device]) totals.deviceLcpApproxMs[device] = [];
    if (p50 > 0) totals.deviceLcpApproxMs[device].push(p50 * 2.6);

    totals.hourSeries.push({
      t: row?.dimensions?.datetimeHour,
      requests,
      pageViews,
      edgeMs: p50
    });
  }

  const sortedEdge = [...totals.edgeTtfbSamples].sort((a, b) => a - b);
  const medianEdgeMs = sortedEdge.length ? sortedEdge[Math.floor(sortedEdge.length / 2)] : 0;
  const medianLcpApproxMs = medianEdgeMs ? Number((medianEdgeMs * 2.6).toFixed(1)) : 0;

  const deviceVitals = Object.entries(totals.deviceLcpApproxMs).map(([device, values]) => {
    const sorted = values.sort((a, b) => a - b);
    return {
      device,
      medianLCP: sorted.length ? Number(sorted[Math.floor(sorted.length / 2)].toFixed(1)) : 0
    };
  });

  const topLocations = Object.entries(totals.topLocations)
    .map(([location, requests]) => ({ location, requests }))
    .sort((a, b) => b.requests - a.requests)
    .slice(0, 8);

  return {
    pageViews: totals.pageViews,
    uniqueVisitors: totals.uniqueVisitorsEstimate,
    medianLCP: medianLcpApproxMs,
    cacheHitRatio: totals.requests ? Number(((totals.cachedRequests / totals.requests) * 100).toFixed(2)) : 0,
    edgeResponseTime: Number(medianEdgeMs.toFixed(1)),
    // botManagement not included — requires Cloudflare Enterprise plan
    bots: null,
    deviceVitals,
    topLocations,
    series: totals.hourSeries
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
      }, 500);
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
      }, 502);
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
    return json({ success: false, error: err?.message || 'Unexpected analytics error.' }, 500);
  }
}
