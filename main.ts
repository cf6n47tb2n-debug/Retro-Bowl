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
    const metaKey = ["save", username];

    if (req.method === "GET") {
      const meta = await kv.get<{ id: string; count: number; updatedAt: number }>(metaKey);
      if (!meta.value) return json({ data: null, updatedAt: 0 });
      const { id, count, updatedAt } = meta.value;
      let text = "";
      for (let i = 0; i < count; i += 10) {
        const keys: Deno.KvKey[] = [];
        for (let j = i; j < Math.min(i + 10, count); j++) {
          keys.push(["savechunk", username, id, j]);
        }
        const parts = await kv.getMany<string[]>(keys);
        for (const p of parts) text += p.value ?? "";
      }
      return json({ data: JSON.parse(text), updatedAt });
    }

    if (req.method === "PUT") {
      const body = await req.json().catch(() => null);
      if (typeof body?.data !== "object" || body.data === null) {
        return json({ error: "Bad save" }, 400);
      }
      // keep it ASCII-only so splitting into chunks can't corrupt characters
      const text = JSON.stringify(body.data).replace(
        /[\u007f-\uffff]/g,
        (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
      );
      if (text.length > 3_000_000) return json({ error: "Save too large" }, 413);

      const id = crypto.randomUUID();
      const size = 20_000;
      const count = Math.max(1, Math.ceil(text.length / size));
      for (let i = 0; i < count; i++) {
        await kv.set(["savechunk", username, id, i], text.slice(i * size, (i + 1) * size));
      }
      const updatedAt = Date.now();
      await kv.set(metaKey, { id, count, updatedAt });
      for await (const e of kv.list({ prefix: ["savechunk", username] })) {
        if (e.key[2] !== id) await kv.delete(e.key);
      }
      return json({ updatedAt });
    }
    return json({ error: "Method not allowed" }, 405);
  }

  return json({ error: "Not found" }, 404);
}

let patchedGame: string | null = null;
async function getPatchedGame() {
  if (!patchedGame) {
    const src = await Deno.readTextFile(
      new URL("./rb/html5game/RetroBowl.js", import.meta.url),
    );
    const patched = src.replace(
      "_SL._VL = _Jm(_dm, _em, 100035)._qA;",
      "_SL._VL = true;",
    );
    if (patched === src) console.warn("Team patch did not apply");
    patchedGame = patched;
  }
  return patchedGame;
}

Deno.serve(async (request) => {
  const path = new URL(request.url).pathname;
  if (path.startsWith("/api/")) return handleApi(request, path);
  if (path === "/rb/html5game/RetroBowl.js") {
    return new Response(await getPatchedGame(), {
      headers: {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "no-cache",
      },
    });
  }
  return serveDir(request, { fsRoot: "." });
});  
