"use strict";

/**
 * Rudimentary Microsoft login for Minecraft-style asset access.
 *
 * Flow implemented (the same one used by the official launcher and most
 * open-source third-party launchers):
 *
 *   1. Device Code flow against Azure AD ("consumers" tenant) to get a
 *      Microsoft Account access token. This is the flow meant for apps
 *      without a web redirect (desktop apps) - the user visits a short
 *      URL on any device and types a code.
 *   2. Exchange the MS access token for an Xbox Live token (XBL).
 *   3. Exchange the XBL token for an XSTS token.
 *   4. Exchange the XSTS token + user hash for a Minecraft Services token.
 *   5. Fetch the Minecraft profile (username, UUID, skin) and, optionally,
 *      verify game ownership ("entitlements").
 *
 * IMPORTANT: You must register your own free Azure AD application at
 * https://portal.azure.com (Azure Active Directory -> App registrations)
 * and set CLIENT_ID below. Use "Public client / native (mobile & desktop)"
 * as the platform and enable the "Allow public client flows" toggle so the
 * device code flow works. This keeps the app's identity your own instead
 * of impersonating an existing client.
 */

const fetch = require("node-fetch");

const CLIENT_ID = process.env.SQUARE_LAUNCHER_MS_CLIENT_ID || "PUT-YOUR-AZURE-APP-CLIENT-ID-HERE";
const SCOPE = "XboxLive.signin offline_access";

const DEVICE_CODE_URL = "https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode";
const TOKEN_URL = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token";
const XBL_AUTH_URL = "https://user.auth.xboxlive.com/user/authenticate";
const XSTS_AUTH_URL = "https://xsts.auth.xboxlive.com/xsts/authorize";
const MC_LOGIN_URL = "https://api.minecraftservices.com/authentication/login_with_xbox";
const MC_ENTITLEMENT_URL = "https://api.minecraftservices.com/entitlements/mcstore";
const MC_PROFILE_URL = "https://api.minecraftservices.com/minecraft/profile";

async function postForm(url, form) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data.error_description || data.error || `Request failed: ${res.status}`);
    err.data = data;
    throw err;
  }
  return data;
}

async function postJson(url, body, headers = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data.error || data.errorMessage || `Request failed: ${res.status}`);
    err.data = data;
    throw err;
  }
  return data;
}

/**
 * Step 1: request a device code. Returns { verification_uri, user_code, device_code, interval, expires_in }.
 */
async function requestDeviceCode() {
  if (CLIENT_ID.startsWith("PUT-YOUR-AZURE-APP")) {
    throw new Error(
      "No Azure AD client ID configured. Register a free app at portal.azure.com and set " +
      "SQUARE_LAUNCHER_MS_CLIENT_ID (or edit CLIENT_ID in msAuth.js)."
    );
  }
  return postForm(DEVICE_CODE_URL, {
    client_id: CLIENT_ID,
    scope: SCOPE,
  });
}

/**
 * Step 1b: poll the token endpoint until the user finishes signing in on
 * microsoft.com/devicelogin, or the device code expires.
 *
 * @param {string} deviceCode
 * @param {number} intervalSeconds
 * @param {number} expiresInSeconds
 * @param {(status:string)=>void} onTick optional progress callback
 */
async function pollForToken(deviceCode, intervalSeconds, expiresInSeconds, onTick) {
  const deadline = Date.now() + expiresInSeconds * 1000;
  let interval = Math.max(intervalSeconds, 3) * 1000;

  while (Date.now() < deadline) {
    await sleep(interval);
    try {
      const token = await postForm(TOKEN_URL, {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: CLIENT_ID,
        device_code: deviceCode,
      });
      return token; // { access_token, refresh_token, expires_in, ... }
    } catch (e) {
      const code = e.data && e.data.error;
      if (code === "authorization_pending") {
        onTick && onTick("waiting");
        continue;
      }
      if (code === "slow_down") {
        interval += 5000;
        onTick && onTick("slow_down");
        continue;
      }
      throw e; // authorization_declined, expired_token, or unknown error
    }
  }
  throw new Error("Device code expired before sign-in completed.");
}

async function refreshMsToken(refreshToken) {
  return postForm(TOKEN_URL, {
    grant_type: "refresh_token",
    client_id: CLIENT_ID,
    refresh_token: refreshToken,
    scope: SCOPE,
  });
}

/** Step 2: MS access token -> Xbox Live token + user hash. */
async function authenticateXBL(msAccessToken) {
  const data = await postJson(XBL_AUTH_URL, {
    Properties: {
      AuthMethod: "RPS",
      SiteName: "user.auth.xboxlive.com",
      RpsTicket: `d=${msAccessToken}`,
    },
    RelyingParty: "http://auth.xboxlive.com",
    TokenType: "JWT",
  });
  return {
    token: data.Token,
    userHash: data.DisplayClaims.xui[0].uhs,
  };
}

/** Step 3: XBL token -> XSTS token. */
async function authenticateXSTS(xblToken) {
  try {
    const data = await postJson(XSTS_AUTH_URL, {
      Properties: { SandboxId: "RETAIL", UserTokens: [xblToken] },
      RelyingParty: "rp://api.minecraftservices.com/",
      TokenType: "JWT",
    });
    return { token: data.Token, userHash: data.DisplayClaims.xui[0].uhs };
  } catch (e) {
    if (e.data && e.data.XErr) {
      throw new Error(describeXstsError(e.data.XErr));
    }
    throw e;
  }
}

function describeXstsError(xErr) {
  switch (xErr) {
    case 2148916233:
      return "This Microsoft account has no Xbox Live profile. Sign in at xbox.com once, then retry.";
    case 2148916235:
      return "Xbox Live is not available in this account's region.";
    case 2148916236:
    case 2148916237:
      return "This account needs adult verification (age gate) on xbox.com.";
    case 2148916238:
      return "This is a child account. An adult must add it to a Microsoft Family group first.";
    default:
      return `Xbox Live rejected the sign-in (error ${xErr}).`;
  }
}

/** Step 4: XSTS token + hash -> Minecraft Services access token. */
async function loginWithXbox(xstsToken, userHash) {
  const data = await postJson(MC_LOGIN_URL, {
    identityToken: `XBL3.0 x=${userHash};${xstsToken}`,
  });
  return data.access_token;
}

/** Optional but recommended: confirm the account actually owns Minecraft. */
async function checkOwnsGame(mcAccessToken) {
  const res = await fetch(MC_ENTITLEMENT_URL, {
    headers: { Authorization: `Bearer ${mcAccessToken}` },
  });
  if (!res.ok) return false;
  const data = await res.json();
  return Array.isArray(data.items) && data.items.length > 0;
}

/** Step 5: fetch the public profile (username, UUID, skin URLs). */
async function fetchProfile(mcAccessToken) {
  const res = await fetch(MC_PROFILE_URL, {
    headers: { Authorization: `Bearer ${mcAccessToken}` },
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.errorMessage || "This account does not own the game, or has no profile yet.");
  }
  return data; // { id, name, skins: [...], capes: [...] }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Full end-to-end sign-in. Emits progress via onProgress(stage, extra).
 * Returns { minecraftAccessToken, msRefreshToken, profile, ownsGame }.
 */
async function signIn(onProgress) {
  const notify = (stage, extra) => onProgress && onProgress(stage, extra);

  notify("requesting_code");
  const device = await requestDeviceCode();
  notify("awaiting_user", {
    verificationUri: device.verification_uri,
    userCode: device.user_code,
  });

  const msToken = await pollForToken(device.device_code, device.interval, device.expires_in, () =>
    notify("waiting")
  );

  notify("xbox_live");
  const xbl = await authenticateXBL(msToken.access_token);

  notify("xsts");
  const xsts = await authenticateXSTS(xbl.token);

  notify("minecraft_login");
  const mcAccessToken = await loginWithXbox(xsts.token, xsts.userHash);

  notify("checking_ownership");
  const ownsGame = await checkOwnsGame(mcAccessToken);

  notify("fetching_profile");
  const profile = ownsGame ? await fetchProfile(mcAccessToken) : null;

  notify("done");
  return {
    minecraftAccessToken: mcAccessToken,
    msRefreshToken: msToken.refresh_token,
    profile,
    ownsGame,
  };
}

module.exports = {
  signIn,
  refreshMsToken,
  authenticateXBL,
  authenticateXSTS,
  loginWithXbox,
  fetchProfile,
  checkOwnsGame,
};
