import { existsSync } from "node:fs";
import { authenticateBearer } from "./http-auth.js";
import { KnowledgeService } from "./knowledge-service.js";
import { indexingWorker, knowledgeWorker } from "./knowledge-worker.js";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import crypto from "node:crypto";
import express, { type Request, type Response } from "express";
import cors from "cors";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import type { BookOrbitClient } from "./bookorbit-client.js";
import { UserClientPool } from "./user-client-pool.js";
import { BookCache } from "./cache.js";
import { BookService } from "./book-service.js";
import { registerTools } from "./tools.js";

const PORT = parseInt(process.env.PORT || "3001", 10);
const PUBLIC_URL = process.env.PUBLIC_URL || `http://127.0.0.1:${PORT}`;
const BOOKORBIT_URL = process.env.BOOKORBIT_URL || "http://127.0.0.1:3000";
const CACHE_DIR = process.env.CACHE_DIR || join(homedir(), ".cache", "bookorbit-mcp");
const DATA_DIR = process.env.OAUTH_DATA_DIR ?? join(process.cwd(), "data");
const OAUTH_FILE = join(DATA_DIR, "oauth.json");

interface OAuthData {
  clients: Record<
    string,
    {
      client_id: string;
      client_name?: string;
      redirect_uris: string[];
      client_id_issued_at: number;
    }
  >;
  tokens: Record<
    string,
    {
      username: string;
      password?: string;
      expiresAt: number;
    }
  >;
  refreshTokens: Record<
    string,
    {
      username: string;
      password?: string;
    }
  >;
}

let oauthData: OAuthData = { clients: {}, tokens: {}, refreshTokens: {} };

async function loadOAuthData(): Promise<void> {
  try {
    if (existsSync(OAUTH_FILE)) {
      const raw = await readFile(OAUTH_FILE, "utf-8");
      oauthData = JSON.parse(raw);
    }
  } catch (err) {
    console.error("[OAuth] Failed to load oauth.json:", err);
  }
}

let saveQueue = Promise.resolve();
async function saveOAuthData(): Promise<void> {
  const operation = saveQueue
    .catch(() => {})
    .then(async () => {
      await mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
      const temp = `${OAUTH_FILE}.${crypto.randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify(oauthData), {
        encoding: "utf-8",
        mode: 0o600,
      });
      await rename(temp, OAUTH_FILE);
    });
  saveQueue = operation;
  return operation;
}

interface AuthCodeRecord {
  code: string;
  clientId: string;
  username: string;
  password?: string;
  codeChallenge: string;
  redirectUri: string;
  expiresAt: number;
}
const authCodes = new Map<string, AuthCodeRecord>();

interface ActiveSession {
  sessionId: string;
  transport: SSEServerTransport;
  mcpServer: McpServer;
  client: BookOrbitClient;
  service: BookService;
  username: string;
}
const activeSessions = new Map<string, ActiveSession>();

const sharedCache = new BookCache(CACHE_DIR);
// SSE sessions are short-lived; upstream authentication belongs to the account.
const userClients = new UserClientPool(BOOKORBIT_URL);

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function renderLoginPage(
  _req: Request,
  res: Response,
  opts: {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    state: string;
    errorMessage?: string;
  },
) {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>BookOrbit AI Assistant Login</title>
  <style>
    :root {
      --bg: #0f1117;
      --card: #181b24;
      --border: #282d3c;
      --text: #e2e8f0;
      --subtext: #94a3b8;
      --primary: #38bdf8;
      --primary-hover: #0ea5e9;
      --error-bg: #450a0a;
      --error-border: #991b1b;
      --error-text: #fca5a5;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background-color: var(--bg);
      color: var(--text);
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 1.5rem;
    }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 1rem;
      padding: 2.25rem;
      width: 100%;
      max-width: 420px;
      box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5), 0 8px 10px -6px rgba(0, 0, 0, 0.4);
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      margin-bottom: 1.5rem;
    }
    .icon {
      font-size: 2rem;
    }
    h1 {
      font-size: 1.35rem;
      font-weight: 700;
      color: #fff;
    }
    p.desc {
      font-size: 0.9rem;
      color: var(--subtext);
      line-height: 1.4;
      margin-bottom: 1.75rem;
    }
    .error {
      background: var(--error-bg);
      border: 1px solid var(--error-border);
      color: var(--error-text);
      padding: 0.75rem 1rem;
      border-radius: 0.5rem;
      font-size: 0.85rem;
      margin-bottom: 1.25rem;
    }
    .form-group {
      margin-bottom: 1.25rem;
    }
    label {
      display: block;
      font-size: 0.85rem;
      font-weight: 500;
      color: var(--subtext);
      margin-bottom: 0.4rem;
    }
    input[type="text"], input[type="password"] {
      width: 100%;
      padding: 0.75rem 1rem;
      background: #0f1117;
      border: 1px solid var(--border);
      border-radius: 0.5rem;
      color: #fff;
      font-size: 0.95rem;
      outline: none;
      transition: border-color 0.15s;
    }
    input:focus {
      border-color: var(--primary);
      box-shadow: 0 0 0 1px var(--primary);
    }
    button {
      width: 100%;
      padding: 0.8rem 1rem;
      background: var(--primary);
      color: #041019;
      border: none;
      border-radius: 0.5rem;
      font-size: 0.95rem;
      font-weight: 600;
      cursor: pointer;
      margin-top: 0.5rem;
      transition: background 0.15s;
    }
    button:hover {
      background: var(--primary-hover);
    }
    .footer {
      margin-top: 1.5rem;
      text-align: center;
      font-size: 0.8rem;
      color: #64748b;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="brand">
      <span class="icon">📚</span>
      <div>
        <h1>BookOrbit</h1>
        <div style="font-size: 0.8rem; color: #38bdf8; font-weight: 500;">AI Assistant Connector</div>
      </div>
    </div>
    <p class="desc">Sign in with your BookOrbit account to connect your library and books to ChatGPT.</p>
    ${opts.errorMessage ? `<div class="error">${escapeHtml(opts.errorMessage)}</div>` : ""}
    <form method="POST" action="/mcp/oauth/authorize">
      <input type="hidden" name="client_id" value="${escapeHtml(opts.clientId)}" />
      <input type="hidden" name="redirect_uri" value="${escapeHtml(opts.redirectUri)}" />
      <input type="hidden" name="code_challenge" value="${escapeHtml(opts.codeChallenge)}" />
      <input type="hidden" name="state" value="${escapeHtml(opts.state)}" />
      
      <div class="form-group">
        <label for="username">Username</label>
        <input type="text" id="username" name="username" required autocomplete="username" autofocus />
      </div>
      
      <div class="form-group">
        <label for="password">Password</label>
        <input type="password" id="password" name="password" required autocomplete="current-password" />
      </div>

      <button type="submit">Authorize & Connect</button>
    </form>
    <div class="footer">BookOrbit &bull; Per-account authentication</div>
  </div>
</body>
</html>`;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
}

function getAuthenticatedUser(
  req: Request,
): { username: string; password?: string } | null {
  return authenticateBearer(req.headers.authorization, oauthData.tokens);
}

async function handleSseConnection(
  req: Request,
  res: Response,
  user: { username: string; password?: string },
) {
  console.log(`[MCP] Establishing SSE stream for user '${user.username}'`);

  const client = userClients.get(user);
  const service = new BookService(client, sharedCache);
  const mcpServer = new McpServer({
    name: `bookorbit-mcp-${user.username}`,
    version: "0.1.0",
  });
  registerTools(mcpServer, client, service);

  const endpointPath = req.params.username
    ? `/mcp/u/${req.params.username}/messages`
    : "/mcp/messages";
  const transport = new SSEServerTransport(endpointPath, res);

  activeSessions.set(transport.sessionId, {
    sessionId: transport.sessionId,
    transport,
    mcpServer,
    client,
    service,
    username: user.username,
  });

  res.on("close", () => {
    console.log(
      `[MCP] SSE connection closed: session ${transport.sessionId} (${user.username})`,
    );
    activeSessions.delete(transport.sessionId);
  });

  await mcpServer.connect(transport);
}

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// OAuth Metadata Discovery
app.get(
  [
    "/.well-known/oauth-authorization-server",
    "/mcp/.well-known/oauth-authorization-server",
    "/.well-known/openid-configuration",
  ],
  (_req, res) => {
    res.json({
      issuer: PUBLIC_URL,
      authorization_endpoint: `${PUBLIC_URL}/mcp/oauth/authorize`,
      token_endpoint: `${PUBLIC_URL}/mcp/oauth/token`,
      registration_endpoint: `${PUBLIC_URL}/mcp/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["mcp"],
    });
  },
);

app.get(
  ["/.well-known/oauth-protected-resource", "/mcp/.well-known/oauth-protected-resource"],
  (_req, res) => {
    res.json({
      resource: `${PUBLIC_URL}/mcp`,
      authorization_servers: [PUBLIC_URL],
      scopes_supported: ["mcp"],
    });
  },
);

// Dynamic Client Registration
app.post(["/mcp/oauth/register", "/oauth/register"], async (req, res) => {
  const body = req.body || {};
  if (
    !Array.isArray(body.redirect_uris) ||
    !body.redirect_uris.length ||
    body.redirect_uris.length > 10 ||
    !body.redirect_uris.every((uri: unknown) => {
      if (typeof uri !== "string" || uri.length > 2048) return false;
      try {
        const url = new URL(uri);
        return (
          !url.username &&
          !url.password &&
          !url.hash &&
          (url.protocol === "https:" ||
            (url.protocol === "http:" &&
              ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))
        );
      } catch {
        return false;
      }
    })
  )
    return res.status(400).json({ error: "invalid_redirect_uri" });
  if (Object.keys(oauthData.clients).length >= 1000)
    return res.status(429).json({ error: "registration_limit" });
  const clientId = "chatgpt_" + crypto.randomBytes(8).toString("hex");
  const client = {
    client_id: clientId,
    client_name: body.client_name || "ChatGPT MCP Client",
    redirect_uris: Array.isArray(body.redirect_uris) ? body.redirect_uris : [],
    client_id_issued_at: Math.floor(Date.now() / 1000),
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
  oauthData.clients[clientId] = client;
  await saveOAuthData();
  console.log(
    `[OAuth] Registered client ${clientId} with redirect_uris:`,
    client.redirect_uris,
  );
  res.status(201).json(client);
});

// Authorization Screen
app.get("/mcp/oauth/authorize", (req, res) => {
  const { client_id, redirect_uri, code_challenge, state } = req.query;
  if (
    typeof client_id !== "string" ||
    typeof redirect_uri !== "string" ||
    typeof code_challenge !== "string" ||
    req.query.code_challenge_method !== "S256" ||
    !/^[A-Za-z0-9_-]{43}$/.test(code_challenge) ||
    !oauthData.clients[client_id]?.redirect_uris.includes(redirect_uri)
  )
    return res.status(400).json({ error: "invalid_request" });
  renderLoginPage(req, res, {
    clientId: (client_id as string) || "",
    redirectUri: (redirect_uri as string) || "",
    codeChallenge: (code_challenge as string) || "",
    state: (state as string) || "",
  });
});

// Authorization Submission
app.post("/mcp/oauth/authorize", async (req, res) => {
  const { username, password, client_id, redirect_uri, code_challenge, state } = req.body;
  if (
    typeof username !== "string" ||
    typeof password !== "string" ||
    typeof client_id !== "string" ||
    typeof redirect_uri !== "string" ||
    typeof code_challenge !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(code_challenge) ||
    !oauthData.clients[client_id]?.redirect_uris.includes(redirect_uri)
  ) {
    return res.status(400).send("Missing required fields");
  }

  try {
    const loginRes = await fetch(`${BOOKORBIT_URL}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: username.trim(), password }),
    });

    if (!loginRes.ok) {
      return renderLoginPage(req, res, {
        clientId: client_id || "",
        redirectUri: redirect_uri,
        codeChallenge: code_challenge,
        state: state || "",
        errorMessage: "Invalid username or password. Please try again.",
      });
    }

    const code = crypto.randomBytes(24).toString("hex");
    authCodes.set(code, {
      code,
      clientId: client_id,
      username: username.trim(),
      password,
      codeChallenge: code_challenge,
      redirectUri: redirect_uri,
      expiresAt: Date.now() + 10 * 60 * 1000,
    });

    console.log(`[OAuth] Authorized user '${username.trim()}', issuing code`);
    const targetUrl = new URL(redirect_uri);
    targetUrl.searchParams.set("code", code);
    if (state) targetUrl.searchParams.set("state", state);
    res.redirect(targetUrl.toString());
  } catch (err) {
    console.error("[OAuth] Login verification error:", err);
    return renderLoginPage(req, res, {
      clientId: client_id || "",
      redirectUri: redirect_uri,
      codeChallenge: code_challenge,
      state: state || "",
      errorMessage: "Could not reach BookOrbit authentication service.",
    });
  }
});

// Token Exchange
app.post(["/mcp/oauth/token", "/oauth/token"], async (req, res) => {
  const grantType = req.body.grant_type;

  if (grantType === "authorization_code") {
    const { code, code_verifier } = req.body;
    if (!code) {
      return res
        .status(400)
        .json({ error: "invalid_request", error_description: "Missing code" });
    }

    const record = authCodes.get(code);
    if (
      !record ||
      record.expiresAt < Date.now() ||
      req.body.client_id !== record.clientId ||
      req.body.redirect_uri !== record.redirectUri
    ) {
      if (record && record.expiresAt < Date.now()) authCodes.delete(code);
      return res
        .status(400)
        .json({ error: "invalid_grant", error_description: "Invalid or expired code" });
    }

    if (record.codeChallenge) {
      if (!code_verifier) {
        return res.status(400).json({
          error: "invalid_grant",
          error_description: "Missing code_verifier for PKCE",
        });
      }
      const hash = crypto.createHash("sha256").update(code_verifier).digest("base64url");
      if (hash !== record.codeChallenge) {
        return res.status(400).json({
          error: "invalid_grant",
          error_description: "PKCE verification failed",
        });
      }
    }

    authCodes.delete(code);

    const accessToken = "bk_at_" + crypto.randomBytes(32).toString("hex");
    const refreshToken = "bk_rt_" + crypto.randomBytes(32).toString("hex");

    oauthData.tokens[accessToken] = {
      username: record.username,
      password: record.password,
      expiresAt: Date.now() + 30 * 86400 * 1000,
    };
    oauthData.refreshTokens[refreshToken] = {
      username: record.username,
      password: record.password,
    };
    await saveOAuthData();

    console.log(`[OAuth] Issued access token for user '${record.username}'`);
    return res.json({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: 2592000,
      refresh_token: refreshToken,
      scope: "mcp",
    });
  }

  if (grantType === "refresh_token") {
    const { refresh_token } = req.body;
    if (!refresh_token || !oauthData.refreshTokens[refresh_token]) {
      return res
        .status(400)
        .json({ error: "invalid_grant", error_description: "Invalid refresh token" });
    }

    const user = oauthData.refreshTokens[refresh_token];
    const accessToken = "bk_at_" + crypto.randomBytes(32).toString("hex");

    oauthData.tokens[accessToken] = {
      username: user.username,
      password: user.password,
      expiresAt: Date.now() + 30 * 86400 * 1000,
    };
    await saveOAuthData();

    return res.json({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: 2592000,
      refresh_token: refresh_token,
      scope: "mcp",
    });
  }

  return res.status(400).json({ error: "unsupported_grant_type" });
});

// MCP Connection Endpoints
app.get(["/mcp/sse", "/mcp"], async (req, res) => {
  const user = getAuthenticatedUser(req);
  if (!user) {
    res.setHeader(
      "WWW-Authenticate",
      `Bearer resource_metadata="${PUBLIC_URL}/.well-known/oauth-protected-resource"`,
    );
    return res
      .status(401)
      .json({ error: "unauthorized", message: "OAuth authentication required" });
  }

  await handleSseConnection(req, res, user);
});

app.get("/mcp/u/:username/sse", async (req, res) => {
  const user = getAuthenticatedUser(req);
  if (!user) {
    return res.status(404).send("User not found or configured");
  }
  await handleSseConnection(req, res, user);
});

app.post(["/mcp/messages", "/mcp/u/:username/messages"], async (req, res) => {
  const user = getAuthenticatedUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });
  const sessionId = req.query.sessionId as string;
  if (!sessionId) {
    return res.status(400).send("Missing sessionId parameter");
  }

  const session = activeSessions.get(sessionId);
  if (!session || session.username !== user.username) {
    return res.status(404).send("Session not found or expired");
  }

  try {
    await session.transport.handlePostMessage(req, res, req.body);
  } catch (err) {
    console.error(`[MCP] Error handling message for ${session.username}:`, err);
    if (!res.headersSent) {
      res.status(500).send("Error handling message");
    }
  }
});

let indexing = false;
async function indexTick(): Promise<void> {
  if (
    indexing ||
    process.env.BOOKORBIT_EXTENSIONS !== "1" ||
    process.env.AUTO_INDEX !== "1"
  )
    return;
  indexing = true;
  let madeProgress = false;
  try {
    const users = new Map(
      Object.values(oauthData.tokens)
        .filter((t) => t.expiresAt > Date.now() && t.password)
        .map((t) => [t.username, t]),
    );
    for (const user of users.values()) {
      const client = userClients.get(user);
      const service = new BookService(client, sharedCache);
      const knowledge = new KnowledgeService(client, service, CACHE_DIR, indexingWorker);
      const result = await knowledge.indexPending(3);
      madeProgress ||= result.results.some(
        (r) => typeof r === "object" && r !== null && !("error" in r),
      );
      console.error(
        `[Index] account=${user.username} processed=${result.results.length} pendingBefore=${result.pendingBefore}`,
      );
    }
  } catch {
    console.error("[Index] Background indexing failed; will retry next interval");
  } finally {
    indexing = false;
    // Keep a single serialized worker busy; back off when idle or failing.
    // Rebuild the live authorized account list on every tick.
    setTimeout(() => void indexTick(), madeProgress ? 1000 : 60_000).unref();
  }
}

async function main(): Promise<void> {
  await loadOAuthData();
  process.umask(0o077);
  setTimeout(() => void indexTick(), 15_000).unref();
  process.once("exit", () => {
    knowledgeWorker.close();
    indexingWorker.close();
  });
  app.listen(PORT, "127.0.0.1", () => {
    console.log(
      `[MCP] BookOrbit Multi-User MCP Server running on http://127.0.0.1:${PORT}`,
    );
    console.log(`[MCP] Public base URL: ${PUBLIC_URL}`);
  });
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
