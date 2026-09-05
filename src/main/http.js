"use strict";

const fetch = require("node-fetch");

const USER_AGENT = "SquareLauncher/1.0";

function fetchUA(url, opts = {}) {
  const headers = { "User-Agent": USER_AGENT, ...(opts.headers || {}) };
  return fetch(url, { ...opts, headers });
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
