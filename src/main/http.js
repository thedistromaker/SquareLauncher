"use strict";

/**
 * HTTP helper shared by every installer/marketplace module.
 *
 * 3.0.17 used node-fetch v2 everywhere. On some networks node-fetch's TLS /
 * keep-alive handling hits "Premature close" against api.modrinth.com, while
 * Node's built-in fetch (undici, available in Electron 43's Node 22) works.
 * We therefore prefer the global fetch and keep node-fetch only as a fallback.
 *
 * Responses are normalized to a node-fetch-shaped object so existing callers
 * keep working: `res.ok`, `res.status`, `res.headers.get(...)`, `res.json()`,
 * `res.text()`, `res.buffer()`, and a Node Readable `res.body` that supports
 * `.pipe()` and `.on("data")` for the download paths.
 */

const { Readable } = require("stream");
const nodeFetch = require("node-fetch");

const USER_AGENT = "CuboidLauncher/4.0.0 (github.com/thedistromaker/SquareLauncher)";

function adaptWebResponse(res) {
  const adapted = {
    ok: res.ok,
    status: res.status,
    statusText: res.statusText,
    url: res.url,
    redirected: res.redirected,
    headers: res.headers,
    json: () => res.json(),
    text: () => res.text(),
    buffer: async () => Buffer.from(await res.arrayBuffer()),
  };
  // Lazily build the Node stream: locking the web body eagerly makes
  // res.json()/res.text() fail with "Body has already been read".
  let bodyStream = null;
  Object.defineProperty(adapted, "body", {
    enumerable: true,
    get() {
      if (!res.body) return null;
      if (!bodyStream) bodyStream = Readable.fromWeb(res.body);
      return bodyStream;
    },
  });
  return adapted;
}

function fetchUA(url, opts = {}) {
  const { headers: extraHeaders, ...rest } = opts || {};
  const headers = { "User-Agent": USER_AGENT, ...(extraHeaders || {}) };

  if (typeof globalThis.fetch === "function" && !process.env.CUBOID_FORCE_NODE_FETCH) {
    return globalThis.fetch(url, { ...rest, headers }).then(adaptWebResponse);
  }
  return nodeFetch(url, { ...rest, headers });
}

async function fetchJson(url, opts = {}) {
  const res = await fetchUA(url, opts);
  if (!res.ok) throw new Error(`Request failed (${res.status}): ${url}`);
  return res.json();
}

async function fetchText(url, opts = {}) {
  const res = await fetchUA(url, opts);
  if (!res.ok) throw new Error(`Request failed (${res.status}): ${url}`);
  return res.text();
}

module.exports = { USER_AGENT, fetchUA, fetchJson, fetchText };
