const ALLOWED_ORIGINS = new Set([
  "https://yappi7000.github.io",
  "http://localhost:8000",
]);

const GITHUB_OWNER = "yappi7000";
const GITHUB_REPO = "iPhone-Tenbai";
const WORKFLOW_FILE = "on-demand-price.yml";

const ALLOWED_JANS = new Set([
  "4549995734546","4549995734591","4549995734645","4549995734690",
  "4549995734744","4549995734799","4549995734843","4549995734898",
  "4549995734942","4549995734997","4549995735048","4549995735093",
  "4549995735147","4549995735192","4549995735246","4549995735291",
  "4549995734140","4549995734157","4549995734164","4549995734171",
  "4549995734188","4549995734195","4549995734201","4549995734218",
  "4549995734225","4549995734232","4549995734249","4549995734256",
  "4549995734263","4549995734270","4549995734287","4549995734294"
]);

const WRITE_WORKFLOWS = new Set([
  ".github/workflows/on-demand-price.yml",
  ".github/workflows/crawl.yml",
  ".github/workflows/crawl-catalog.yml",
  ".github/workflows/apple-inventory.yml"
]);

const ACTIVE_STATUSES = new Set([
  "queued",
  "in_progress",
  "waiting",
  "requested",
  "pending"
]);

function corsHeaders(origin) {
  const allowed =
    ALLOWED_ORIGINS.has(origin)
      ? origin
      : "https://yappi7000.github.io";

  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type",
    "Content-Type": "application/json"
  };
}

function jsonResponse(body, status, origin) {
  return new Response(
    JSON.stringify(body),
    {
      status,
      headers: corsHeaders(origin)
    }
  );
}

export default {
  async fetch(request, env) {
    const origin =
      request.headers.get("Origin") || "";

    if (request.method === "OPTIONS") {
      return new Response(
        null,
        {
          status: 204,
          headers: corsHeaders(origin)
        }
      );
    }

    if (!ALLOWED_ORIGINS.has(origin)) {
      return jsonResponse(
        {
          ok: false,
          error: "Origin not allowed"
        },
        403,
        origin
      );
    }

    if (request.method === "GET") {
      if (!env.GITHUB_TOKEN) {
        return jsonResponse(
          {
            ok: false,
            error: "GitHub token is not configured"
          },
          500,
          origin
        );
      }

      const githubHeaders = {
        "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "iPhone-Tenbai-price-refresh"
      };

      const runsUrl =
        `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}` +
        `/actions/runs?branch=main&per_page=30`;

      const runsResponse = await fetch(
        runsUrl,
        {
          headers: githubHeaders
        }
      );

      if (!runsResponse.ok) {
        return jsonResponse(
          {
            ok: false,
            error: "GitHub status check failed"
          },
          502,
          origin
        );
      }

      const runsData =
        await runsResponse.json();

      const activeRun =
        (runsData.workflow_runs || []).find(
          run =>
            WRITE_WORKFLOWS.has(run.path) &&
            ACTIVE_STATUSES.has(run.status)
        );

      return jsonResponse(
        {
          ok: true,
          busy: Boolean(activeRun),
          workflow:
            activeRun
              ? activeRun.name
              : null
        },
        200,
        origin
      );
    }

    if (request.method !== "POST") {
      return jsonResponse(
        {
          ok: false,
          error: "Method not allowed"
        },
        405,
        origin
      );
    }

    if (!ALLOWED_ORIGINS.has(origin)) {
      return jsonResponse(
        {
          ok: false,
          error: "Origin not allowed"
        },
        403,
        origin
      );
    }

    let body;

    try {
      body = await request.json();
    } catch {
      return jsonResponse(
        {
          ok: false,
          error: "Invalid JSON"
        },
        400,
        origin
      );
    }

    const turnstileToken =
      String(
        body.turnstileToken || ""
      ).trim();

    if (
      !env.TURNSTILE_SECRET ||
      !turnstileToken
    ) {
      return jsonResponse(
        {
          ok: false,
          error:
            "Security verification required"
        },
        403,
        origin
      );
    }

    const verifyBody =
      new FormData();

    let verification;

    verifyBody.append(
      "secret",
      env.TURNSTILE_SECRET
    );

    verifyBody.append(
      "response",
      turnstileToken
    );

    const remoteIp =
      request.headers.get(
        "CF-Connecting-IP"
      );

    if (remoteIp) {
      verifyBody.append(
        "remoteip",
        remoteIp
      );
    }

      try {
        const verifyResponse =
          await fetch(
          "https://challenges.cloudflare.com/turnstile/v0/siteverify",
          {
            method: "POST",
            body: verifyBody
          }
        );

        verification =
          await verifyResponse.json();

      } catch {
        return jsonResponse(
          {
            ok: false,
            error:
              "Security verification unavailable"
          },
          502,
          origin
        );
      }

    if (
      !verification.success ||
      verification.action !==
        "price_refresh" ||
      verification.hostname !==
        "yappi7000.github.io"
    ) {
      return jsonResponse(
        {
          ok: false,
          error:
            "Security verification failed"
        },
        403,
        origin
      );
    }

    const jan =
      String(body.jan || "").trim();

    if (!/^\d{13}$/.test(jan) || !ALLOWED_JANS.has(jan)) {
      return jsonResponse(
        {
          ok: false,
          error: "Invalid JAN"
        },
        400,
        origin
      );
    }

    if (!env.GITHUB_TOKEN) {
      return jsonResponse(
        {
          ok: false,
          error: "GitHub token is not configured"
        },
        500,
        origin
      );
    }

    const githubHeaders = {
      "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "iPhone-Tenbai-price-refresh"
    };

    const runsUrl =
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}` +
      `/actions/runs?branch=main&per_page=30`;

    const runsResponse = await fetch(runsUrl, {
      headers: githubHeaders
    });

    if (!runsResponse.ok) {
      return jsonResponse(
        {
          ok: false,
          error: "GitHub status check failed"
        },
        502,
        origin
      );
    }

    const runsData = await runsResponse.json();

    const activeRun = (runsData.workflow_runs || []).find(run =>
      WRITE_WORKFLOWS.has(run.path) &&
      ACTIVE_STATUSES.has(run.status)
    );

    if (activeRun) {
      return jsonResponse(
        {
          ok: false,
          error: "Price refresh already running",
          message: "現在ほかの商品・データを更新中です。完了後にもう一度お試しください。"
        },
        409,
        origin
      );
    }

    const url =
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}` +
      `/actions/workflows/${WORKFLOW_FILE}/dispatches`;

    const githubResponse =
      await fetch(
        url,
        {
          method: "POST",
          headers: githubHeaders,
          body: JSON.stringify({
            ref: "main",
            inputs: {
              jan
            }
          })
        }
      );

    if (!githubResponse.ok) {
      const text =
        await githubResponse.text();

      return jsonResponse(
        {
          ok: false,
          error: "GitHub dispatch failed",
          status: githubResponse.status,
          detail: text.slice(0, 500)
        },
        502,
        origin
      );
    }

    return jsonResponse(
      {
        ok: true,
        jan,
        message:
          "Price refresh started"
      },
      202,
      origin
    );
  }
};
