const ALLOWED_ORIGINS = new Set([
  "https://yappi7000.github.io",
  "http://localhost:8000",
]);

const GITHUB_OWNER = "yappi7000";
const GITHUB_REPO = "iPhone-Tenbai";
const WORKFLOW_FILE = "on-demand-price.yml";

function corsHeaders(origin) {
  const allowed =
    ALLOWED_ORIGINS.has(origin)
      ? origin
      : "https://yappi7000.github.io";

  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, X-Update-Key",
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

    const updateKey =
      request.headers.get("X-Update-Key") || "";

    if (
      !env.UPDATE_KEY ||
      updateKey !== env.UPDATE_KEY
    ) {
      return jsonResponse(
        {
          ok: false,
          error: "Unauthorized"
        },
        401,
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

    const jan =
      String(body.jan || "").trim();

    if (!/^\d{13}$/.test(jan)) {
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

    const url =
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}` +
      `/actions/workflows/${WORKFLOW_FILE}/dispatches`;

    const githubResponse =
      await fetch(
        url,
        {
          method: "POST",
          headers: {
            "Authorization":
              `Bearer ${env.GITHUB_TOKEN}`,
            "Accept":
              "application/vnd.github+json",
            "X-GitHub-Api-Version":
              "2022-11-28",
            "User-Agent":
              "iPhone-Tenbai-price-refresh"
          },
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
