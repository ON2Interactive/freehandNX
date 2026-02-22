const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");

const ROOT = __dirname;

function cleanEnvValue(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, "utf8");
  content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .forEach((line) => {
      const idx = line.indexOf("=");
      if (idx <= 0) return;
      const key = line.slice(0, idx).trim();
      let value = line.slice(idx + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) {
        process.env[key] = value;
      }
    });
}

loadEnvFile(path.join(ROOT, ".env"));

const PORT = Number(process.env.PORT || 4174);
const SHARE_STORE_FILE = path.join(ROOT, ".freehandnx-shares.json");
const SHARE_PAYLOAD_MAX_BYTES = 40 * 1024 * 1024;
const SHARE_MAX_ITEMS = 300;
const SUPABASE_URL = cleanEnvValue(process.env.SUPABASE_URL || "");
const SUPABASE_SERVICE_ROLE_KEY = cleanEnvValue(process.env.SUPABASE_SERVICE_ROLE_KEY || "");
const SUPABASE_STORAGE_BUCKET = cleanEnvValue(process.env.SUPABASE_STORAGE_BUCKET || "freehandnx-assets");
const DEV_GUEST_MODE = /^(1|true|yes)$/i.test(cleanEnvValue(process.env.DEV_GUEST_MODE || ""));
const DEV_GUEST_EMAIL = cleanEnvValue(process.env.DEV_GUEST_EMAIL || "guest@freehandnx.local").toLowerCase();
const DEV_GUEST_PASSWORD = cleanEnvValue(process.env.DEV_GUEST_PASSWORD || "FreehandNX-Guest-Only-Temp-123!");
const PROJECT_SESSIONS_BUCKET = "project-sessions";
const PUBLIC_APP_ORIGIN = cleanEnvValue(
  process.env.FREEHANDNX_PUBLIC_ORIGIN || process.env.PUBLIC_APP_ORIGIN || process.env.NEXT_PUBLIC_SITE_URL || ""
);
const APP_ADMIN_EMAILS = new Set(
  (cleanEnvValue(process.env.APP_ADMIN_EMAILS || "kipme001@gmail.com") || "")
    .split(",")
    .map((email) => String(email || "").trim().toLowerCase())
    .filter(Boolean)
);
const ADMIN_LOGIN_EMAIL = normalizeEmail(cleanEnvValue(process.env.ADMIN_LOGIN_EMAIL || "kipme001@gmail.com"));
const ADMIN_LOGIN_PASSWORD = cleanEnvValue(process.env.ADMIN_LOGIN_PASSWORD || "FreehandNX@$@$");
const ADMIN_SESSION_COOKIE_NAME = "freehandnx_admin_session";
const ADMIN_SESSION_TTL_MS = Math.max(15 * 60 * 1000, Number(process.env.ADMIN_SESSION_TTL_MS || 12 * 60 * 60 * 1000));
const adminSessions = new Map();
const SENDGRID_API_KEY = cleanEnvValue(process.env.SENDGRID_API_KEY || "");
const MAIL_FROM_EMAIL = cleanEnvValue(process.env.CONTACT_FROM_EMAIL || process.env.MAIL_FROM_EMAIL || "");
const MAIL_FROM_NAME = cleanEnvValue(process.env.MAIL_FROM_NAME || "FreehandNX");
const SIGNUP_NOTIFY_EMAIL = cleanEnvValue(process.env.SIGNUP_NOTIFY_EMAIL || process.env.CONTACT_TO_EMAIL || "support@freehandnx.com");
const CREDITS_NOTIFY_EMAIL = cleanEnvValue(process.env.CREDITS_NOTIFY_EMAIL || SIGNUP_NOTIFY_EMAIL || "support@freehandnx.com");
const STRIPE_SECRET_KEY = cleanEnvValue(process.env.STRIPE_SECRET_KEY || "");
const STRIPE_WEBHOOK_SECRET = cleanEnvValue(process.env.STRIPE_WEBHOOK_SECRET || "");
const STRIPE_SUBSCRIPTION_PRICE_ID = cleanEnvValue(process.env.STRIPE_SUBSCRIPTION_PRICE_ID || "");
const STRIPE_CREDITS_PRICE_ID = cleanEnvValue(process.env.STRIPE_CREDITS_PRICE_ID || "");
const STRIPE_TOPUP_CREDITS = Math.max(1, Math.floor(Number(process.env.STRIPE_TOPUP_CREDITS || 200)));
const STRIPE_SUBSCRIPTION_CREDITS = Math.max(1, Math.floor(Number(process.env.STRIPE_SUBSCRIPTION_CREDITS || 200)));
const TRIAL_WINDOW_HOURS = Math.max(1, Math.floor(Number(process.env.FREEHANDNX_TRIAL_HOURS || 24)));
const AI_ACTION_CREDITS_COST = Math.max(1, Math.floor(Number(process.env.AI_ACTION_CREDITS_COST || 10)));

const MIME_BY_EXT = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function loadShareStore() {
  try {
    if (!fs.existsSync(SHARE_STORE_FILE)) return {};
    const raw = fs.readFileSync(SHARE_STORE_FILE, "utf8");
    const parsed = JSON.parse(raw || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}

let shareStore = loadShareStore();

function persistShareStore() {
  try {
    fs.writeFileSync(SHARE_STORE_FILE, JSON.stringify(shareStore, null, 2), "utf8");
  } catch (error) {
    console.error("Could not persist share store:", error?.message || error);
  }
}

function normalizeAbsoluteOrigin(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return "";
  }
}

function buildRequestOrigin(req) {
  const explicitOrigin = normalizeAbsoluteOrigin(PUBLIC_APP_ORIGIN);
  if (explicitOrigin) return explicitOrigin;
  const hostHeader = String(req.headers.host || `127.0.0.1:${PORT}`);
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const proto = forwardedProto || "http";
  return `${proto}://${hostHeader}`;
}

function buildPersistentPreviewUrl(origin, shareId) {
  const safeOrigin = normalizeAbsoluteOrigin(origin) || "";
  const safeShareId = normalizeShareIdCandidate(shareId);
  if (!safeOrigin || !safeShareId) return "";
  return `${safeOrigin}/preview/${encodeURIComponent(safeShareId)}`;
}

function normalizeRedirectUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    return parsed.toString();
  } catch {
    return "";
  }
}

function createShareId() {
  return crypto.randomBytes(9).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function normalizeShareIdCandidate(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(raw)) return "";
  return raw;
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function isValidEmailAddress(value) {
  const email = normalizeEmail(value);
  if (!email || email.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function isAdminEmail(email) {
  return APP_ADMIN_EMAILS.has(normalizeEmail(email));
}

function decodeJwtPayload(token) {
  const raw = String(token || "").trim();
  if (!raw) return null;
  const parts = raw.split(".");
  if (parts.length < 2) return null;
  const payloadPart = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const padded = payloadPart + "=".repeat((4 - (payloadPart.length % 4)) % 4);
  try {
    const json = Buffer.from(padded, "base64").toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function isLikelyUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || "").trim());
}

function getBearerToken(req) {
  const header = String(req.headers.authorization || "").trim();
  if (!header.toLowerCase().startsWith("bearer ")) return "";
  return header.slice(7).trim();
}

function getSupabaseServiceHeaders() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return { ok: false, error: "Supabase service role is not configured." };
  }
  const headers = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  };
  return {
    ok: true,
    config: { url: SUPABASE_URL },
    headers,
  };
}

function parseCookies(req) {
  const header = String(req.headers.cookie || "");
  if (!header) return {};
  return header.split(";").reduce((acc, pair) => {
    const idx = pair.indexOf("=");
    if (idx <= 0) return acc;
    const key = decodeURIComponent(pair.slice(0, idx).trim());
    const value = decodeURIComponent(pair.slice(idx + 1).trim());
    if (!key) return acc;
    acc[key] = value;
    return acc;
  }, {});
}

function getAdminSessionToken(req) {
  const cookies = parseCookies(req);
  return String(cookies[ADMIN_SESSION_COOKIE_NAME] || "").trim();
}

function cleanupAdminSessions() {
  const now = Date.now();
  for (const [token, session] of adminSessions.entries()) {
    if (!session || Number(session.expiresAt) <= now) {
      adminSessions.delete(token);
    }
  }
}

function createAdminSession(res, email) {
  cleanupAdminSessions();
  const token = crypto.randomBytes(24).toString("hex");
  const expiresAt = Date.now() + ADMIN_SESSION_TTL_MS;
  adminSessions.set(token, {
    token,
    email: normalizeEmail(email),
    createdAt: Date.now(),
    expiresAt,
  });
  const maxAgeSeconds = Math.floor(ADMIN_SESSION_TTL_MS / 1000);
  const proto = String(res?.req?.headers?.["x-forwarded-proto"] || "").toLowerCase();
  const secureAttr = proto.includes("https") ? "; Secure" : "";
  const cookieValue = `${ADMIN_SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secureAttr}`;
  res.setHeader("Set-Cookie", cookieValue);
}

function clearAdminSession(res, req) {
  const token = getAdminSessionToken(req);
  if (token) adminSessions.delete(token);
  const proto = String(req?.headers?.["x-forwarded-proto"] || "").toLowerCase();
  const secureAttr = proto.includes("https") ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `${ADMIN_SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureAttr}`
  );
}

function getAdminSessionFromRequest(req) {
  cleanupAdminSessions();
  const token = getAdminSessionToken(req);
  if (!token) return null;
  const session = adminSessions.get(token);
  if (!session) return null;
  if (Number(session.expiresAt) <= Date.now()) {
    adminSessions.delete(token);
    return null;
  }
  return session;
}

function requireAdminSession(req, res) {
  const session = getAdminSessionFromRequest(req);
  if (!session) {
    sendJson(res, 401, { error: "Admin authentication required." });
    return null;
  }
  return session;
}

async function handleAdminLogin(req, res) {
  try {
    const body = await parseJsonBody(req);
    const email = normalizeEmail(body?.email || "");
    const password = String(body?.password || "");
    if (!email || !password) {
      return sendJson(res, 400, { error: "Email and password are required." });
    }
    if (email !== ADMIN_LOGIN_EMAIL || password !== ADMIN_LOGIN_PASSWORD) {
      return sendJson(res, 401, { error: "Invalid admin credentials." });
    }
    createAdminSession(res, email);
    return sendJson(res, 200, { ok: true, redirectTo: "/admin" });
  } catch (error) {
    return sendJson(res, 400, { error: error?.message || "Invalid login request." });
  }
}

function handleAdminSession(req, res) {
  const session = getAdminSessionFromRequest(req);
  if (!session) return sendJson(res, 401, { ok: false, error: "Not authenticated." });
  return sendJson(res, 200, {
    ok: true,
    email: session.email,
    expiresAt: session.expiresAt,
  });
}

function handleAdminLogout(req, res) {
  clearAdminSession(res, req);
  return sendJson(res, 200, { ok: true });
}

async function handleAdminUsersList(req, res) {
  const session = requireAdminSession(req, res);
  if (!session) return;
  const service = getSupabaseServiceHeaders();
  if (!service.ok) return sendJson(res, 500, { error: service.error });
  const { config, headers } = service;
  const response = await fetch(
    `${config.url}/rest/v1/profiles?select=id,email,username,credits_balance,last_sign_in_at,created_at,updated_at&order=created_at.desc&limit=500`,
    {
      method: "GET",
      headers,
    }
  );
  if (!response.ok) {
    const reason = await response.text().catch(() => "");
    return sendJson(res, 502, { error: `Unable to load admin users.${reason ? ` ${reason}` : ""}` });
  }
  const rows = await response.json().catch(() => []);
  const users = Array.isArray(rows)
    ? rows.map((row) => ({
        id: String(row?.id || ""),
        email: String(row?.email || ""),
        username: String(row?.username || ""),
        creditsBalance: Number(row?.credits_balance || 0),
        lastSignInAt: row?.last_sign_in_at || null,
        createdAt: row?.created_at || null,
        updatedAt: row?.updated_at || null,
      }))
    : [];
  return sendJson(res, 200, { users });
}

async function handleAdminUserUpdate(req, res, userId) {
  const session = requireAdminSession(req, res);
  if (!session) return;
  if (!isLikelyUuid(userId)) return sendJson(res, 400, { error: "Invalid user id." });
  const service = getSupabaseServiceHeaders();
  if (!service.ok) return sendJson(res, 500, { error: service.error });
  try {
    const payload = await parseJsonBody(req);
    const nextUsername = String(payload?.username || "")
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, 80);
    const hasCredits = payload?.creditsBalance != null && payload?.creditsBalance !== "";
    const parsedCredits = Number(payload?.creditsBalance);
    const updatePayload = {};
    if (nextUsername) updatePayload.username = nextUsername;
    if (hasCredits) {
      if (!Number.isFinite(parsedCredits)) {
        return sendJson(res, 400, { error: "Credits value is invalid." });
      }
      updatePayload.credits_balance = Math.max(0, Math.round(parsedCredits));
    }

    const { config, headers } = service;
    const profileReadResponse = await fetch(
      `${config.url}/rest/v1/profiles?select=id,email,username,credits_balance,last_sign_in_at,created_at,updated_at&id=eq.${encodeURIComponent(userId)}&limit=1`,
      {
        method: "GET",
        headers,
      }
    );
    if (!profileReadResponse.ok) {
      const reason = await profileReadResponse.text().catch(() => "");
      return sendJson(res, 502, { error: `Unable to read user.${reason ? ` ${reason}` : ""}` });
    }
    const profileRows = await profileReadResponse.json().catch(() => []);
    const profile = Array.isArray(profileRows) ? profileRows[0] : null;
    if (!profile) return sendJson(res, 404, { error: "User not found." });

    const currentCredits = Math.max(0, Math.round(Number(profile?.credits_balance || 0)));
    if (!nextUsername || nextUsername === String(profile?.username || "").trim()) delete updatePayload.username;
    if (hasCredits && updatePayload.credits_balance === currentCredits) delete updatePayload.credits_balance;

    if (!Object.keys(updatePayload).length) {
      return sendJson(res, 200, {
        ok: true,
        user: {
          id: String(profile?.id || ""),
          email: String(profile?.email || ""),
          username: String(profile?.username || ""),
          creditsBalance: currentCredits,
          lastSignInAt: profile?.last_sign_in_at || null,
          createdAt: profile?.created_at || null,
          updatedAt: profile?.updated_at || null,
        },
      });
    }

    const response = await fetch(
      `${config.url}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}`,
      {
        method: "PATCH",
        headers: {
          ...headers,
          Prefer: "return=representation",
        },
        body: JSON.stringify(updatePayload),
      }
    );
    if (!response.ok) {
      const reason = await response.text().catch(() => "");
      return sendJson(res, 502, { error: `Unable to update user.${reason ? ` ${reason}` : ""}` });
    }
    const rows = await response.json().catch(() => []);
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row) return sendJson(res, 404, { error: "User not found." });
    const nextCredits = Math.max(0, Math.round(Number(row?.credits_balance || 0)));
    if (nextCredits > currentCredits) {
      sendCreditsPurchaseAndNotificationEmail({
        userName: String(row?.username || "").trim() || String(row?.email || "").trim(),
        userEmail: String(row?.email || "").trim(),
        creditsAdded: nextCredits - currentCredits,
        previousCredits: currentCredits,
        nextCredits,
      }).catch((error) => {
        console.error("Credits purchase email failed:", error?.message || error);
      });
    }
    return sendJson(res, 200, {
      ok: true,
      user: {
        id: String(row?.id || ""),
        email: String(row?.email || ""),
        username: String(row?.username || ""),
        creditsBalance: Number(row?.credits_balance || 0),
        lastSignInAt: row?.last_sign_in_at || null,
        createdAt: row?.created_at || null,
        updatedAt: row?.updated_at || null,
      },
    });
  } catch (error) {
    return sendJson(res, 400, { error: error?.message || "Invalid update payload." });
  }
}

async function handleAdminUserDelete(req, res, userId) {
  const session = requireAdminSession(req, res);
  if (!session) return;
  if (!isLikelyUuid(userId)) return sendJson(res, 400, { error: "Invalid user id." });
  const service = getSupabaseServiceHeaders();
  if (!service.ok) return sendJson(res, 500, { error: service.error });
  const { config, headers } = service;
  const response = await fetch(`${config.url}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
    method: "DELETE",
    headers,
  });
  if (!response.ok) {
    const reason = await response.text().catch(() => "");
    return sendJson(res, 502, { error: `Unable to delete user.${reason ? ` ${reason}` : ""}` });
  }
  return sendJson(res, 200, { ok: true });
}

async function handleAdminUserEmail(req, res) {
  const session = requireAdminSession(req, res);
  if (!session) return;
  const service = getSupabaseServiceHeaders();
  if (!service.ok) return sendJson(res, 500, { error: service.error });
  if (!SENDGRID_API_KEY || !MAIL_FROM_EMAIL) {
    return sendJson(res, 500, { error: "Email is not configured. Set SENDGRID_API_KEY and CONTACT_FROM_EMAIL." });
  }
  try {
    const payload = await parseJsonBody(req);
    const userId = String(payload?.userId || "").trim();
    const toEmailRaw = normalizeEmail(payload?.email || "");
    const subject = String(payload?.subject || "").trim();
    const message = String(payload?.message || "").trim();
    const userName = String(payload?.name || "").trim();

    if (!isLikelyUuid(userId)) return sendJson(res, 400, { error: "Invalid user id." });
    if (!subject || !message) return sendJson(res, 400, { error: "Subject and message are required." });
    if (subject.length > 180 || message.length > 8000 || userName.length > 120) {
      return sendJson(res, 400, { error: "Input is too long." });
    }

    const { config, headers } = service;
    const profileResponse = await fetch(
      `${config.url}/rest/v1/profiles?select=id,email,username&id=eq.${encodeURIComponent(userId)}&limit=1`,
      {
        method: "GET",
        headers,
      }
    );
    if (!profileResponse.ok) {
      const reason = await profileResponse.text().catch(() => "");
      return sendJson(res, 502, { error: `Unable to read user profile.${reason ? ` ${reason}` : ""}` });
    }
    const profileRows = await profileResponse.json().catch(() => []);
    const profile = Array.isArray(profileRows) ? profileRows[0] : null;
    if (!profile) return sendJson(res, 404, { error: "User not found." });

    const profileEmail = normalizeEmail(profile?.email || "");
    if (!isValidEmailAddress(profileEmail)) return sendJson(res, 400, { error: "User email is invalid." });
    if (toEmailRaw && toEmailRaw !== profileEmail) {
      return sendJson(res, 400, { error: "Email must match the selected user." });
    }

    const safeName = userName || String(profile?.username || "").trim() || "there";
    const textBody = [`Hi ${safeName},`, "", message, "", "The FreehandNX Team"].join("\n");
    const htmlBody = `
      <p>Hi ${escapeHtml(safeName)},</p>
      <p>${escapeHtml(message).replace(/\n/g, "<br />")}</p>
      <p>The FreehandNX Team</p>
    `;
    const sendResult = await sendSendgridMail({
      toEmail: profileEmail,
      subject,
      textBody,
      htmlBody,
    });
    if (!sendResult.ok) {
      return sendJson(res, sendResult.status || 502, { error: sendResult.error || "Failed to send email." });
    }
    return sendJson(res, 200, { ok: true });
  } catch (error) {
    return sendJson(res, 400, { error: error?.message || "Invalid request." });
  }
}

function normalizeProfileUsername(email = "") {
  const base = String(email || "")
    .toLowerCase()
    .split("@")[0]
    .replace(/[^a-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return (base || "freehandnx_user").slice(0, 32);
}

async function ensureSupabaseProfileRecord(user, options = {}) {
  const userId = String(user?.id || "").trim();
  const email = normalizeEmail(user?.email || "");
  const displayName = String(user?.name || "").trim();
  const skipWelcomeEmail = Boolean(options?.skipWelcomeEmail);
  if (!isLikelyUuid(userId) || !email) {
    return { ok: false, status: 400, error: "Invalid user profile payload." };
  }
  const service = getSupabaseServiceHeaders();
  if (!service.ok) return { ok: false, status: 500, error: service.error };
  const { config, headers } = service;
  const existingResponse = await fetch(
    `${config.url}/rest/v1/profiles?select=id,email,username,credits_balance&id=eq.${encodeURIComponent(userId)}&limit=1`,
    {
      method: "GET",
      headers,
    }
  );
  if (!existingResponse.ok) {
    const reason = await existingResponse.text().catch(() => "");
    return {
      ok: false,
      status: 502,
      error: `Unable to read profile record.${reason ? ` ${reason}` : ""}`,
    };
  }
  const existingRows = await existingResponse.json().catch(() => []);
  const existing = Array.isArray(existingRows) ? existingRows[0] : null;
  if (existing) {
    const patchResponse = await fetch(`${config.url}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}`, {
      method: "PATCH",
      headers: {
        ...headers,
        Prefer: "return=minimal",
      },
      body: JSON.stringify({ last_sign_in_at: new Date().toISOString() }),
    });
    if (!patchResponse.ok) {
      const reason = await patchResponse.text().catch(() => "");
      return {
        ok: false,
        status: 502,
        error: `Unable to update profile sign-in timestamp.${reason ? ` ${reason}` : ""}`,
      };
    }
    return {
      ok: true,
      created: false,
      profile: {
        id: String(existing?.id || userId),
        email: normalizeEmail(existing?.email || email),
        username: String(existing?.username || ""),
        creditsBalance: Number(existing?.credits_balance || 0),
      },
    };
  }

  const response = await fetch(`${config.url}/rest/v1/profiles`, {
    method: "POST",
    headers: {
      ...headers,
      Prefer: "return=minimal",
    },
    body: JSON.stringify([
      {
        id: userId,
        email,
        username: normalizeProfileUsername(email),
        last_sign_in_at: new Date().toISOString(),
      },
    ]),
  });
  if (response.ok) {
    if (!skipWelcomeEmail) {
      sendSignupWelcomeAndNotificationEmail({ userName: displayName || normalizeProfileUsername(email), userEmail: email }).catch((error) => {
        console.error("Signup welcome email failed:", error?.message || error);
      });
    }
    return {
      ok: true,
      created: true,
      profile: {
        id: userId,
        email,
        username: normalizeProfileUsername(email),
        creditsBalance: 0,
      },
    };
  }
  const reason = await response.text().catch(() => "");
  if (response.status === 409) {
    return { ok: true, created: false };
  }
  return {
    ok: false,
    status: 502,
    error: `Unable to ensure profile record.${reason ? ` ${reason}` : ""}`,
  };
}

let devGuestUserCache = null;
let devGuestUserPromise = null;

async function lookupSupabaseAuthUserByEmail(service, email) {
  const { config, headers } = service;
  const response = await fetch(
    `${config.url}/auth/v1/admin/users?email=${encodeURIComponent(email)}&page=1&per_page=50`,
    {
      method: "GET",
      headers,
    }
  );
  if (!response.ok) return null;
  const payload = await response.json().catch(() => ({}));
  const users = Array.isArray(payload?.users) ? payload.users : [];
  const found = users.find((entry) => normalizeEmail(entry?.email) === normalizeEmail(email));
  if (!found) return null;
  return {
    id: String(found?.id || "").trim(),
    email: normalizeEmail(found?.email || email),
  };
}

async function ensureDevGuestSupabaseUser() {
  if (devGuestUserCache?.id && devGuestUserCache?.email) {
    return { ok: true, user: devGuestUserCache };
  }
  if (devGuestUserPromise) return devGuestUserPromise;
  devGuestUserPromise = (async () => {
    const service = getSupabaseServiceHeaders();
    if (!service.ok) return { ok: false, status: 500, error: service.error };
    const existing = await lookupSupabaseAuthUserByEmail(service, DEV_GUEST_EMAIL);
    let guestUser = existing;
    if (!guestUser) {
      const { config, headers } = service;
      const createResponse = await fetch(`${config.url}/auth/v1/admin/users`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          email: DEV_GUEST_EMAIL,
          password: DEV_GUEST_PASSWORD,
          email_confirm: true,
          user_metadata: {
            full_name: "FreehandNX Guest",
          },
        }),
      });
      if (createResponse.ok) {
        const created = await createResponse.json().catch(() => ({}));
        guestUser = {
          id: String(created?.id || created?.user?.id || "").trim(),
          email: normalizeEmail(created?.email || created?.user?.email || DEV_GUEST_EMAIL),
        };
      } else {
        const fallback = await lookupSupabaseAuthUserByEmail(service, DEV_GUEST_EMAIL);
        if (!fallback) {
          const reason = await createResponse.text().catch(() => "");
          return { ok: false, status: 502, error: `Unable to provision guest user.${reason ? ` ${reason}` : ""}` };
        }
        guestUser = fallback;
      }
    }
    if (!isLikelyUuid(guestUser?.id)) {
      return { ok: false, status: 500, error: "Guest user id is invalid." };
    }
    const profileReady = await ensureSupabaseProfileRecord(guestUser, { skipWelcomeEmail: true });
    if (!profileReady.ok) return profileReady;
    devGuestUserCache = guestUser;
    return { ok: true, user: guestUser };
  })();
  try {
    return await devGuestUserPromise;
  } finally {
    devGuestUserPromise = null;
  }
}

async function getAuthenticatedSupabaseUser(req) {
  const token = getBearerToken(req);
  if (!token) {
    if (DEV_GUEST_MODE) {
      const guest = await ensureDevGuestSupabaseUser();
      if (!guest.ok) return guest;
      return {
        ok: true,
        user: guest.user,
        isDevGuest: true,
      };
    }
    return { ok: false, status: 401, error: "Sign in required." };
  }
  const claims = decodeJwtPayload(token);
  const userId = String(claims?.sub || "").trim();
  if (!isLikelyUuid(userId)) return { ok: false, status: 401, error: "Invalid auth token." };
  const user = {
    id: userId,
    email: String(claims?.email || "").trim().toLowerCase(),
    name: String(claims?.name || claims?.user_metadata?.full_name || "").trim(),
  };
  const profileReady = await ensureSupabaseProfileRecord(user);
  if (!profileReady.ok) return profileReady;
  return {
    ok: true,
    user,
  };
}

function parseJsonBody(req, options = {}) {
  const maxBytes = Math.max(1024, Number(options.maxBytes) || 4 * 1024 * 1024);
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    req.on("data", (chunk) => {
      chunks.push(chunk);
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        reject(new Error("Request body too large."));
      }
    });
    req.on("end", () => {
      try {
        const compressedBody = Buffer.concat(chunks);
        let bodyBuffer = compressedBody;
        const contentEncoding = String(req.headers["content-encoding"] || "").toLowerCase();
        if (contentEncoding.includes("gzip")) {
          bodyBuffer = zlib.gunzipSync(compressedBody);
        }
        resolve(JSON.parse(bodyBuffer.toString("utf8") || "{}"));
      } catch {
        reject(new Error("Invalid JSON body."));
      }
    });
    req.on("error", reject);
  });
}

async function sendSendgridMail({ toEmail, subject, textBody, htmlBody, replyTo = null }) {
  if (!SENDGRID_API_KEY || !MAIL_FROM_EMAIL || !isValidEmailAddress(toEmail)) {
    return { ok: false, status: 500, error: "Email is not configured." };
  }
  const payload = {
    personalizations: [{ to: [{ email: toEmail }], subject: String(subject || "").trim() || "FreehandNX" }],
    from: { email: MAIL_FROM_EMAIL, name: MAIL_FROM_NAME || "FreehandNX" },
    ...(replyTo ? { reply_to: replyTo } : {}),
    content: [
      { type: "text/plain", value: String(textBody || "") },
      { type: "text/html", value: String(htmlBody || "") },
    ],
  };
  const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SENDGRID_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const reason = await response.text().catch(() => "");
    return { ok: false, status: response.status || 502, error: reason || "Failed to send email." };
  }
  return { ok: true };
}

async function sendSignupWelcomeAndNotificationEmail({ userName, userEmail }) {
  const targetEmail = normalizeEmail(userEmail);
  if (!targetEmail || !isValidEmailAddress(targetEmail) || !SENDGRID_API_KEY || !MAIL_FROM_EMAIL) return;

  const safeName = String(userName || "").trim() || "there";
  const welcomeSubject = "Welcome to FreehandNX";
  const welcomeText = [
    `Hi ${safeName},`,
    "",
    "Welcome to FreehandNX - we're glad you're here.",
    "",
    "FreehandNX is built for creators who need complete layout control without unnecessary complexity. Design posters, photobooks, magazines, and other publication formats in a clean, modern canvas workflow.",
    "",
    "Here’s what you can do right away:",
    "- Start a new publication layout in seconds",
    "- Use AI Image, Image Edit, and Vector Art tools directly in the editor",
    "- Build with precise grids, typography, and page-level control",
    "- Export to HTML, PDF, or images when you are ready",
    "",
    "If you have feedback or ideas, reply to this email - we read everything.",
    "",
    "Thanks for building with us,",
    "The FreehandNX Team",
  ].join("\n");
  const welcomeHtml = `
    <p>Hi ${escapeHtml(safeName)},</p>
    <p>Welcome to FreehandNX - we're glad you're here.</p>
    <p>FreehandNX is built for creators who need complete layout control without unnecessary complexity. Design posters, photobooks, magazines, and other publication formats in a clean, modern canvas workflow.</p>
    <p>Here’s what you can do right away:</p>
    <ul>
      <li>Start a new publication layout in seconds</li>
      <li>Use AI Image, Image Edit, and Vector Art tools directly in the editor</li>
      <li>Build with precise grids, typography, and page-level control</li>
      <li>Export to HTML, PDF, or images when you are ready</li>
    </ul>
    <p>If you have feedback or ideas, reply to this email - we read everything.</p>
    <p>Thanks for building with us,<br />The FreehandNX Team</p>
  `;

  const internalSubject = "FreehandNX: New user signup";
  const internalText = [
    "A new user signed up for FreehandNX.",
    "",
    `Name: ${safeName}`,
    `Email: ${targetEmail}`,
    `Signed up at: ${new Date().toISOString()}`,
  ].join("\n");
  const internalHtml = `
    <p>A new user signed up for FreehandNX.</p>
    <p><strong>Name:</strong> ${escapeHtml(safeName)}</p>
    <p><strong>Email:</strong> ${escapeHtml(targetEmail)}</p>
    <p><strong>Signed up at:</strong> ${new Date().toISOString()}</p>
  `;

  await sendSendgridMail({
    toEmail: targetEmail,
    subject: welcomeSubject,
    textBody: welcomeText,
    htmlBody: welcomeHtml,
  });

  if (isValidEmailAddress(SIGNUP_NOTIFY_EMAIL)) {
    await sendSendgridMail({
      toEmail: SIGNUP_NOTIFY_EMAIL,
      subject: internalSubject,
      textBody: internalText,
      htmlBody: internalHtml,
    });
  }
}

async function sendCreditsPurchaseAndNotificationEmail({ userName, userEmail, creditsAdded, previousCredits, nextCredits }) {
  const targetEmail = normalizeEmail(userEmail);
  const added = Math.max(0, Math.floor(Number(creditsAdded) || 0));
  if (!targetEmail || !isValidEmailAddress(targetEmail) || !added || !SENDGRID_API_KEY || !MAIL_FROM_EMAIL) return;

  const safeName = String(userName || "").trim() || "there";
  const prev = Math.max(0, Math.floor(Number(previousCredits) || 0));
  const next = Math.max(prev + added, Math.floor(Number(nextCredits) || 0));
  const subject = "FreehandNX credits added";
  const textBody = [
    `Hi ${safeName},`,
    "",
    `Your FreehandNX account has been credited with ${added} credit${added === 1 ? "" : "s"}.`,
    `Previous balance: ${prev}`,
    `Current balance: ${next}`,
    "",
    "Thanks for using FreehandNX.",
  ].join("\n");
  const htmlBody = `
    <p>Hi ${escapeHtml(safeName)},</p>
    <p>Your FreehandNX account has been credited with <strong>${added}</strong> credit${added === 1 ? "" : "s"}.</p>
    <p><strong>Previous balance:</strong> ${prev}<br /><strong>Current balance:</strong> ${next}</p>
    <p>Thanks for using FreehandNX.</p>
  `;

  await sendSendgridMail({
    toEmail: targetEmail,
    subject,
    textBody,
    htmlBody,
  });

  if (isValidEmailAddress(CREDITS_NOTIFY_EMAIL)) {
    const notifyText = [
      "A FreehandNX user purchased credits.",
      "",
      `Name: ${safeName}`,
      `Email: ${targetEmail}`,
      `Credits added: ${added}`,
      `Previous balance: ${prev}`,
      `New balance: ${next}`,
      `Time: ${new Date().toISOString()}`,
    ].join("\n");
    const notifyHtml = `
      <p>A FreehandNX user purchased credits.</p>
      <p><strong>Name:</strong> ${escapeHtml(safeName)}</p>
      <p><strong>Email:</strong> ${escapeHtml(targetEmail)}</p>
      <p><strong>Credits added:</strong> ${added}</p>
      <p><strong>Previous balance:</strong> ${prev}</p>
      <p><strong>New balance:</strong> ${next}</p>
      <p><strong>Time:</strong> ${new Date().toISOString()}</p>
    `;
    await sendSendgridMail({
      toEmail: CREDITS_NOTIFY_EMAIL,
      subject: "FreehandNX: Credits purchase",
      textBody: notifyText,
      htmlBody: notifyHtml,
    });
  }
}

function hasStripeConfig() {
  return Boolean(STRIPE_SECRET_KEY);
}

async function readRawBody(req, options = {}) {
  const maxBytes = Math.max(1024, Number(options.maxBytes) || 2 * 1024 * 1024);
  return await new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    req.on("data", (chunk) => {
      chunks.push(chunk);
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        reject(new Error("Request body too large."));
      }
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function verifyStripeWebhookSignature(rawBody, signatureHeader, webhookSecret) {
  if (!rawBody || !signatureHeader || !webhookSecret) return false;
  const parts = String(signatureHeader || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const timestampPart = parts.find((part) => part.startsWith("t="));
  const signaturePart = parts.find((part) => part.startsWith("v1="));
  if (!timestampPart || !signaturePart) return false;
  const timestamp = timestampPart.slice(2);
  const received = signaturePart.slice(3);
  if (!timestamp || !received) return false;
  const signedPayload = `${timestamp}.${rawBody.toString("utf8")}`;
  const expected = crypto
    .createHmac("sha256", webhookSecret)
    .update(signedPayload, "utf8")
    .digest("hex");
  const expectedBuffer = Buffer.from(expected, "utf8");
  const receivedBuffer = Buffer.from(received, "utf8");
  if (expectedBuffer.length !== receivedBuffer.length) return false;
  return crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}

function stripeRequest(pathname, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  const query = options.query instanceof URLSearchParams ? options.query : null;
  const body = options.body instanceof URLSearchParams ? options.body : null;
  const requestUrl = new URL(`https://api.stripe.com/v1/${String(pathname || "").replace(/^\/+/, "")}`);
  if (query) {
    for (const [key, value] of query.entries()) requestUrl.searchParams.append(key, value);
  }
  return fetch(requestUrl.toString(), {
    method,
    headers: {
      Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
      ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    ...(body ? { body: body.toString() } : {}),
  });
}

async function fetchStripeCustomerByEmail(email) {
  const target = normalizeEmail(email);
  if (!target || !hasStripeConfig()) return null;
  const query = new URLSearchParams();
  query.set("email", target);
  query.set("limit", "1");
  const response = await stripeRequest("/customers", { method: "GET", query });
  if (!response.ok) return null;
  const payload = await response.json().catch(() => ({}));
  const customers = Array.isArray(payload?.data) ? payload.data : [];
  return customers[0] || null;
}

async function ensureStripeCustomerForUser({ email, userId, name }) {
  const targetEmail = normalizeEmail(email);
  if (!targetEmail || !hasStripeConfig()) return null;
  const existing = await fetchStripeCustomerByEmail(targetEmail);
  if (existing?.id) return existing;
  const body = new URLSearchParams();
  body.set("email", targetEmail);
  if (userId) body.set("metadata[user_id]", String(userId));
  if (name) body.set("name", String(name).slice(0, 120));
  const response = await stripeRequest("/customers", { method: "POST", body });
  if (!response.ok) {
    const reason = await response.text().catch(() => "");
    throw new Error(reason || "Unable to create Stripe customer.");
  }
  return await response.json().catch(() => null);
}

async function fetchStripeSubscriptionSummary(customerId) {
  if (!customerId || !hasStripeConfig()) return { subscriptionActive: false, subscriptionStatus: "inactive" };
  const query = new URLSearchParams();
  query.set("customer", String(customerId));
  query.set("status", "all");
  query.set("limit", "20");
  const response = await stripeRequest("/subscriptions", { method: "GET", query });
  if (!response.ok) return { subscriptionActive: false, subscriptionStatus: "inactive" };
  const payload = await response.json().catch(() => ({}));
  const subscriptions = Array.isArray(payload?.data) ? payload.data : [];
  const activeLike = subscriptions.find((sub) => ["active", "trialing", "past_due"].includes(String(sub?.status || "")));
  if (!activeLike) return { subscriptionActive: false, subscriptionStatus: "inactive" };
  return {
    subscriptionActive: true,
    subscriptionStatus: String(activeLike.status || "active"),
    subscriptionId: String(activeLike.id || ""),
  };
}

async function getProfileByUserId(service, userId) {
  const { config, headers } = service;
  const response = await fetch(
    `${config.url}/rest/v1/profiles?select=id,email,username,credits_balance,created_at&id=eq.${encodeURIComponent(userId)}&limit=1`,
    {
      method: "GET",
      headers,
    }
  );
  if (!response.ok) return null;
  const rows = await response.json().catch(() => []);
  return Array.isArray(rows) ? rows[0] : null;
}

async function getProfileByEmail(service, email) {
  const target = normalizeEmail(email);
  if (!target) return null;
  const { config, headers } = service;
  const response = await fetch(
    `${config.url}/rest/v1/profiles?select=id,email,username,credits_balance,created_at&email=eq.${encodeURIComponent(target)}&limit=1`,
    {
      method: "GET",
      headers,
    }
  );
  if (!response.ok) return null;
  const rows = await response.json().catch(() => []);
  return Array.isArray(rows) ? rows[0] : null;
}

async function applyStripeCreditsTopup(service, userId, creditsDelta, sourceToken, meta = {}) {
  if (!isLikelyUuid(userId)) return { ok: false, status: 400, error: "Invalid user id." };
  const delta = Math.max(1, Math.floor(Number(creditsDelta) || 0));
  const { config, headers } = service;
  const existingResponse = await fetch(
    `${config.url}/rest/v1/credit_ledger?select=id&user_id=eq.${encodeURIComponent(userId)}&source=eq.${encodeURIComponent(sourceToken)}&limit=1`,
    {
      method: "GET",
      headers,
    }
  );
  if (existingResponse.ok) {
    const rows = await existingResponse.json().catch(() => []);
    if (Array.isArray(rows) && rows.length > 0) {
      const profile = await getProfileByUserId(service, userId);
      return {
        ok: true,
        alreadyApplied: true,
        previousCredits: Math.max(0, Math.floor(Number(profile?.credits_balance || 0))),
        nextCredits: Math.max(0, Math.floor(Number(profile?.credits_balance || 0))),
        profile,
      };
    }
  }

  const profile = await getProfileByUserId(service, userId);
  if (!profile) return { ok: false, status: 404, error: "User profile not found." };
  const previousCredits = Math.max(0, Math.floor(Number(profile?.credits_balance || 0)));
  const nextCredits = previousCredits + delta;

  const ledgerResponse = await fetch(`${config.url}/rest/v1/credit_ledger`, {
    method: "POST",
    headers: {
      ...headers,
      Prefer: "return=minimal",
    },
    body: JSON.stringify([
      {
        user_id: userId,
        project_id: null,
        delta,
        reason: "stripe_topup",
        source: sourceToken,
        meta,
      },
    ]),
  });
  if (!ledgerResponse.ok) {
    const reason = await ledgerResponse.text().catch(() => "");
    return { ok: false, status: 502, error: `Unable to record top-up ledger.${reason ? ` ${reason}` : ""}` };
  }

  const patchResponse = await fetch(`${config.url}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}`, {
    method: "PATCH",
    headers: {
      ...headers,
      Prefer: "return=representation",
    },
    body: JSON.stringify({ credits_balance: nextCredits }),
  });
  if (!patchResponse.ok) {
    const reason = await patchResponse.text().catch(() => "");
    return { ok: false, status: 502, error: `Unable to apply top-up credits.${reason ? ` ${reason}` : ""}` };
  }
  const rows = await patchResponse.json().catch(() => []);
  const updatedProfile = Array.isArray(rows) ? rows[0] : profile;
  return {
    ok: true,
    previousCredits,
    nextCredits: Math.max(0, Math.floor(Number(updatedProfile?.credits_balance || nextCredits))),
    profile: updatedProfile,
  };
}

function computeTrialStatus(createdAtValue) {
  const nowMs = Date.now();
  const createdAtMs = Date.parse(String(createdAtValue || ""));
  if (!Number.isFinite(createdAtMs)) {
    return {
      trialStartedAt: "",
      trialEndsAt: "",
      trialActive: false,
      trialExpired: true,
    };
  }
  const trialEndsAtMs = createdAtMs + TRIAL_WINDOW_HOURS * 60 * 60 * 1000;
  return {
    trialStartedAt: new Date(createdAtMs).toISOString(),
    trialEndsAt: new Date(trialEndsAtMs).toISOString(),
    trialActive: nowMs < trialEndsAtMs,
    trialExpired: nowMs >= trialEndsAtMs,
  };
}

function buildAccessSummary({ subscriptionSummary, profile, createdAtFallback }) {
  const subscriptionActive = Boolean(subscriptionSummary?.subscriptionActive);
  const subscriptionStatus = String(subscriptionSummary?.subscriptionStatus || "inactive");
  const trial = computeTrialStatus(profile?.created_at || createdAtFallback || "");
  const creditsBalance = Math.max(0, Math.floor(Number(profile?.credits_balance || 0)));
  const canUsePaidFeatures = subscriptionActive;
  return {
    subscriptionActive,
    subscriptionStatus,
    subscriptionId: String(subscriptionSummary?.subscriptionId || ""),
    customerId: String(subscriptionSummary?.customerId || ""),
    trialStartedAt: trial.trialStartedAt,
    trialEndsAt: trial.trialEndsAt,
    trialActive: trial.trialActive,
    trialExpired: trial.trialExpired,
    creditsBalance,
    aiActionCreditsCost: AI_ACTION_CREDITS_COST,
    canGenerate: canUsePaidFeatures && creditsBalance >= AI_ACTION_CREDITS_COST,
    canExport: canUsePaidFeatures,
  };
}

async function applyAiCreditDeduction(service, userId, sourceToken, meta = {}) {
  if (!isLikelyUuid(userId)) return { ok: false, status: 400, error: "Invalid user id." };
  const { config, headers } = service;
  const existingResponse = await fetch(
    `${config.url}/rest/v1/credit_ledger?select=id&user_id=eq.${encodeURIComponent(userId)}&source=eq.${encodeURIComponent(sourceToken)}&limit=1`,
    {
      method: "GET",
      headers,
    }
  );
  if (existingResponse.ok) {
    const rows = await existingResponse.json().catch(() => []);
    if (Array.isArray(rows) && rows.length > 0) {
      const profile = await getProfileByUserId(service, userId);
      const credits = Math.max(0, Math.floor(Number(profile?.credits_balance || 0)));
      return { ok: true, alreadyApplied: true, remainingCredits: credits };
    }
  }

  const profile = await getProfileByUserId(service, userId);
  if (!profile) return { ok: false, status: 404, error: "User profile not found." };
  const currentCredits = Math.max(0, Math.floor(Number(profile?.credits_balance || 0)));
  if (currentCredits < AI_ACTION_CREDITS_COST) {
    return { ok: false, status: 402, error: `Need ${AI_ACTION_CREDITS_COST} credits to continue.`, remainingCredits: currentCredits };
  }
  const nextCredits = currentCredits - AI_ACTION_CREDITS_COST;
  const ledgerResponse = await fetch(`${config.url}/rest/v1/credit_ledger`, {
    method: "POST",
    headers: {
      ...headers,
      Prefer: "return=minimal",
    },
    body: JSON.stringify([
      {
        user_id: userId,
        project_id: null,
        delta: -AI_ACTION_CREDITS_COST,
        reason: "ai_generation",
        source: sourceToken,
        meta,
      },
    ]),
  });
  if (!ledgerResponse.ok) {
    const reason = await ledgerResponse.text().catch(() => "");
    return { ok: false, status: 502, error: `Unable to record AI credit usage.${reason ? ` ${reason}` : ""}` };
  }
  const patchResponse = await fetch(`${config.url}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}`, {
    method: "PATCH",
    headers: {
      ...headers,
      Prefer: "return=representation",
    },
    body: JSON.stringify({ credits_balance: nextCredits }),
  });
  if (!patchResponse.ok) {
    const reason = await patchResponse.text().catch(() => "");
    return { ok: false, status: 502, error: `Unable to apply AI credit usage.${reason ? ` ${reason}` : ""}` };
  }
  const rows = await patchResponse.json().catch(() => []);
  const updatedProfile = Array.isArray(rows) ? rows[0] : profile;
  return {
    ok: true,
    remainingCredits: Math.max(0, Math.floor(Number(updatedProfile?.credits_balance || nextCredits))),
  };
}

async function handleAuthBootstrap(req, res) {
  try {
    const body = await parseJsonBody(req);
    const accessToken = String(body?.accessToken || "").trim();
    if (!accessToken) {
      return sendJson(res, 400, { error: "Missing access token." });
    }
    const claims = decodeJwtPayload(accessToken) || {};
    const email = normalizeEmail(claims?.email || body?.email);
    const userId = String(claims?.sub || body?.userId || "").trim() || `usr_${createShareId()}`;
    if (!email) {
      return sendJson(res, 400, { error: "Could not determine user email from access token." });
    }
    const profile = {
      id: userId,
      email,
      name: String(claims?.name || claims?.user_metadata?.full_name || email.split("@")[0]),
      isAdmin: isAdminEmail(email),
      creditsBalance: 0,
    };
    if (isLikelyUuid(userId)) {
      const ensureResult = await ensureSupabaseProfileRecord({
        id: userId,
        email,
        name: profile.name,
      });
      if (!ensureResult.ok) {
        console.error("Auth bootstrap profile ensure failed:", ensureResult.error || "Unknown error");
      }
    }
    return sendJson(res, 200, {
      ok: true,
      profile,
      redirectTo: "/editor",
      activeProject: null,
    });
  } catch (error) {
    return sendJson(res, 400, { error: error?.message || "Could not bootstrap auth session." });
  }
}

function handleAuthGoogleStart(req, res) {
  if (!SUPABASE_URL) {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    res.end("Supabase OAuth is not configured.");
    return;
  }
  const reqUrl = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
  const requested = normalizeRedirectUrl(reqUrl.searchParams.get("redirect_to"));
  const fallbackRedirect = `${buildRequestOrigin(req)}/auth-callback`;
  const redirectTo = requested || fallbackRedirect;
  const authorizeUrl = new URL("/auth/v1/authorize", SUPABASE_URL);
  authorizeUrl.searchParams.set("provider", "google");
  authorizeUrl.searchParams.set("redirect_to", redirectTo);
  // Always show Google account chooser instead of silently reusing an active session.
  authorizeUrl.searchParams.set("prompt", "select_account");
  res.writeHead(302, {
    Location: authorizeUrl.toString(),
    "Cache-Control": "no-store",
  });
  res.end();
}

async function handleAccessStatus(req, res) {
  const authResult = await getAuthenticatedSupabaseUser(req);
  if (!authResult.ok) {
    return sendJson(res, authResult.status || 401, {
      error: authResult.error || "Sign in required.",
      subscriptionActive: false,
      subscriptionStatus: "inactive",
      creditsBalance: 0,
      aiActionCreditsCost: AI_ACTION_CREDITS_COST,
      trialStartedAt: "",
      trialEndsAt: "",
      trialActive: false,
      trialExpired: true,
      canGenerate: false,
      canExport: false,
    });
  }
  const service = getSupabaseServiceHeaders();
  if (!service.ok) return sendJson(res, 500, { error: service.error });
  const userId = String(authResult.user?.id || "").trim();
  let email = normalizeEmail(authResult.user?.email || "");
  const profile = await getProfileByUserId(service, userId);
  if (!email) email = normalizeEmail(profile?.email || "");
  let subscriptionSummary = {
    subscriptionActive: false,
    subscriptionStatus: "inactive",
    subscriptionId: "",
    customerId: "",
  };
  if (hasStripeConfig() && email) {
    const customer = await fetchStripeCustomerByEmail(email);
    if (customer?.id) {
      const stripeSummary = await fetchStripeSubscriptionSummary(customer.id);
      subscriptionSummary = {
        ...stripeSummary,
        customerId: String(customer.id || ""),
      };
    }
  }
  return sendJson(
    res,
    200,
    buildAccessSummary({
      subscriptionSummary,
      profile,
      createdAtFallback: authResult.user?.created_at || "",
    })
  );
}

async function handleStripeCheckoutSubscription(req, res) {
  if (!hasStripeConfig() || !STRIPE_SUBSCRIPTION_PRICE_ID) {
    return sendJson(res, 500, { error: "Stripe subscription checkout is not configured." });
  }
  const authResult = await getAuthenticatedSupabaseUser(req);
  if (!authResult.ok) return sendJson(res, authResult.status || 401, { error: authResult.error || "Unauthorized." });
  const service = getSupabaseServiceHeaders();
  if (!service.ok) return sendJson(res, 500, { error: service.error });
  const userId = String(authResult.user?.id || "").trim();
  const profile = await getProfileByUserId(service, userId);
  const email = normalizeEmail(authResult.user?.email || profile?.email || "");
  if (!email) return sendJson(res, 400, { error: "User email is missing." });
  try {
    const customer = await ensureStripeCustomerForUser({
      email,
      userId,
      name: String(profile?.username || email.split("@")[0]),
    });
    const origin = buildRequestOrigin(req);
    const body = new URLSearchParams();
    body.set("mode", "subscription");
    body.set("customer", String(customer?.id || ""));
    body.set("line_items[0][price]", STRIPE_SUBSCRIPTION_PRICE_ID);
    body.set("line_items[0][quantity]", "1");
    body.set("success_url", `${origin}/pricing?subscription=success`);
    body.set("cancel_url", `${origin}/pricing?subscription=cancel`);
    body.set("allow_promotion_codes", "true");
    body.set("client_reference_id", userId);
    body.set("metadata[user_id]", userId);
    body.set("subscription_data[metadata][user_id]", userId);
    const response = await stripeRequest("/checkout/sessions", { method: "POST", body });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const reason = payload?.error?.message || "Unable to start subscription checkout.";
      return sendJson(res, 502, { error: String(reason) });
    }
    return sendJson(res, 200, { checkoutUrl: String(payload?.url || "") });
  } catch (error) {
    return sendJson(res, 500, { error: error?.message || "Unable to start subscription checkout." });
  }
}

async function handleStripeCheckoutCredits(req, res) {
  if (!hasStripeConfig() || !STRIPE_CREDITS_PRICE_ID) {
    return sendJson(res, 500, { error: "Stripe credits checkout is not configured." });
  }
  const authResult = await getAuthenticatedSupabaseUser(req);
  if (!authResult.ok) return sendJson(res, authResult.status || 401, { error: authResult.error || "Unauthorized." });
  const service = getSupabaseServiceHeaders();
  if (!service.ok) return sendJson(res, 500, { error: service.error });
  const userId = String(authResult.user?.id || "").trim();
  const profile = await getProfileByUserId(service, userId);
  const email = normalizeEmail(authResult.user?.email || profile?.email || "");
  if (!email) return sendJson(res, 400, { error: "User email is missing." });
  try {
    const customer = await ensureStripeCustomerForUser({
      email,
      userId,
      name: String(profile?.username || email.split("@")[0]),
    });
    const summary = await fetchStripeSubscriptionSummary(String(customer?.id || ""));
    if (!summary.subscriptionActive) {
      return sendJson(res, 403, { error: "Active subscription required before buying credits." });
    }

    const origin = buildRequestOrigin(req);
    const body = new URLSearchParams();
    body.set("mode", "payment");
    body.set("customer", String(customer?.id || ""));
    body.set("line_items[0][price]", STRIPE_CREDITS_PRICE_ID);
    body.set("line_items[0][quantity]", "1");
    body.set("success_url", `${origin}/pricing?credits=success`);
    body.set("cancel_url", `${origin}/pricing?credits=cancel`);
    body.set("client_reference_id", userId);
    body.set("metadata[user_id]", userId);
    body.set("metadata[purchase_type]", "credits");
    body.set("metadata[credits]", String(STRIPE_TOPUP_CREDITS));
    const response = await stripeRequest("/checkout/sessions", { method: "POST", body });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const reason = payload?.error?.message || "Unable to start credits checkout.";
      return sendJson(res, 502, { error: String(reason) });
    }
    return sendJson(res, 200, { checkoutUrl: String(payload?.url || "") });
  } catch (error) {
    return sendJson(res, 500, { error: error?.message || "Unable to start credits checkout." });
  }
}

async function handleStripeBillingPortal(req, res) {
  if (!hasStripeConfig()) {
    return sendJson(res, 500, { error: "Stripe billing portal is not configured." });
  }
  const authResult = await getAuthenticatedSupabaseUser(req);
  if (!authResult.ok) return sendJson(res, authResult.status || 401, { error: authResult.error || "Unauthorized." });
  const service = getSupabaseServiceHeaders();
  if (!service.ok) return sendJson(res, 500, { error: service.error });
  const userId = String(authResult.user?.id || "").trim();
  const profile = await getProfileByUserId(service, userId);
  const email = normalizeEmail(authResult.user?.email || profile?.email || "");
  if (!email) return sendJson(res, 400, { error: "User email is missing." });
  try {
    const customer = await fetchStripeCustomerByEmail(email);
    if (!customer?.id) return sendJson(res, 404, { error: "No Stripe customer found for this user." });
    const body = new URLSearchParams();
    body.set("customer", String(customer.id));
    body.set("return_url", `${buildRequestOrigin(req)}/pricing`);
    const response = await stripeRequest("/billing_portal/sessions", { method: "POST", body });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const reason = payload?.error?.message || "Unable to open billing portal.";
      return sendJson(res, 502, { error: String(reason) });
    }
    return sendJson(res, 200, { portalUrl: String(payload?.url || "") });
  } catch (error) {
    return sendJson(res, 500, { error: error?.message || "Unable to open billing portal." });
  }
}

async function handleStripeWebhook(req, res) {
  if (!hasStripeConfig() || !STRIPE_WEBHOOK_SECRET) {
    return sendJson(res, 500, { error: "Stripe webhook is not configured." });
  }
  let rawBody;
  try {
    rawBody = await readRawBody(req, { maxBytes: 2 * 1024 * 1024 });
  } catch (error) {
    return sendJson(res, 413, { error: error?.message || "Webhook body too large." });
  }
  const signature = String(req.headers["stripe-signature"] || "");
  const valid = verifyStripeWebhookSignature(rawBody, signature, STRIPE_WEBHOOK_SECRET);
  if (!valid) {
    return sendJson(res, 400, { error: "Invalid Stripe signature." });
  }
  let event;
  try {
    event = JSON.parse(rawBody.toString("utf8") || "{}");
  } catch {
    return sendJson(res, 400, { error: "Invalid webhook payload." });
  }

  try {
    if (event?.type === "checkout.session.completed") {
      const sessionObject = event?.data?.object || {};
      const mode = String(sessionObject?.mode || "").trim();
      const purchaseType = String(sessionObject?.metadata?.purchase_type || "").trim();
      if (mode === "subscription") {
        const rawUserId = String(sessionObject?.metadata?.user_id || sessionObject?.client_reference_id || "").trim();
        const service = getSupabaseServiceHeaders();
        if (service.ok) {
          let targetUserId = rawUserId;
          if (!isLikelyUuid(targetUserId)) {
            const customerEmail = normalizeEmail(
              sessionObject?.customer_details?.email ||
              sessionObject?.customer_email ||
              ""
            );
            const profileByEmail = await getProfileByEmail(service, customerEmail);
            targetUserId = String(profileByEmail?.id || "").trim();
          }
          if (isLikelyUuid(targetUserId)) {
            await applyStripeCreditsTopup(
              service,
              targetUserId,
              STRIPE_SUBSCRIPTION_CREDITS,
              `stripe_subscribe_session_${String(sessionObject?.id || "")}`,
              {
                stripe_session_id: String(sessionObject?.id || ""),
                stripe_subscription: String(sessionObject?.subscription || ""),
                source: "subscription_checkout",
                credits: STRIPE_SUBSCRIPTION_CREDITS,
              }
            );
          }
        }
      }
      if (mode === "payment" && purchaseType === "credits") {
        const rawUserId = String(sessionObject?.metadata?.user_id || sessionObject?.client_reference_id || "").trim();
        const sourceToken = `stripe_checkout_${String(sessionObject?.id || "")}`;
        const meta = {
          stripe_session_id: String(sessionObject?.id || ""),
          stripe_payment_intent: String(sessionObject?.payment_intent || ""),
          credits: Number(sessionObject?.metadata?.credits || STRIPE_TOPUP_CREDITS),
        };
        const service = getSupabaseServiceHeaders();
        if (service.ok) {
          let targetUserId = rawUserId;
          if (!isLikelyUuid(targetUserId)) {
            const customerEmail = normalizeEmail(
              sessionObject?.customer_details?.email ||
              sessionObject?.customer_email ||
              ""
            );
            const profileByEmail = await getProfileByEmail(service, customerEmail);
            targetUserId = String(profileByEmail?.id || "").trim();
          }
          if (isLikelyUuid(targetUserId)) {
            const applyResult = await applyStripeCreditsTopup(
              service,
              targetUserId,
              Number(sessionObject?.metadata?.credits || STRIPE_TOPUP_CREDITS),
              sourceToken,
              meta
            );
            if (applyResult.ok && !applyResult.alreadyApplied) {
              const profile = applyResult.profile || {};
              sendCreditsPurchaseAndNotificationEmail({
                userName: String(profile?.username || profile?.email || "").trim(),
                userEmail: String(profile?.email || "").trim(),
                creditsAdded: Number(sessionObject?.metadata?.credits || STRIPE_TOPUP_CREDITS),
                previousCredits: applyResult.previousCredits,
                nextCredits: applyResult.nextCredits,
              }).catch((error) => {
                console.error("Credits purchase email failed:", error?.message || error);
              });
            }
          }
        }
      }
    }
    if (event?.type === "invoice.payment_succeeded") {
      const invoice = event?.data?.object || {};
      const billingReason = String(invoice?.billing_reason || "");
      const isSubscriptionCycle = [
        "subscription_cycle",
        "subscription_create",
      ].includes(billingReason);
      if (isSubscriptionCycle) {
        const service = getSupabaseServiceHeaders();
        if (service.ok) {
          const customerEmail = normalizeEmail(String(invoice?.customer_email || ""));
          let profile = customerEmail ? await getProfileByEmail(service, customerEmail) : null;
          if (!profile && invoice?.customer) {
            const customerResponse = await stripeRequest(`/customers/${encodeURIComponent(String(invoice.customer))}`, {
              method: "GET",
            });
            if (customerResponse.ok) {
              const customerPayload = await customerResponse.json().catch(() => ({}));
              const email = normalizeEmail(customerPayload?.email || "");
              if (email) profile = await getProfileByEmail(service, email);
            }
          }
          const targetUserId = String(profile?.id || "").trim();
          if (isLikelyUuid(targetUserId)) {
            await applyStripeCreditsTopup(
              service,
              targetUserId,
              STRIPE_SUBSCRIPTION_CREDITS,
              `stripe_subscription_invoice_${String(invoice?.id || "")}`,
              {
                stripe_invoice_id: String(invoice?.id || ""),
                stripe_subscription: String(invoice?.subscription || ""),
                billing_reason: billingReason,
                source: "subscription_invoice",
                credits: STRIPE_SUBSCRIPTION_CREDITS,
              }
            );
          }
        }
      }
    }
  } catch (error) {
    console.error("Stripe webhook handling error:", error?.message || error);
  }

  return sendJson(res, 200, { received: true });
}

function buildProjectSessionObjectPath(userId, projectId) {
  return `${encodeURIComponent(String(userId || "").trim())}/${encodeURIComponent(String(projectId || "").trim())}.json`;
}

function isStorageObjectMissingReason(reason = "") {
  const text = String(reason || "").toLowerCase();
  if (!text) return false;
  return text.includes("object not found") || text.includes('"error":"not_found"') || text.includes('"error":"object_not_found"');
}

async function ensureProjectSessionsBucket(service) {
  const { config, headers } = service;
  const checkResponse = await fetch(`${config.url}/storage/v1/bucket/${PROJECT_SESSIONS_BUCKET}`, {
    method: "GET",
    headers,
  });
  if (checkResponse.ok) return { ok: true };
  const reason = await checkResponse.text().catch(() => "");
  const bucketMissing = checkResponse.status === 404 || String(reason || "").toLowerCase().includes("bucket not found");
  if (!bucketMissing) {
    return { ok: false, status: 502, error: `Unable to check project bucket.${reason ? ` ${reason}` : ""}` };
  }
  const createResponse = await fetch(`${config.url}/storage/v1/bucket`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      id: PROJECT_SESSIONS_BUCKET,
      name: PROJECT_SESSIONS_BUCKET,
      public: false,
      allowed_mime_types: ["application/json"],
    }),
  });
  if (!createResponse.ok && createResponse.status !== 409) {
    const createReason = await createResponse.text().catch(() => "");
    return { ok: false, status: 502, error: `Unable to create project bucket.${createReason ? ` ${createReason}` : ""}` };
  }
  return { ok: true };
}

async function getOwnedProject(req, userId, projectId) {
  if (!isLikelyUuid(projectId)) {
    return { ok: false, status: 400, error: "Invalid project id." };
  }
  const service = getSupabaseServiceHeaders();
  if (!service.ok) return { ok: false, status: 500, error: service.error };
  const { config, headers } = service;
  const response = await fetch(
    `${config.url}/rest/v1/projects?select=id,name,status,cover_image_url,created_at,last_opened_at,updated_at&id=eq.${encodeURIComponent(projectId)}&user_id=eq.${encodeURIComponent(userId)}&limit=1`,
    {
      method: "GET",
      headers,
    }
  );
  if (!response.ok) {
    const reason = await response.text().catch(() => "");
    return { ok: false, status: 502, error: `Unable to read project.${reason ? ` ${reason}` : ""}` };
  }
  const rows = await response.json().catch(() => []);
  const project = Array.isArray(rows) ? rows[0] : null;
  if (!project) return { ok: false, status: 404, error: "Project not found." };
  return { ok: true, service, project };
}

async function handleProjectsList(req, res) {
  const authResult = await getAuthenticatedSupabaseUser(req);
  if (!authResult.ok) {
    return sendJson(res, authResult.status || 401, { error: authResult.error || "Unauthorized." });
  }
  const service = getSupabaseServiceHeaders();
  if (!service.ok) {
    return sendJson(res, 500, { error: service.error });
  }
  const userId = String(authResult.user?.id || "").trim();
  const { config, headers } = service;
  const response = await fetch(
    `${config.url}/rest/v1/projects?select=id,name,status,cover_image_url,created_at,last_opened_at,updated_at&user_id=eq.${encodeURIComponent(userId)}&order=last_opened_at.desc.nullslast&order=created_at.desc&limit=200`,
    {
      method: "GET",
      headers,
    }
  );
  if (!response.ok) {
    const reason = await response.text().catch(() => "");
    return sendJson(res, 502, { error: `Unable to load projects.${reason ? ` ${reason}` : ""}` });
  }
  const rows = await response.json().catch(() => []);
  const projects = Array.isArray(rows)
    ? rows.map((row) => ({
        id: String(row?.id || ""),
        name: String(row?.name || ""),
        status: String(row?.status || "active"),
        coverImageUrl: String(row?.cover_image_url || ""),
        createdAt: row?.created_at || null,
        lastOpenedAt: row?.last_opened_at || null,
        updatedAt: row?.updated_at || null,
      }))
    : [];
  return sendJson(res, 200, { projects });
}

async function handleProjectsCreate(req, res) {
  const authResult = await getAuthenticatedSupabaseUser(req);
  if (!authResult.ok) {
    return sendJson(res, authResult.status || 401, { error: authResult.error || "Unauthorized." });
  }
  const service = getSupabaseServiceHeaders();
  if (!service.ok) {
    return sendJson(res, 500, { error: service.error });
  }
  try {
    const payload = await parseJsonBody(req);
    const fallbackName = `Session ${new Date().toISOString().slice(0, 10)}`;
    const name = String(payload?.name || fallbackName).trim().replace(/\s+/g, " ").slice(0, 120) || fallbackName;
    const userId = String(authResult.user?.id || "").trim();
    const { config, headers } = service;
    const response = await fetch(`${config.url}/rest/v1/projects`, {
      method: "POST",
      headers: {
        ...headers,
        Prefer: "return=representation",
      },
      body: JSON.stringify([
        {
          user_id: userId,
          name,
          status: "active",
          last_opened_at: new Date().toISOString(),
        },
      ]),
    });
    if (!response.ok) {
      const reason = await response.text().catch(() => "");
      return sendJson(res, 502, { error: `Unable to create project.${reason ? ` ${reason}` : ""}` });
    }
    const rows = await response.json().catch(() => []);
    const project = Array.isArray(rows) ? rows[0] : null;
    if (!project) return sendJson(res, 500, { error: "Project create response was empty." });
    return sendJson(res, 200, {
      project: {
        id: String(project.id || ""),
        name: String(project.name || name),
        status: String(project.status || "active"),
        coverImageUrl: String(project.cover_image_url || ""),
        createdAt: project.created_at || null,
        lastOpenedAt: project.last_opened_at || null,
        updatedAt: project.updated_at || null,
      },
    });
  } catch (error) {
    return sendJson(res, 400, { error: error?.message || "Invalid request payload." });
  }
}

async function handleProjectSessionLoad(req, res, projectId) {
  const authResult = await getAuthenticatedSupabaseUser(req);
  if (!authResult.ok) {
    return sendJson(res, authResult.status || 401, { error: authResult.error || "Unauthorized." });
  }
  const userId = String(authResult.user?.id || "").trim();
  const owned = await getOwnedProject(req, userId, projectId);
  if (!owned.ok) {
    return sendJson(res, owned.status || 500, { error: owned.error || "Unable to load project." });
  }
  const { service, project } = owned;
  const bucketReady = await ensureProjectSessionsBucket(service);
  if (!bucketReady.ok) {
    return sendJson(res, bucketReady.status || 500, { error: bucketReady.error || "Unable to prepare project bucket." });
  }
  const { config, headers } = service;
  const objectPath = buildProjectSessionObjectPath(userId, projectId);
  const response = await fetch(`${config.url}/storage/v1/object/${PROJECT_SESSIONS_BUCKET}/${objectPath}`, {
    method: "GET",
    headers,
  });
  if (response.status === 404) {
    return sendJson(res, 200, { project, session: null });
  }
  if (!response.ok) {
    const reason = await response.text().catch(() => "");
    if (String(reason || "").toLowerCase().includes("bucket not found") || isStorageObjectMissingReason(reason)) {
      return sendJson(res, 200, { project, session: null });
    }
    return sendJson(res, 502, { error: `Unable to load project session.${reason ? ` ${reason}` : ""}` });
  }
  const raw = await response.text().catch(() => "");
  if (!raw) return sendJson(res, 200, { project, session: null });
  try {
    const parsed = JSON.parse(raw);
    return sendJson(res, 200, { project, session: parsed });
  } catch {
    return sendJson(res, 200, { project, session: null });
  }
}

async function handleProjectSessionSave(req, res, projectId) {
  const authResult = await getAuthenticatedSupabaseUser(req);
  if (!authResult.ok) {
    return sendJson(res, authResult.status || 401, { error: authResult.error || "Unauthorized." });
  }
  const userId = String(authResult.user?.id || "").trim();
  const owned = await getOwnedProject(req, userId, projectId);
  if (!owned.ok) {
    return sendJson(res, owned.status || 500, { error: owned.error || "Unable to save project." });
  }
  try {
    const payload = await parseJsonBody(req, { maxBytes: 120 * 1024 * 1024 });
    if (!payload || typeof payload?.session !== "object" || payload.session == null) {
      return sendJson(res, 400, { error: "Missing session payload." });
    }
    const nextName = String(payload?.name || "").trim().replace(/\s+/g, " ").slice(0, 120);
    const nextCoverImageUrlRaw = String(payload?.coverImageUrl || "").trim();
    const nextCoverImageUrl = nextCoverImageUrlRaw.startsWith("data:image/") ? nextCoverImageUrlRaw : "";
    const { service } = owned;
    const bucketReady = await ensureProjectSessionsBucket(service);
    if (!bucketReady.ok) {
      return sendJson(res, bucketReady.status || 500, { error: bucketReady.error || "Unable to prepare project bucket." });
    }
    const { config, headers } = service;
    const objectPath = buildProjectSessionObjectPath(userId, projectId);
    const saveResponse = await fetch(`${config.url}/storage/v1/object/${PROJECT_SESSIONS_BUCKET}/${objectPath}`, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
        "x-upsert": "true",
      },
      body: JSON.stringify(payload.session),
    });
    if (!saveResponse.ok) {
      const reason = await saveResponse.text().catch(() => "");
      return sendJson(res, 502, { error: `Unable to save session file.${reason ? ` ${reason}` : ""}` });
    }
    const updates = { last_opened_at: new Date().toISOString() };
    if (nextName) updates.name = nextName;
    if (nextCoverImageUrl) updates.cover_image_url = nextCoverImageUrl;
    const updateResponse = await fetch(
      `${config.url}/rest/v1/projects?id=eq.${encodeURIComponent(projectId)}&user_id=eq.${encodeURIComponent(userId)}`,
      {
        method: "PATCH",
        headers: {
          ...headers,
          Prefer: "return=representation",
        },
        body: JSON.stringify(updates),
      }
    );
    if (!updateResponse.ok) {
      const reason = await updateResponse.text().catch(() => "");
      return sendJson(res, 502, { error: `Unable to update project metadata.${reason ? ` ${reason}` : ""}` });
    }
    const rows = await updateResponse.json().catch(() => []);
    const project = Array.isArray(rows) ? rows[0] : null;
    return sendJson(res, 200, {
      ok: true,
      project: project
        ? {
            id: String(project.id || ""),
            name: String(project.name || ""),
            status: String(project.status || "active"),
            coverImageUrl: String(project.cover_image_url || ""),
            createdAt: project.created_at || null,
            lastOpenedAt: project.last_opened_at || null,
            updatedAt: project.updated_at || null,
          }
        : null,
    });
  } catch (error) {
    const message = String(error?.message || "Invalid request payload.");
    const isTooLarge = message.toLowerCase().includes("payload too large");
    return sendJson(res, isTooLarge ? 413 : 400, { error: message });
  }
}

function normalizeOwnerId(value) {
  const raw = String(value || "").trim();
  const safe = raw.replace(/[^a-zA-Z0-9_-]/g, "");
  if (!safe) return "";
  return safe.slice(0, 128);
}

function hasSupabaseShareBackend() {
  return Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY && SUPABASE_STORAGE_BUCKET);
}

function encodeStoragePath(filePath) {
  return String(filePath || "")
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function buildSupabaseUrl(pathname) {
  return `${SUPABASE_URL.replace(/\/+$/, "")}${pathname.startsWith("/") ? pathname : `/${pathname}`}`;
}

async function supabaseStorageUpload(filePath, body, contentType) {
  const encodedBucket = encodeURIComponent(SUPABASE_STORAGE_BUCKET);
  const encodedPath = encodeStoragePath(filePath);
  const response = await fetch(buildSupabaseUrl(`/storage/v1/object/${encodedBucket}/${encodedPath}`), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      "x-upsert": "true",
      "Content-Type": contentType || "application/octet-stream",
    },
    body,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Supabase upload failed (${response.status}): ${text || "unknown error"}`);
  }
}

async function supabaseStorageDownload(filePath) {
  const encodedBucket = encodeURIComponent(SUPABASE_STORAGE_BUCKET);
  const encodedPath = encodeStoragePath(filePath);
  const response = await fetch(buildSupabaseUrl(`/storage/v1/object/${encodedBucket}/${encodedPath}`), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      apikey: SUPABASE_SERVICE_ROLE_KEY,
    },
  });
  return response;
}

function extensionFromMimeType(mimeType) {
  const normalized = String(mimeType || "").toLowerCase();
  if (normalized.includes("png")) return "png";
  if (normalized.includes("jpeg") || normalized.includes("jpg")) return "jpg";
  if (normalized.includes("webp")) return "webp";
  if (normalized.includes("gif")) return "gif";
  if (normalized.includes("svg")) return "svg";
  return "bin";
}

function parseDataUrl(raw) {
  const value = String(raw || "");
  const match = value.match(/^data:([^;,]+)?(?:;charset=[^;,]+)?(;base64)?,([\s\S]*)$/i);
  if (!match) return null;
  const mimeType = String(match[1] || "application/octet-stream").trim().toLowerCase();
  const isBase64 = Boolean(match[2]);
  const payload = match[3] || "";
  try {
    const buffer = isBase64
      ? Buffer.from(payload.replace(/\s+/g, ""), "base64")
      : Buffer.from(decodeURIComponent(payload), "utf8");
    return { mimeType, buffer };
  } catch {
    return null;
  }
}

async function externalizeProjectImages(project, shareId) {
  const safeProject = JSON.parse(JSON.stringify(project || {}));
  const pages = Array.isArray(safeProject.pages) ? safeProject.pages : [];
  for (const page of pages) {
    const viewStates = page?.viewStates && typeof page.viewStates === "object" ? page.viewStates : {};
    for (const viewKey of ["desktop", "tablet", "mobile"]) {
      const viewState = viewStates[viewKey];
      const elements = Array.isArray(viewState?.elements) ? viewState.elements : [];
      for (const element of elements) {
        if (!element || element.type !== "image" || typeof element.src !== "string") continue;
        if (!element.src.startsWith("data:image/")) continue;
        const parsed = parseDataUrl(element.src);
        if (!parsed || !parsed.buffer || !parsed.buffer.length) continue;
        const ext = extensionFromMimeType(parsed.mimeType);
        const filename = `${crypto.randomUUID()}.${ext}`;
        const relativePath = `assets/${filename}`;
        const storagePath = `shares/${shareId}/${relativePath}`;
        await supabaseStorageUpload(storagePath, parsed.buffer, parsed.mimeType);
        element.src = `/api/share/${encodeURIComponent(shareId)}/asset/${encodeURIComponent(relativePath)}`;
      }
    }
  }
  return safeProject;
}

function validateSharedProjectPayload(project, options = {}) {
  const skipSizeLimit = Boolean(options.skipSizeLimit);
  if (!project || typeof project !== "object" || Array.isArray(project)) {
    return { ok: false, error: "Invalid project payload." };
  }
  if (!Array.isArray(project.pages) || project.pages.length === 0) {
    return { ok: false, error: "Project must include at least one page." };
  }
  let json = "";
  try {
    json = JSON.stringify(project);
  } catch {
    return { ok: false, error: "Project payload is not serializable." };
  }
  if (!skipSizeLimit && Buffer.byteLength(json, "utf8") > SHARE_PAYLOAD_MAX_BYTES) {
    return { ok: false, error: "Project payload is too large to share." };
  }
  return { ok: true };
}

function pruneShareStore() {
  const entries = Object.entries(shareStore);
  if (entries.length <= SHARE_MAX_ITEMS) return;
  entries.sort((a, b) => Number(a[1]?.createdAt || 0) - Number(b[1]?.createdAt || 0));
  const removeCount = entries.length - SHARE_MAX_ITEMS;
  for (let i = 0; i < removeCount; i += 1) {
    const [id] = entries[i];
    delete shareStore[id];
  }
}

function handleShareCreate(req, res) {
  const chunks = [];
  let rawBytes = 0;
  let exceedsHardLimit = false;
  const hardLimitBytes = hasSupabaseShareBackend()
    ? 120 * 1024 * 1024
    : SHARE_PAYLOAD_MAX_BYTES + 2 * 1024 * 1024;
  req.on("data", (chunk) => {
    if (exceedsHardLimit) return;
    chunks.push(chunk);
    rawBytes += chunk.length;
    if (rawBytes > hardLimitBytes) {
      exceedsHardLimit = true;
    }
  });

  req.on("end", async () => {
    if (exceedsHardLimit) {
      return sendJson(res, 413, { error: "Project payload is too large to share." });
    }
    try {
      const compressedBody = Buffer.concat(chunks);
      let bodyBuffer = compressedBody;
      const contentEncoding = String(req.headers["content-encoding"] || "").toLowerCase();
      if (contentEncoding.includes("gzip")) {
        bodyBuffer = zlib.gunzipSync(compressedBody);
      }
      const parsed = JSON.parse(bodyBuffer.toString("utf8") || "{}");
      const project = parsed?.project || parsed;
      const ownerId =
        normalizeOwnerId(parsed?.ownerId) ||
        normalizeOwnerId(req.headers["x-freehandnx-owner-id"]) ||
        `usr_${createShareId()}`;
      const validation = validateSharedProjectPayload(project, {
        skipSizeLimit: hasSupabaseShareBackend(),
      });
      if (!validation.ok) {
        return sendJson(res, 400, { error: validation.error || "Invalid shared payload." });
      }

      const requestedShareId = normalizeShareIdCandidate(parsed?.requestedShareId);
      const id = requestedShareId || createShareId();
      const createdAt = Date.now();
      if (hasSupabaseShareBackend()) {
        const projectForStorage = await externalizeProjectImages(project, id);
        const storagePath = `shares/${id}/project.json`;
        const body = Buffer.from(JSON.stringify(projectForStorage), "utf8");
        await supabaseStorageUpload(storagePath, body, "application/json; charset=utf-8");
        const metaBody = Buffer.from(
          JSON.stringify({
            shareId: id,
            ownerId,
            createdAt: new Date(createdAt).toISOString(),
          }),
          "utf8"
        );
        await supabaseStorageUpload(`shares/${id}/meta.json`, metaBody, "application/json; charset=utf-8");
      } else {
        shareStore[id] = {
          createdAt,
          ownerId,
          project,
        };
        pruneShareStore();
        persistShareStore();
      }

      const origin = buildRequestOrigin(req);
      const shareUrl = buildPersistentPreviewUrl(origin, id) || `${origin}/editor?share=${encodeURIComponent(id)}&preview=1`;
      return sendJson(res, 200, {
        id,
        ownerId,
        url: shareUrl,
        createdAt: new Date(createdAt).toISOString(),
      });
    } catch (error) {
      return sendJson(res, 400, { error: error?.message || "Invalid request payload." });
    }
  });
}

async function handleShareInit(req, res) {
  try {
    const parsed = await parseJsonBody(req, { maxBytes: 512 * 1024 });
    const ownerId =
      normalizeOwnerId(parsed?.ownerId) ||
      normalizeOwnerId(req.headers["x-freehandnx-owner-id"]) ||
      `usr_${createShareId()}`;
    const requestedShareId = normalizeShareIdCandidate(parsed?.requestedShareId);
    const id = requestedShareId || createShareId();
    const createdAt = Date.now();

    if (hasSupabaseShareBackend()) {
      const metaBody = Buffer.from(
        JSON.stringify({
          shareId: id,
          ownerId,
          createdAt: new Date(createdAt).toISOString(),
        }),
        "utf8"
      );
      await supabaseStorageUpload(`shares/${id}/meta.json`, metaBody, "application/json; charset=utf-8");
    } else {
      shareStore[id] = shareStore[id] || { createdAt, ownerId, project: null };
      shareStore[id].createdAt = createdAt;
      shareStore[id].ownerId = ownerId;
      pruneShareStore();
      persistShareStore();
    }

    const origin = buildRequestOrigin(req);
    const shareUrl = buildPersistentPreviewUrl(origin, id) || `${origin}/editor?share=${encodeURIComponent(id)}&preview=1`;
    return sendJson(res, 200, {
      id,
      ownerId,
      url: shareUrl,
      createdAt: new Date(createdAt).toISOString(),
    });
  } catch (error) {
    return sendJson(res, 400, { error: error?.message || "Could not initialize share." });
  }
}

async function handleShareProjectUpload(req, res, shareId) {
  const id = String(shareId || "").trim();
  if (!id) {
    return sendJson(res, 400, { error: "Missing share id." });
  }
  try {
    const parsed = await parseJsonBody(req, { maxBytes: 32 * 1024 * 1024 });
    const project = parsed?.project || parsed;
    const ownerId =
      normalizeOwnerId(parsed?.ownerId) ||
      normalizeOwnerId(req.headers["x-freehandnx-owner-id"]) ||
      `usr_${createShareId()}`;
    const validation = validateSharedProjectPayload(project, {
      skipSizeLimit: hasSupabaseShareBackend(),
    });
    if (!validation.ok) {
      return sendJson(res, 400, { error: validation.error || "Invalid shared payload." });
    }
    const createdAt = Date.now();
    if (hasSupabaseShareBackend()) {
      const projectForStorage = await externalizeProjectImages(project, id);
      const body = Buffer.from(JSON.stringify(projectForStorage), "utf8");
      await supabaseStorageUpload(`shares/${id}/project.json`, body, "application/json; charset=utf-8");
      const metaBody = Buffer.from(
        JSON.stringify({
          shareId: id,
          ownerId,
          createdAt: new Date(createdAt).toISOString(),
        }),
        "utf8"
      );
      await supabaseStorageUpload(`shares/${id}/meta.json`, metaBody, "application/json; charset=utf-8");
    } else {
      shareStore[id] = {
        createdAt,
        ownerId,
        project,
      };
      pruneShareStore();
      persistShareStore();
    }
    return sendJson(res, 200, { ok: true, id });
  } catch (error) {
    return sendJson(res, 400, { error: error?.message || "Could not upload share project." });
  }
}

function handleShareGet(req, res, shareId) {
  const id = String(shareId || "").trim();
  if (!id) {
    return sendJson(res, 400, { error: "Missing share id." });
  }
  if (hasSupabaseShareBackend()) {
    (async () => {
      try {
        const response = await supabaseStorageDownload(`shares/${id}/project.json`);
        if (response.status === 404) {
          return sendJson(res, 404, { error: "Share not found." });
        }
        if (!response.ok) {
          const text = await response.text().catch(() => "");
          return sendJson(res, 502, { error: text || "Could not load shared project." });
        }
        const raw = await response.text();
        const project = JSON.parse(raw || "{}");
        let ownerId = "";
        let createdAt = new Date().toISOString();
        try {
          const metaResponse = await supabaseStorageDownload(`shares/${id}/meta.json`);
          if (metaResponse.ok) {
            const metaRaw = await metaResponse.text();
            const meta = JSON.parse(metaRaw || "{}");
            ownerId = normalizeOwnerId(meta?.ownerId);
            if (meta?.createdAt) createdAt = new Date(meta.createdAt).toISOString();
          }
        } catch {
          // Meta is optional; continue.
        }
        return sendJson(res, 200, {
          id,
          ownerId,
          createdAt,
          project,
        });
      } catch (error) {
        return sendJson(res, 500, { error: error?.message || "Could not load shared project." });
      }
    })();
    return;
  }
  const record = shareStore[id];
  if (!record) {
    return sendJson(res, 404, { error: "Share not found." });
  }
  return sendJson(res, 200, {
    id,
    ownerId: normalizeOwnerId(record.ownerId),
    createdAt: new Date(Number(record.createdAt || Date.now())).toISOString(),
    project: record.project,
  });
}

function handleShareAssetGet(req, res, shareId, relativeAssetPath) {
  const id = String(shareId || "").trim();
  const relativePath = String(relativeAssetPath || "").trim();
  if (!hasSupabaseShareBackend()) {
    return sendJson(res, 404, { error: "Asset backend unavailable." });
  }
  if (!id || !relativePath) {
    return sendJson(res, 400, { error: "Missing share asset path." });
  }
  if (relativePath.includes("..") || relativePath.startsWith("/")) {
    return sendJson(res, 400, { error: "Invalid asset path." });
  }
  const storagePath = `shares/${id}/${relativePath}`;
  if (!storagePath.startsWith(`shares/${id}/assets/`)) {
    return sendJson(res, 400, { error: "Invalid asset path." });
  }
  (async () => {
    try {
      const response = await supabaseStorageDownload(storagePath);
      if (response.status === 404) {
        res.writeHead(404);
        res.end("Not Found");
        return;
      }
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        res.writeHead(502);
        res.end(text || "Asset fetch failed");
        return;
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      const contentType = response.headers.get("content-type") || "application/octet-stream";
      res.writeHead(200, {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=31536000, immutable",
        "Content-Length": bytes.length,
      });
      res.end(bytes);
    } catch (error) {
      res.writeHead(500);
      res.end(error?.message || "Asset fetch failed");
    }
  })();
}

async function handleShareAssetUpload(req, res, shareId, relativeAssetPath) {
  const id = String(shareId || "").trim();
  const relativePath = String(relativeAssetPath || "").trim();
  if (!hasSupabaseShareBackend()) {
    return sendJson(res, 400, { error: "Supabase asset backend is not configured." });
  }
  if (!id || !relativePath) {
    return sendJson(res, 400, { error: "Missing share asset path." });
  }
  if (relativePath.includes("..") || relativePath.startsWith("/")) {
    return sendJson(res, 400, { error: "Invalid asset path." });
  }
  if (!relativePath.startsWith("assets/")) {
    return sendJson(res, 400, { error: "Invalid asset path." });
  }
  try {
    const body = await parseJsonBody(req, { maxBytes: 20 * 1024 * 1024 });
    const dataUrl = String(body?.dataUrl || "").trim();
    const parsed = parseDataUrl(dataUrl);
    if (!parsed || !parsed.buffer || !parsed.buffer.length) {
      return sendJson(res, 400, { error: "Invalid image payload." });
    }
    const storagePath = `shares/${id}/${relativePath}`;
    await supabaseStorageUpload(storagePath, parsed.buffer, parsed.mimeType || "application/octet-stream");
    return sendJson(res, 200, {
      ok: true,
      path: relativePath,
      url: `/api/share/${encodeURIComponent(id)}/asset/${encodeURIComponent(relativePath)}`,
    });
  } catch (error) {
    return sendJson(res, 400, { error: error?.message || "Could not upload share asset." });
  }
}

function normalizeEnvValue(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function buildGoogleGenerateEndpoint(model) {
  return `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
}

function normalizeGoogleApiKey(value) {
  const normalized = normalizeEnvValue(value);
  const noWhitespace = normalized.replace(/\s+/g, "");
  return noWhitespace.replace(/[^A-Za-z0-9_-]/g, "");
}

function isLikelyGoogleApiKey(value) {
  return /^AIza[0-9A-Za-z_-]{20,}$/.test(value || "");
}

function normalizeLayoutModelName(value) {
  const normalized = normalizeEnvValue(value);
  if (!normalized) return "gemini-2.5-flash";
  if (!/^[a-zA-Z0-9._-]+$/.test(normalized)) return "gemini-2.5-flash";
  return normalized;
}

function normalizeImageModelName(value) {
  const normalized = normalizeEnvValue(value);
  if (!normalized) return "recraftv4_pro";
  if (!/^[a-zA-Z0-9._-]+$/.test(normalized)) return "recraftv4_pro";
  return normalized.toLowerCase();
}

function normalizeImageAspectRatio(value) {
  const normalized = String(value || "").trim();
  if (normalized === "21:9") return "16:9";
  const allowed = new Set([
    "1:1", "2:1", "1:2",
    "3:2", "2:3",
    "4:3", "3:4",
    "5:4", "4:5",
    "6:10", "14:10", "10:14",
    "16:9", "9:16",
  ]);
  return allowed.has(normalized) ? normalized : "1:1";
}

function normalizeImageResolution(value) {
  const normalized = String(value || "").trim().toUpperCase();
  if (normalized === "2K" || normalized === "4K") return normalized;
  return "1K";
}

function normalizeRecraftToken(value) {
  return normalizeEnvValue(value);
}

function selectRecraftGenerationModel(model, resolution) {
  const requestedRaw = normalizeEnvValue(model);
  const explicitRaw = normalizeEnvValue(process.env.RECRAFT_IMAGE_MODEL || "");
  const requested = requestedRaw ? normalizeImageModelName(requestedRaw) : "";
  const explicit = explicitRaw ? normalizeImageModelName(explicitRaw) : "";
  const defaultForResolution = resolution === "1K" ? "recraftv4" : "recraftv4_pro";
  const allowed = new Set(["recraftv3", "recraftv4", "recraftv4_pro"]);
  let candidate = defaultForResolution;
  if (allowed.has(requested)) candidate = requested;
  else if (allowed.has(explicit)) candidate = explicit;

  // Keep model/resolution combinations compatible with Recraft API constraints.
  if (resolution === "1K" && candidate === "recraftv4_pro") return "recraftv4";
  if ((resolution === "2K" || resolution === "4K") && candidate === "recraftv4") return "recraftv4_pro";
  return candidate;
}

function selectRecraftEditModel() {
  const explicit = normalizeImageModelName(process.env.RECRAFT_IMAGE_EDIT_MODEL || "");
  return explicit === "recraftv3" ? explicit : "recraftv3";
}

function buildRecraftSize(aspectRatio, resolution) {
  const base = {
    "1:1": "1024x1024",
    "2:1": "1536x768",
    "1:2": "768x1536",
    "2:3": "832x1216",
    "3:2": "1216x832",
    "3:4": "896x1152",
    "4:3": "1152x896",
    "5:4": "1280x1024",
    "4:5": "1024x1280",
    "6:10": "832x1344",
    "14:10": "1344x960",
    "10:14": "960x1344",
    "9:16": "768x1360",
    "16:9": "1360x768",
  };
  const pro = {
    "1:1": "2048x2048",
    "2:1": "3072x1536",
    "1:2": "1536x3072",
    "2:3": "1664x2560",
    "3:2": "2560x1664",
    "3:4": "1792x2432",
    "4:3": "2432x1792",
    "5:4": "2304x1792",
    "4:5": "1792x2304",
    "6:10": "1664x2688",
    "14:10": "2560x1792",
    "10:14": "1792x2560",
    "9:16": "1536x2688",
    "16:9": "2688x1536",
  };
  const table = resolution === "1K" ? base : pro;
  return table[aspectRatio] || table["1:1"];
}

const RECRAFT_V4_SIZES = new Set([
  "1024x1024",
  "1536x768",
  "768x1536",
  "832x1216",
  "1216x832",
  "896x1152",
  "1152x896",
  "1280x1024",
  "1024x1280",
  "832x1344",
  "1344x960",
  "960x1344",
  "768x1360",
  "1360x768",
]);

const RECRAFT_V4_PRO_SIZES = new Set([
  "2048x2048",
  "3072x1536",
  "1536x3072",
  "1664x2560",
  "2560x1664",
  "1792x2432",
  "2432x1792",
  "2304x1792",
  "1792x2304",
  "1664x2688",
  "2560x1792",
  "1792x2560",
  "1536x2688",
  "2688x1536",
]);

const RECRAFT_SIZE_TO_ASPECT = {
  "1024x1024": "1:1",
  "1536x768": "2:1",
  "768x1536": "1:2",
  "832x1216": "2:3",
  "1216x832": "3:2",
  "896x1152": "3:4",
  "1152x896": "4:3",
  "1280x1024": "5:4",
  "1024x1280": "4:5",
  "832x1344": "6:10",
  "1344x960": "14:10",
  "960x1344": "10:14",
  "768x1360": "9:16",
  "1360x768": "16:9",
  "2048x2048": "1:1",
  "3072x1536": "2:1",
  "1536x3072": "1:2",
  "1664x2560": "2:3",
  "2560x1664": "3:2",
  "1792x2432": "3:4",
  "2432x1792": "4:3",
  "2304x1792": "5:4",
  "1792x2304": "4:5",
  "1664x2688": "6:10",
  "2560x1792": "14:10",
  "1792x2560": "10:14",
  "1536x2688": "9:16",
  "2688x1536": "16:9",
};

function normalizeRecraftSize(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!/^\d+x\d+$/.test(normalized)) return "";
  if (RECRAFT_V4_SIZES.has(normalized) || RECRAFT_V4_PRO_SIZES.has(normalized)) {
    return normalized;
  }
  return "";
}

function resolutionFromRecraftSize(size) {
  if (RECRAFT_V4_PRO_SIZES.has(size)) return "2K";
  return "1K";
}

function normalizeAnthropicModelName(value) {
  const normalized = normalizeEnvValue(value);
  if (!normalized) return "claude-opus-4-6";
  if (!/^[a-zA-Z0-9._-]+$/.test(normalized)) return "claude-opus-4-6";
  return normalized;
}

function extractTextFromGenerateResponse(payload) {
  const candidates = Array.isArray(payload?.candidates) ? payload.candidates : [];
  const chunks = [];
  for (const candidate of candidates) {
    const parts = candidate?.content?.parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      if (typeof part?.text === "string" && part.text.trim()) {
        chunks.push(part.text);
      }
    }
  }
  return chunks.join("\n").trim();
}

function extractTextFromAnthropicResponse(payload) {
  const parts = Array.isArray(payload?.content) ? payload.content : [];
  const chunks = [];
  for (const part of parts) {
    if (part?.type === "text" && typeof part?.text === "string" && part.text.trim()) {
      chunks.push(part.text);
    }
  }
  return chunks.join("\n").trim();
}

function parseModelJson(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return null;

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;

  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function parseImageDataUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const match = raw.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/);
  if (!match) return null;
  const mimeType = String(match[1] || "image/png").toLowerCase();
  const data = String(match[2] || "").replace(/\s+/g, "");
  if (!data) return null;
  const byteLength = Buffer.byteLength(data, "base64");
  if (!Number.isFinite(byteLength) || byteLength <= 0 || byteLength > 12 * 1024 * 1024) {
    return null;
  }
  return { mimeType, data };
}

function extractImageFromGenerateResponse(payload) {
  const candidates = Array.isArray(payload?.candidates) ? payload.candidates : [];
  for (const candidate of candidates) {
    const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
    for (const part of parts) {
      const inline = part?.inlineData || part?.inline_data || null;
      if (!inline) continue;
      const data = String(inline?.data || "").replace(/\s+/g, "");
      if (!data) continue;
      const mimeType = String(inline?.mimeType || inline?.mime_type || "image/png");
      if (!mimeType.startsWith("image/")) continue;
      return { mimeType, data };
    }
  }
  return null;
}

async function handleImageGenerate(req, res) {
  try {
    const authResult = await getAuthenticatedSupabaseUser(req);
    if (!authResult.ok) return sendJson(res, authResult.status || 401, { error: authResult.error || "Sign in required." });
    const service = getSupabaseServiceHeaders();
    if (!service.ok) return sendJson(res, 500, { error: service.error });
    const userId = String(authResult.user?.id || "").trim();
    const profile = await getProfileByUserId(service, userId);
    const email = normalizeEmail(authResult.user?.email || profile?.email || "");
    const customer = email ? await fetchStripeCustomerByEmail(email) : null;
    const subscriptionSummary = customer?.id
      ? { ...(await fetchStripeSubscriptionSummary(customer.id)), customerId: String(customer.id || "") }
      : { subscriptionActive: false, subscriptionStatus: "inactive", subscriptionId: "", customerId: "" };
    const accessSummary = buildAccessSummary({
      subscriptionSummary,
      profile,
      createdAtFallback: authResult.user?.created_at || "",
    });
    if (!accessSummary.subscriptionActive) {
      return sendJson(res, 403, { error: "Active subscription required for AI generation.", access: accessSummary });
    }
    if (accessSummary.creditsBalance < AI_ACTION_CREDITS_COST) {
      return sendJson(res, 402, { error: `Need ${AI_ACTION_CREDITS_COST} credits to continue.`, access: accessSummary });
    }

    const body = await parseJsonBody(req, { maxBytes: 16 * 1024 * 1024 });
    const { prompt, model, size, aspectRatio, resolution, sourceImageDataUrl } = body || {};
    const promptText = String(prompt || "").trim();
    if (!promptText) {
      return sendJson(res, 400, { error: "Missing prompt." });
    }

    const recraftToken = normalizeRecraftToken(process.env.RECRAFT_API_TOKEN || process.env.RECRAFT_API_KEY || "");
    if (!recraftToken) {
      return sendJson(res, 500, { error: "Server missing RECRAFT_API_TOKEN in environment." });
    }

    const sourceImage = parseImageDataUrl(sourceImageDataUrl);
    const selectedAspectRatio = normalizeImageAspectRatio(aspectRatio);
    const selectedResolution = normalizeImageResolution(resolution);
    const selectedSize = normalizeRecraftSize(size);
    const effectiveSize = selectedSize || buildRecraftSize(selectedAspectRatio, selectedResolution);
    const effectiveResolution = selectedSize ? resolutionFromRecraftSize(selectedSize) : selectedResolution;
    const effectiveAspectRatio = RECRAFT_SIZE_TO_ASPECT[effectiveSize] || selectedAspectRatio;
    const targetModel = sourceImage
      ? selectRecraftEditModel()
      : selectRecraftGenerationModel(model, effectiveResolution);

    let response;
    if (sourceImage) {
      const imageBuffer = Buffer.from(sourceImage.data, "base64");
      const imageBlob = new Blob([imageBuffer], { type: sourceImage.mimeType });
      const form = new FormData();
      form.set("model", targetModel);
      form.set("prompt", promptText);
      form.set("image", imageBlob, "source-image.png");
      response = await fetch("https://external.api.recraft.ai/v1/images/imageToImage", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${recraftToken}`,
        },
        body: form,
      });
    } else {
      const payload = {
        model: targetModel,
        prompt: promptText,
        size: effectiveSize,
      };
      response = await fetch("https://external.api.recraft.ai/v1/images/generations", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${recraftToken}`,
        },
        body: JSON.stringify(payload),
      });
    }

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!response.ok) {
      const reason =
        payload?.message ||
        payload?.error?.message ||
        payload?.error ||
        "Recraft image generation failed.";
      return sendJson(res, 502, { error: String(reason) });
    }
    const first = Array.isArray(payload?.data) ? payload.data[0] : null;
    const b64 = String(first?.b64_json || "").replace(/\s+/g, "");
    const url = String(first?.url || "").trim();
    let imageDataUrl = "";
    if (b64) {
      imageDataUrl = `data:image/png;base64,${b64}`;
    } else if (url) {
      const imageResponse = await fetch(url);
      if (!imageResponse.ok) {
        return sendJson(res, 502, { error: `Could not fetch generated image (${imageResponse.status}).` });
      }
      const mimeType = String(imageResponse.headers.get("content-type") || "image/png").split(";")[0].trim() || "image/png";
      const buffer = Buffer.from(await imageResponse.arrayBuffer());
      imageDataUrl = `data:${mimeType};base64,${buffer.toString("base64")}`;
    }
    if (!imageDataUrl) {
      return sendJson(res, 502, { error: "Recraft response did not include an image." });
    }

    const sourceType = sourceImage ? "edit" : String(targetModel || "generation");
    const sourceToken = `ai_${sourceType}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const deductionResult = await applyAiCreditDeduction(service, userId, sourceToken, {
      model: targetModel,
      edited: Boolean(sourceImage),
      size: effectiveSize,
    });
    if (!deductionResult.ok) {
      const status = Number(deductionResult.status) || 402;
      return sendJson(res, status, {
        error: deductionResult.error || `Need ${AI_ACTION_CREDITS_COST} credits to continue.`,
        access: {
          ...accessSummary,
          creditsBalance: Math.max(0, Number(deductionResult.remainingCredits || 0)),
        },
      });
    }

    return sendJson(res, 200, {
      provider: "recraft",
      model: targetModel,
      size: effectiveSize,
      aspectRatio: effectiveAspectRatio,
      resolution: effectiveResolution,
      edited: Boolean(sourceImage),
      imageDataUrl,
      creditsUsed: AI_ACTION_CREDITS_COST,
      remainingCredits: Math.max(0, Number(deductionResult.remainingCredits || 0)),
    });
  } catch (error) {
    return sendJson(res, 500, { error: error?.message || "Unexpected image server error." });
  }
}

async function handleLayoutGenerate(req, res) {
  let raw = "";
  req.on("data", (chunk) => {
    raw += chunk;
    if (raw.length > 2 * 1024 * 1024) req.destroy();
  });

  req.on("end", async () => {
    try {
      const { prompt, style, pageCount } = JSON.parse(raw || "{}");
      const promptText = String(prompt || "").trim();
      if (!promptText) {
        return sendJson(res, 400, { error: "Missing prompt." });
      }

      const count = Math.max(1, Math.min(5, Number(pageCount) || 1));
      const styleText = String(style || "freehandnx-inspired").trim();
      const anthropicApiKey = normalizeEnvValue(process.env.ANTHROPIC_API_KEY || "");
      const googleApiKey = normalizeGoogleApiKey(process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || "");

      if (!anthropicApiKey && !googleApiKey) {
        return sendJson(res, 500, { error: "Server missing ANTHROPIC_API_KEY or GOOGLE_API_KEY/GEMINI_API_KEY in environment." });
      }
      if (googleApiKey && !isLikelyGoogleApiKey(googleApiKey)) {
        return sendJson(res, 500, { error: "Invalid Google API key format in environment." });
      }

      const instruction = [
        "You are a senior web/UX designer generating wireframe-ready page layouts.",
        "Return JSON only. No markdown. No code fences.",
        `Generate exactly ${count} pages.`,
        `Visual style: ${styleText}.`,
        "Every page should feel premium, modern, and conversion-focused.",
        "Schema:",
        "{",
        '  "pages":[',
        "    {",
        '      "name":"string",',
        '      "canvasBackground":"#RRGGBB",',
        '      "elements":[',
        "        {",
        '          "type":"text|shape|image|icon",',
        '          "x":number, "y":number, "width":number, "height":number,',
        '          "text":"optional string",',
        '          "fontSize":optional number,',
        '          "textColor":"optional #RRGGBB",',
        '          "fontFamily":"optional CSS font family string",',
        '          "shapeKind":"optional rectangle|circle|triangle|line|star|polygon",',
        '          "fill":"optional #RRGGBB",',
        '          "stroke":"optional #RRGGBB",',
        '          "strokeWidth":"optional number",',
        '          "iconName":"optional ionicon name"',
        "        }",
        "      ]",
        "    }",
        "  ]",
        "}",
        "Rules:",
        "- Coordinates are for a 1280x720 desktop canvas.",
        "- Keep 12-40 elements per page.",
        "- Include a hero section, at least one content section, and one CTA section.",
        "- For image elements, include type=image with no src.",
      ].join("\n");

      const layoutPrompt = `${instruction}\n\nDesign brief:\n${promptText}`;

      let parsed = null;
      let providerUsed = "";
      const errors = [];

      if (anthropicApiKey) {
        try {
          const anthropicModel = normalizeAnthropicModelName(process.env.ANTHROPIC_LAYOUT_MODEL || process.env.ANTHROPIC_MODEL);
          const anthropicResponse = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "anthropic-version": "2023-06-01",
              "x-api-key": anthropicApiKey,
            },
            body: JSON.stringify({
              model: anthropicModel,
              max_tokens: 4000,
              temperature: 0.7,
              messages: [{ role: "user", content: layoutPrompt }],
            }),
          });

          let anthropicPayload = null;
          try {
            anthropicPayload = await anthropicResponse.json();
          } catch {
            anthropicPayload = null;
          }

          if (!anthropicResponse.ok) {
            const reason = anthropicPayload?.error?.message || anthropicPayload?.error?.type || anthropicPayload?.error || "Claude layout generation failed.";
            errors.push(`claude:${String(reason)}`);
          } else {
            const rawText = extractTextFromAnthropicResponse(anthropicPayload);
            const maybeParsed = parseModelJson(rawText);
            if (maybeParsed && Array.isArray(maybeParsed.pages)) {
              parsed = maybeParsed;
              providerUsed = "claude";
            } else {
              errors.push("claude:invalid json layout");
            }
          }
        } catch (error) {
          errors.push(`claude:${error?.message || "request failed"}`);
        }
      }

      if (!parsed && googleApiKey) {
        try {
          const model = normalizeLayoutModelName(process.env.GOOGLE_LAYOUT_MODEL || process.env.GEMINI_LAYOUT_MODEL);
          const endpoint = buildGoogleGenerateEndpoint(model);
          const body = {
            contents: [{ role: "user", parts: [{ text: layoutPrompt }] }],
            generationConfig: {
              temperature: 0.85,
              responseMimeType: "application/json",
            },
          };

          const callGenerate = async (requestBody) =>
            fetch(endpoint, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-goog-api-key": googleApiKey,
              },
              body: JSON.stringify(requestBody),
            });

          let response = await callGenerate(body);
          let payload = null;
          try {
            payload = await response.json();
          } catch {
            payload = null;
          }

          if (!response.ok) {
            const reason = String(payload?.error?.message || payload?.error || "");
            const unsupportedMime = /responsemime|unknown name .*responseMimeType|invalid json payload/i.test(reason);
            if (unsupportedMime) {
              const fallbackBody = { ...body, generationConfig: { temperature: 0.85 } };
              response = await callGenerate(fallbackBody);
              try {
                payload = await response.json();
              } catch {
                payload = null;
              }
            }
          }

          if (!response.ok) {
            const reason = payload?.error?.message || payload?.error || "Gemini layout generation failed.";
            errors.push(`gemini:${String(reason)}`);
          } else {
            const rawText = extractTextFromGenerateResponse(payload);
            const maybeParsed = parseModelJson(rawText);
            if (maybeParsed && Array.isArray(maybeParsed.pages)) {
              parsed = maybeParsed;
              providerUsed = "gemini";
            } else {
              errors.push("gemini:invalid json layout");
            }
          }
        } catch (error) {
          errors.push(`gemini:${error?.message || "request failed"}`);
        }
      }

      if (!parsed || !Array.isArray(parsed.pages)) {
        const reason = errors.length > 0 ? errors.join(" | ") : "Layout generation failed.";
        return sendJson(res, 502, { error: reason });
      }

      const pages = parsed.pages.slice(0, count).map((page, index) => ({
        name: String(page?.name || `Page ${index + 1}`),
        canvasBackground: String(page?.canvasBackground || "#f6f7fb"),
        elements: Array.isArray(page?.elements) ? page.elements : [],
      }));

      return sendJson(res, 200, { pages, provider: providerUsed || (anthropicApiKey ? "claude" : "gemini") });
    } catch (error) {
      return sendJson(res, 500, { error: error?.message || "Unexpected layout server error." });
    }
  });
}

function serveStatic(req, res) {
  const rawPath = decodeURIComponent(req.url.split("?")[0] || "/");
  const isUuidSharePath = /^\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(rawPath);
  const isPreviewSharePath = /^\/preview\/([A-Za-z0-9_-]{6,64})$/.test(rawPath);
  let reqPath =
    rawPath === "/"
      ? "/index.html"
      : rawPath === "/freehandnx" || rawPath === "/editor" || isUuidSharePath || isPreviewSharePath
        ? "/editor.html"
        : rawPath === "/preview"
          ? "/preview.html"
        : rawPath;
  if (reqPath !== "/editor.html" && reqPath !== "/index.html" && !path.extname(reqPath)) {
    const htmlCandidate = path.join(ROOT, `${reqPath}.html`);
    if (fs.existsSync(htmlCandidate)) {
      reqPath = `${reqPath}.html`;
    }
  }

  const safePath = path.normalize(path.join(ROOT, reqPath));
  if (!safePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(safePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not Found");
      return;
    }

    const ext = path.extname(safePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME_BY_EXT[ext] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(data);
  });
}

function requestHandler(req, res) {
  const reqUrl = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
  const pathname = reqUrl.pathname;
  const projectSessionPathMatch = pathname.match(/^\/api\/projects\/([^/]+)\/session$/);
  const adminUserPathMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
  const legacyUuidPathMatch = String(pathname || "").match(
    /^\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/
  );
  const previewSharePathMatch = String(pathname || "").match(/^\/preview\/([A-Za-z0-9_-]{6,64})$/);

  if (req.method === "GET" && legacyUuidPathMatch?.[1]) {
    const shareId = legacyUuidPathMatch[1];
    const location = `/editor?share=${encodeURIComponent(shareId)}&preview=1`;
    res.writeHead(302, {
      Location: location,
      "Cache-Control": "no-store",
    });
    res.end();
    return;
  }

  if (req.method === "GET" && previewSharePathMatch?.[1]) {
    const shareId = normalizeShareIdCandidate(previewSharePathMatch[1]);
    if (!shareId) {
      res.writeHead(302, {
        Location: "/",
        "Cache-Control": "no-store",
      });
      res.end();
      return;
    }
    const location = `/editor?share=${encodeURIComponent(shareId)}&preview=1`;
    res.writeHead(302, {
      Location: location,
      "Cache-Control": "no-store",
    });
    res.end();
    return;
  }

  if (req.method === "GET" && pathname === "/api/debug/share-config") {
    return sendJson(res, 200, {
      supabaseEnabled: hasSupabaseShareBackend(),
      hasSupabaseUrl: Boolean(SUPABASE_URL),
      hasSupabaseServiceRoleKey: Boolean(SUPABASE_SERVICE_ROLE_KEY),
      storageBucket: SUPABASE_STORAGE_BUCKET || "",
      sharePayloadMaxBytes: SHARE_PAYLOAD_MAX_BYTES,
    });
  }

  if (req.method === "POST" && pathname === "/api/layout-generate") {
    handleLayoutGenerate(req, res);
    return;
  }

  if (req.method === "POST" && pathname === "/api/image-generate") {
    handleImageGenerate(req, res);
    return;
  }

  if (req.method === "POST" && pathname === "/api/auth/bootstrap") {
    handleAuthBootstrap(req, res);
    return;
  }

  if (req.method === "GET" && pathname === "/api/access/status") {
    handleAccessStatus(req, res);
    return;
  }

  if (req.method === "POST" && pathname === "/api/stripe/checkout/subscription") {
    handleStripeCheckoutSubscription(req, res);
    return;
  }

  if (req.method === "POST" && pathname === "/api/stripe/checkout/credits") {
    handleStripeCheckoutCredits(req, res);
    return;
  }

  if (req.method === "POST" && pathname === "/api/stripe/billing-portal") {
    handleStripeBillingPortal(req, res);
    return;
  }

  if (req.method === "POST" && pathname === "/api/stripe/webhook") {
    handleStripeWebhook(req, res);
    return;
  }

  if (req.method === "POST" && pathname === "/api/admin/login") {
    handleAdminLogin(req, res);
    return;
  }

  if (req.method === "GET" && pathname === "/api/admin/session") {
    handleAdminSession(req, res);
    return;
  }

  if (req.method === "POST" && pathname === "/api/admin/logout") {
    handleAdminLogout(req, res);
    return;
  }

  if (req.method === "GET" && pathname === "/api/admin/users") {
    handleAdminUsersList(req, res);
    return;
  }

  if (req.method === "PATCH" && adminUserPathMatch?.[1]) {
    handleAdminUserUpdate(req, res, decodeURIComponent(adminUserPathMatch[1]));
    return;
  }

  if (req.method === "DELETE" && adminUserPathMatch?.[1]) {
    handleAdminUserDelete(req, res, decodeURIComponent(adminUserPathMatch[1]));
    return;
  }

  if (req.method === "POST" && pathname === "/api/admin/email") {
    handleAdminUserEmail(req, res);
    return;
  }

  if (req.method === "GET" && pathname === "/api/auth/google/start") {
    handleAuthGoogleStart(req, res);
    return;
  }

  if (req.method === "GET" && pathname === "/api/projects") {
    handleProjectsList(req, res);
    return;
  }

  if (req.method === "POST" && pathname === "/api/projects") {
    handleProjectsCreate(req, res);
    return;
  }

  if (req.method === "GET" && projectSessionPathMatch) {
    handleProjectSessionLoad(req, res, projectSessionPathMatch[1]);
    return;
  }

  if (req.method === "PUT" && projectSessionPathMatch) {
    handleProjectSessionSave(req, res, projectSessionPathMatch[1]);
    return;
  }

  if (req.method === "POST" && pathname === "/api/share/init") {
    handleShareInit(req, res);
    return;
  }

  if (req.method === "GET" && pathname.startsWith("/api/share/") && pathname.includes("/asset/")) {
    const match = pathname.match(/^\/api\/share\/([^/]+)\/asset\/(.+)$/);
    if (!match) {
      return sendJson(res, 400, { error: "Invalid share asset route." });
    }
    const shareId = decodeURIComponent(match[1]);
    const relativePath = decodeURIComponent(match[2]);
    handleShareAssetGet(req, res, shareId, relativePath);
    return;
  }

  if (req.method === "POST" && pathname.startsWith("/api/share/") && pathname.includes("/asset/")) {
    const match = pathname.match(/^\/api\/share\/([^/]+)\/asset\/(.+)$/);
    if (!match) {
      return sendJson(res, 400, { error: "Invalid share asset route." });
    }
    const shareId = decodeURIComponent(match[1]);
    const relativePath = decodeURIComponent(match[2]);
    handleShareAssetUpload(req, res, shareId, relativePath);
    return;
  }

  if (req.method === "POST" && pathname === "/api/share") {
    handleShareCreate(req, res);
    return;
  }

  if (req.method === "POST" && pathname.startsWith("/api/share/") && pathname.endsWith("/project")) {
    const match = pathname.match(/^\/api\/share\/([^/]+)\/project$/);
    if (!match) {
      return sendJson(res, 400, { error: "Invalid share project route." });
    }
    const shareId = decodeURIComponent(match[1]);
    handleShareProjectUpload(req, res, shareId);
    return;
  }

  if (req.method === "GET" && pathname.startsWith("/api/share/")) {
    const shareId = decodeURIComponent(pathname.slice("/api/share/".length));
    handleShareGet(req, res, shareId);
    return;
  }

  if (req.method === "GET") {
    serveStatic(req, res);
    return;
  }

  res.writeHead(405);
  res.end("Method Not Allowed");
}

if (require.main === module) {
  const server = http.createServer(requestHandler);
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`Server running at http://127.0.0.1:${PORT}`);
  });
}

module.exports = requestHandler;
