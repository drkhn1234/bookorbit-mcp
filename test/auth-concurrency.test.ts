import { test } from "node:test";
import assert from "node:assert/strict";
import { BookOrbitClient, BookOrbitError } from "../src/bookorbit-client.js";
import { UserClientPool } from "../src/user-client-pool.js";

function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}
function credentials(token: string, cookie = "refresh-1"): Response {
  return json({ accessToken: token }, 200, {
    "set-cookie": `refresh_token=${cookie}; Path=/api/v1/auth; HttpOnly`,
  });
}
function client(fetchImpl: typeof fetch) {
  return new BookOrbitClient({
    baseUrl: "https://example.test",
    username: "reader",
    password: "test-password",
    fetchImpl,
  });
}
function stub(
  handler: (path: string, init: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return (async (input, init = {}) =>
    handler(new URL(String(input)).pathname, init)) as typeof fetch;
}

test("one login serves simultaneous cold calls and later sequential calls", async () => {
  let logins = 0;
  const c = client(
    stub(async (path, init) => {
      if (path.endsWith("/auth/login")) {
        logins++;
        await Promise.resolve();
        return credentials("access-1");
      }
      assert.equal(new Headers(init.headers).get("authorization"), "Bearer access-1");
      return json([]);
    }),
  );
  await Promise.all(Array.from({ length: 25 }, () => c.listLibraries()));
  for (let i = 0; i < 10; i++) await c.searchBooks("test");
  assert.equal(logins, 1);
});

test("parallel expired-token requests share one refresh and keep its rotated cookie", async () => {
  let logins = 0,
    refreshes = 0,
    valid = "access-1";
  const c = client(
    stub(async (path, init) => {
      if (path.endsWith("/auth/login")) {
        logins++;
        return credentials("access-1");
      }
      if (path.endsWith("/auth/refresh")) {
        refreshes++;
        assert.equal(
          new Headers(init.headers).get("cookie"),
          `refresh_token=refresh-${refreshes}`,
        );
        await Promise.resolve();
        valid = `access-${refreshes + 1}`;
        return credentials(valid, `refresh-${refreshes + 1}`);
      }
      return new Headers(init.headers).get("authorization") === `Bearer ${valid}`
        ? json([])
        : json({}, 401);
    }),
  );
  await c.listLibraries();
  valid = "expired";
  await Promise.all(Array.from({ length: 25 }, () => c.listLibraries()));
  valid = "expired-again";
  await c.listLibraries();
  assert.equal(logins, 1);
  assert.equal(refreshes, 2);
});

test("a delayed 401 from the old token does not start a second refresh", async () => {
  let refreshes = 0,
    oldReads = 0,
    expired = false;
  let release!: (response: Response) => void;
  const late401 = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const c = client(
    stub((path, init) => {
      if (path.endsWith("/auth/login")) return credentials("old");
      if (path.endsWith("/auth/refresh")) {
        refreshes++;
        return credentials("new");
      }
      if (expired && new Headers(init.headers).get("authorization") === "Bearer old") {
        oldReads++;
        return oldReads === 2 ? late401 : json({}, 401);
      }
      return json([]);
    }),
  );
  await c.listLibraries();
  expired = true;
  const first = c.listLibraries();
  const second = c.listLibraries();
  await first;
  release(json({}, 401));
  await second;
  assert.equal(oldReads, 2);
  assert.equal(refreshes, 1);
});

test("rejected refresh credentials cause only one replacement login", async () => {
  let logins = 0,
    refreshes = 0,
    expired = false;
  const c = client(
    stub((path) => {
      if (path.endsWith("/auth/login")) {
        logins++;
        expired = false;
        return credentials(`access-${logins}`);
      }
      if (path.endsWith("/auth/refresh")) {
        refreshes++;
        return json({}, 401);
      }
      return expired ? json({}, 401) : json([]);
    }),
  );
  await c.listLibraries();
  expired = true;
  await Promise.all(Array.from({ length: 20 }, () => c.listLibraries()));
  assert.equal(logins, 2);
  assert.equal(refreshes, 1);
});

for (const status of [429, 503]) {
  test(`refresh ${status} does not fall back to login or hammer refresh`, async () => {
    let logins = 0,
      refreshes = 0,
      expired = false;
    const c = client(
      stub((path) => {
        if (path.endsWith("/auth/login")) {
          logins++;
          return credentials("access-1");
        }
        if (path.endsWith("/auth/refresh")) {
          refreshes++;
          return json({}, status, { "retry-after": "120" });
        }
        return expired ? json({}, 401) : json([]);
      }),
    );
    await c.listLibraries();
    expired = true;
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => c.listLibraries()),
    );
    assert.ok(
      results.every(
        (r) =>
          r.status === "rejected" &&
          r.reason instanceof BookOrbitError &&
          r.reason.status === status,
      ),
    );
    await assert.rejects(c.listLibraries());
    assert.equal(logins, 1);
    assert.equal(refreshes, 1);
  });
}

test("network failure during refresh never triggers password login", async () => {
  let logins = 0,
    refreshes = 0,
    expired = false;
  const c = client(
    stub((path) => {
      if (path.endsWith("/auth/login")) {
        logins++;
        return credentials("access-1");
      }
      if (path.endsWith("/auth/refresh")) {
        refreshes++;
        throw new TypeError("test network failure");
      }
      return expired ? json({}, 401) : json([]);
    }),
  );
  await c.listLibraries();
  expired = true;
  await assert.rejects(c.listLibraries(), TypeError);
  await assert.rejects(c.listLibraries(), TypeError);
  assert.equal(logins, 1);
  assert.equal(refreshes, 1);
});

for (const httpDate of [false, true]) {
  test(`login 429 respects Retry-After ${httpDate ? "date" : "seconds"} and then recovers`, async (t) => {
    let now = 1_800_000_000_000,
      logins = 0;
    t.mock.method(Date, "now", () => now);
    const c = client(
      stub((path) => {
        if (path.endsWith("/auth/login")) {
          logins++;
          return logins === 1
            ? json({}, 429, {
                "retry-after": httpDate ? new Date(now + 120_000).toUTCString() : "120",
              })
            : credentials("access-1");
        }
        return json([]);
      }),
    );
    await assert.rejects(c.listLibraries());
    now += 119_000;
    await assert.rejects(c.listLibraries());
    assert.equal(logins, 1);
    now += 1001;
    await c.listLibraries();
    assert.equal(logins, 2);
  });
}

test("bad credentials are negatively cached across sequential and parallel calls", async () => {
  let logins = 0;
  const c = client(
    stub(() => {
      logins++;
      return json({}, 401);
    }),
  );
  const results = await Promise.allSettled(
    Array.from({ length: 20 }, () => c.listLibraries()),
  );
  assert.ok(results.every((r) => r.status === "rejected"));
  await assert.rejects(c.listLibraries());
  assert.equal(logins, 1);
});

test("ordinary API 429 and forbidden responses never cause reauthentication", async () => {
  for (const status of [403, 429]) {
    let logins = 0;
    const c = client(
      stub((path) => {
        if (path.endsWith("/auth/login")) {
          logins++;
          return credentials("access-1");
        }
        return json({}, status);
      }),
    );
    for (let i = 0; i < 3; i++) await assert.rejects(c.listLibraries());
    assert.equal(logins, 1);
  }
});

test("malformed authentication response does not cause repeated login attempts", async () => {
  let logins = 0;
  const c = client(
    stub(() => {
      logins++;
      return json({});
    }),
  );
  await assert.rejects(c.listLibraries(), /Invalid authentication response/);
  await assert.rejects(c.listLibraries());
  assert.equal(logins, 1);
});

test("new SSE sessions reuse clients only for the same username AND credentials", async () => {
  let logins = 0;
  const pool = new UserClientPool(
    "https://example.test",
    stub((path) => {
      if (path.endsWith("/auth/login")) {
        logins++;
        return credentials("access-1");
      }
      return json([]);
    }),
  );
  const user = { username: "alice", password: "test-1" };
  await Promise.all(
    Array.from({ length: 20 }, () => pool.get({ ...user }).listLibraries()),
  );
  assert.equal(logins, 1);
  assert.equal(pool.get(user), pool.get({ ...user }));
  assert.notEqual(pool.get(user), pool.get({ username: "bob", password: "test-1" }));
  assert.notEqual(pool.get(user), pool.get({ username: "alice", password: "test-2" }));
});
