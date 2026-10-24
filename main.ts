import { serveDir } from "jsr:@std/http/file-server";

const kv = await Deno.openKv();
const enc = new TextEncoder();

const b64 = (b: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(b)));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), {
    status,
    headers: { "content-type": "application/json" },
  });

async function hashPassword(pw: string, salt: Uint8Array) {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(pw),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: 100_000 },
    key,
    256,
  );
  return b64(bits);
}

async function newSession(username: string) {
  const token = crypto.randomUUID() + crypto.randomUUID();
  await kv.set(["sessions", token], { username }, {
    expireIn: 30 * 24 * 3600 * 1000, // 30 days
  });
  return token;
}

async function authedUser(req: Request): Promise<string | null> {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) return null;
  const res = await kv.get<{ username: string }>(["sessions", token]);
  return res.value?.username ?? null;
}

type UserRecord = { salt: string; hash: string };

async function handleApi(req: Request, path: string): Promise<Response> {
  if (path === "/api/register" || path === "/api/login") {
    if (req.method !== "POST") return json({ error: "POST only" }, 405);
    const body = await req.json().catch(() => null);
    const username = String(body?.username ?? "").trim().toLowerCase();
    const password = String(body?.password ?? "");
    if (!/^[a-z0-9_]{3,24}$/.test(username)) {
      return json({ error: "Username must be 3-24 letters, numbers or _" }, 400);
    }
    if (password.length < 6) {
      return json({ error: "Password must be at least 6 characters" }, 400);
    }

    if (path === "/api/register") {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const record: UserRecord = {
        salt: b64(salt),
        hash: await hashPassword(password, salt),
      };
      const key = ["users", username];
      const ok = await kv.atomic().check({ key, versionstamp: null })
        .set(key, record).commit();
      if (!ok.ok) return json({ error: "That username is taken" }, 409);
      return json({ token: await newSession(username) });
    }

    const user = await kv.get<UserRecord>(["users", username]);
    if (!user.value) return json({ error: "Wrong username or password" }, 401);
    const h = await hashPassword(password, unb64(user.value.salt));
    if (h !== user.value.hash) {
      return json({ error: "Wrong username or password" }, 401);
    }
    return json({ token: await newSession(username) });
  }

  if (path === "/api/save") {
    const username = await authedUser(req);
    if (!username) return json({ error: "Not logged in" }, 401);
    const key = ["saves", username];

    if (req.method === "GET") {
      const res = await kv.get<{ data: Record<string, string>; updatedAt: number }>(key);
      return json(res.value ?? { data: null, updatedAt: 0 });
    }
    if (req.method === "PUT") {
      const text = await req.text();
      if (text.length > 2_000_000) return json({ error: "Save too large" }, 413);
      const body = JSON.parse(text);
      if (typeof body?.data !== "object" || body.data === null) {
        return json({ error: "Bad save" }, 400);
      }
      const updatedAt = Date.now();
      await kv.set(key, { data: body.data, updatedAt });
      return json({ updatedAt });
    }
    return json({ error: "Method not allowed" }, 405);
  }

  return json({ error: "Not found" }, 404);
}

Deno.serve((request) => {
  const path = new URL(request.url).pathname;
  if (path.startsWith("/api/")) return handleApi(request, path);
  return serveDir(request, { fsRoot: "." });
});
