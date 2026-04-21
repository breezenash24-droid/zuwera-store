interface KVNamespaceLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

export interface Env {
  PRIMARY_API_KEY: string;
  SECONDARY_API_KEY: string;
  RELAY_FROM_EMAIL: string;
  RELAY_REPLY_TO?: string;
  EMAIL_RELAY_STATE: KVNamespaceLike;
}


interface EmailRequest {
  to: string;
  subject: string;
  html: string;
}

const QUOTA_TTL_SECONDS = 60 * 60 * 24;
const PRIMARY_EXHAUSTED_KEY = "provider:resend:exhausted";
const SECONDARY_EXHAUSTED_KEY = "provider:postmark:exhausted";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

function isQuotaError(status: number): boolean {
  return status === 403 || status === 429;
}

function normalizeErrorText(text: string | null | undefined): string {
  const trimmed = (text ?? "").trim();
  return trimmed.length > 0 ? trimmed.slice(0, 1500) : "No response body";
}

function validatePayload(payload: unknown): { ok: true; value: EmailRequest } | { ok: false; error: string } {
  if (!payload || typeof payload !== "object") {
    return { ok: false, error: "Request body must be a JSON object." };
  }

  const { to, subject, html } = payload as Record<string, unknown>;
  if (typeof to !== "string" || !to.trim()) {
    return { ok: false, error: "Field 'to' is required and must be a non-empty string." };
  }
  if (typeof subject !== "string" || !subject.trim()) {
    return { ok: false, error: "Field 'subject' is required and must be a non-empty string." };
  }
  if (typeof html !== "string" || !html.trim()) {
    return { ok: false, error: "Field 'html' is required and must be a non-empty string." };
  }

  return {
    ok: true,
    value: {
      to: to.trim(),
      subject: subject.trim(),
      html,
    },
  };
}

async function markExhausted(env: Env, key: string): Promise<void> {
  await env.EMAIL_RELAY_STATE.put(key, "1", { expirationTtl: QUOTA_TTL_SECONDS });
}

async function isExhausted(env: Env, key: string): Promise<boolean> {
  const state = await env.EMAIL_RELAY_STATE.get(key);
  return state === "1";
}

async function sendWithResend(email: EmailRequest, env: Env): Promise<Response> {
  return fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.PRIMARY_API_KEY}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      from: env.RELAY_FROM_EMAIL,
      to: [email.to],
      subject: email.subject,
      html: email.html,
      ...(env.RELAY_REPLY_TO ? { reply_to: env.RELAY_REPLY_TO } : {}),
    }),
  });
}

async function sendWithPostmark(email: EmailRequest, env: Env): Promise<Response> {
  return fetch("https://api.postmarkapp.com/email", {
    method: "POST",
    headers: {
      "X-Postmark-Server-Token": env.SECONDARY_API_KEY,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      From: env.RELAY_FROM_EMAIL,
      To: email.to,
      Subject: email.subject,
      HtmlBody: email.html,
      ...(env.RELAY_REPLY_TO ? { ReplyTo: env.RELAY_REPLY_TO } : {}),
      MessageStream: "outbound",
    }),
  });
}

async function sendSecondary(email: EmailRequest, env: Env, details: Record<string, unknown>): Promise<Response> {
  if (await isExhausted(env, SECONDARY_EXHAUSTED_KEY)) {
    return json(
      {
        error: "secondary_provider_exhausted",
        message: "Secondary provider is marked exhausted in KV. Cannot relay email right now.",
        details,
      },
      503,
    );
  }

  let secondaryResponse: Response;
  try {
    secondaryResponse = await sendWithPostmark(email, env);
  } catch (error) {
    return json(
      {
        error: "secondary_provider_unreachable",
        message: "Secondary provider request failed before receiving an HTTP response.",
        details: {
          ...details,
          secondary_error: error instanceof Error ? error.message : String(error),
        },
      },
      503,
    );
  }

  const secondaryText = normalizeErrorText(await secondaryResponse.text());

  if (secondaryResponse.ok) {
    return json({
      ok: true,
      provider: "postmark",
      status: secondaryResponse.status,
      details: {
        ...details,
        postmark_response: secondaryText,
      },
    });
  }

  if (isQuotaError(secondaryResponse.status)) {
    await markExhausted(env, SECONDARY_EXHAUSTED_KEY);
  }

  return json(
    {
      error: "all_providers_failed",
      message: "Both providers failed to send email.",
      details: {
        ...details,
        postmark_status: secondaryResponse.status,
        postmark_response: secondaryText,
      },
    },
    503,
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") {
      return json({ error: "method_not_allowed", message: "Use POST with JSON payload." }, 405);
    }

    if (!env.PRIMARY_API_KEY || !env.SECONDARY_API_KEY || !env.RELAY_FROM_EMAIL) {
      return json(
        {
          error: "missing_environment_configuration",
          message:
            "Missing required secrets/config: PRIMARY_API_KEY, SECONDARY_API_KEY, and RELAY_FROM_EMAIL are required.",
        },
        500,
      );
    }

    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return json({ error: "invalid_json", message: "Request body must be valid JSON." }, 400);
    }

    const validated = validatePayload(payload);
    if (validated.ok === false) {
      return json({ error: "invalid_payload", message: validated.error }, 400);
    }

    const email = validated.value;
    const primaryBypassed = await isExhausted(env, PRIMARY_EXHAUSTED_KEY);

    if (primaryBypassed) {
      return sendSecondary(email, env, {
        primary_skipped: true,
        reason: "PRIMARY_EXHAUSTED set in KV",
      });
    }

    let primaryResponse: Response;
    try {
      primaryResponse = await sendWithResend(email, env);
    } catch (error) {
      return sendSecondary(email, env, {
        primary_skipped: false,
        primary_error: error instanceof Error ? error.message : String(error),
        reason: "Primary request failed before receiving an HTTP response",
      });
    }

    const primaryText = normalizeErrorText(await primaryResponse.text());

    if (primaryResponse.ok) {
      return json({
        ok: true,
        provider: "resend",
        status: primaryResponse.status,
        details: {
          resend_response: primaryText,
        },
      });
    }

    if (isQuotaError(primaryResponse.status)) {
      await markExhausted(env, PRIMARY_EXHAUSTED_KEY);
      return sendSecondary(email, env, {
        primary_skipped: false,
        primary_status: primaryResponse.status,
        primary_response: primaryText,
        reason: "Primary provider quota/rate limit exhausted",
      });
    }

    return sendSecondary(email, env, {
      primary_skipped: false,
      primary_status: primaryResponse.status,
      primary_response: primaryText,
      reason: "Primary provider returned non-success status",
    });
  },
};
