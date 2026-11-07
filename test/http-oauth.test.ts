import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

test("HTTP OAuth binds client/redirect/PKCE and rejects expired and username-only access", async () => {
  const upstream = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end('{"accessToken":"synthetic-native-token"}');
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = (reservation.address() as any).port;
  await new Promise<void>((r) => reservation.close(() => r()));
  const dir = await mkdtemp(join(tmpdir(), "bo-oauth-"));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["--import", "tsx", "src/http-server.ts"], {
    env: {
      ...process.env,
      PORT: String(port),
      PUBLIC_URL: base,
      BOOKORBIT_URL: `http://127.0.0.1:${(upstream.address() as any).port}`,
      OAUTH_DATA_DIR: dir,
      BOOKORBIT_EXTENSIONS: "0",
      AUTO_INDEX: "0",
    },
    stdio: "ignore",
  });
  const post = (path: string, body: unknown) =>
    fetch(base + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      redirect: "manual",
    });
  try {
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(base + "/mcp/sse")).status === 401) break;
      } catch {
        /* wait for child listener */
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal((await fetch(base + "/mcp/u/reader2/sse")).status, 404);
    assert.equal((await post("/mcp/messages?sessionId=guess", {})).status, 401);
    assert.equal(
      (await post("/mcp/oauth/register", { redirect_uris: ["javascript:alert(1)"] }))
        .status,
      400,
    );
    const redirect = "http://127.0.0.1:55555/callback";
    const registration = await post("/mcp/oauth/register", { redirect_uris: [redirect] });
    assert.equal(registration.status, 201);
    const client = (await registration.json()) as any;
    const verifier = "v".repeat(43);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    assert.equal(
      (
        await fetch(
          base +
            "/mcp/oauth/authorize?" +
            new URLSearchParams({
              client_id: client.client_id,
              redirect_uri: "https://attacker.invalid/",
              code_challenge: challenge,
              code_challenge_method: "S256",
            }),
        )
      ).status,
      400,
    );
    const authorization = await post("/mcp/oauth/authorize", {
      username: "synthetic",
      password: "synthetic",
      client_id: client.client_id,
      redirect_uri: redirect,
      code_challenge: challenge,
      state: "test-state",
    });
    assert.equal(authorization.status, 302);
    const code = new URL(authorization.headers.get("location")!).searchParams.get("code");
    const exchange = {
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: client.client_id,
      redirect_uri: redirect,
    };
    assert.equal(
      (await post("/mcp/oauth/token", { ...exchange, client_id: "other-client" })).status,
      400,
    );
    assert.equal(
      (await post("/mcp/oauth/token", { ...exchange, code_verifier: "wrong" })).status,
      400,
    );
    const token = await post("/mcp/oauth/token", exchange);
    assert.equal(token.status, 200);
    const issued = (await token.json()) as any;
    assert.ok(issued.access_token);
    assert.equal((await post("/mcp/oauth/token", exchange)).status, 400);
    child.kill();
    await once(child, "exit");
    const data = JSON.parse(await readFile(join(dir, "oauth.json"), "utf8"));
    data.tokens[issued.access_token].expiresAt = 0;
    await writeFile(join(dir, "oauth.json"), JSON.stringify(data));
    const expired = spawn(process.execPath, ["--import", "tsx", "src/http-server.ts"], {
      env: {
        ...process.env,
        PORT: String(port),
        PUBLIC_URL: base,
        BOOKORBIT_URL: "http://127.0.0.1:1",
        OAUTH_DATA_DIR: dir,
        BOOKORBIT_EXTENSIONS: "0",
        AUTO_INDEX: "0",
      },
      stdio: "ignore",
    });
    try {
      for (let i = 0; i < 100; i++) {
        try {
          const response = await fetch(base + "/mcp/sse", {
            headers: { Authorization: `Bearer ${issued.access_token}` },
          });
          if (response.status === 401) break;
        } catch {
          /* wait for child listener */
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.equal(
        (
          await fetch(base + "/mcp/sse", {
            headers: { Authorization: `Bearer ${issued.access_token}` },
          })
        ).status,
        401,
      );
    } finally {
      expired.kill();
      await once(expired, "exit");
    }
  } finally {
    child.kill();
    upstream.close();
  }
});
