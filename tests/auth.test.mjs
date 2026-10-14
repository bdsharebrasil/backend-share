import test from "node:test";
import assert from "node:assert/strict";
import { getAuthenticatedUserId, requireFlightOperationAccess } from "../src/lib/auth.ts";

function context({ authorization, apikey, env = {} } = {}) {
  const headers = new Map([
    ["authorization", authorization],
    ["apikey", apikey],
  ].filter(([, value]) => value));
  return {
    req: { header: (name) => headers.get(name.toLowerCase()) },
    env: { SUPABASE_URL: "https://auth-test.example", ...env },
  };
}

function jwtWithExpiry(expirationSeconds) {
  const payload = Buffer.from(JSON.stringify({ exp: expirationSeconds })).toString("base64url");
  return `header.${payload}.signature`;
}

test("valida identidade pela API oficial Supabase usando apikey público da requisição", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let request;
  globalThis.fetch = async (url, init) => {
    request = { url, init };
    return Response.json({ id: "user-from-supabase" });
  };

  const userId = await getAuthenticatedUserId(context({
    authorization: "Bearer legacy-hs256-access-token",
    apikey: "sb_publishable_public-test-key",
  }));

  assert.equal(userId, "user-from-supabase");
  assert.equal(request.url, "https://auth-test.example/auth/v1/user");
  assert.equal(new Headers(request.init.headers).get("apikey"), "sb_publishable_public-test-key");
  assert.equal(new Headers(request.init.headers).get("authorization"), "Bearer legacy-hs256-access-token");
});

test("rejeita sessão recusada pelo Supabase sem confiar no sub não verificado do JWT", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response(JSON.stringify({ id: "forged-user" }), { status: 401 });
  const token = `header.${Buffer.from(JSON.stringify({ sub: "forged-user" })).toString("base64url")}.signature`;

  assert.equal(await getAuthenticatedUserId(context({
    authorization: `Bearer ${token}`,
    apikey: "sb_publishable_public-test-key",
  })), null);
});

test("falha fechada quando não há token Bearer ou chave de API pública", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return Response.json({ id: "should-not-be-used" }); };

  assert.equal(await getAuthenticatedUserId(context({ authorization: "Basic credentials" })), null);
  assert.equal(await getAuthenticatedUserId(context({ authorization: "Bearer token-without-key" })), null);
  assert.equal(calls, 0);
});

test("permite operação de voo a qualquer colaborador autenticado, sem exigir vínculo de tripulação", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => Response.json({ id: "colaborador-autenticado" });
  const request = context({
    authorization: "Bearer authenticated-flight-user-token",
    apikey: "sb_publishable_flight-access-key",
    env: {
      SHARE_DB: {
        prepare: () => ({ bind: () => ({ first: async () => ({ id: "colaborador-autenticado", tipo_user: "operador" }) }) }),
      },
    },
  });

  assert.equal(await requireFlightOperationAccess(request, "agendamento-de-outro-tripulante"), true);
});

test("compartilha validação concorrente e reutiliza identidade em cache limitado pela expiração", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return Response.json({ id: "cached-user" });
  };
  const token = jwtWithExpiry(Math.floor(Date.now() / 1000) + 120);
  const request = context({ authorization: `Bearer ${token}`, apikey: "sb_publishable_cache-test-key" });

  const results = await Promise.all([
    getAuthenticatedUserId(request),
    getAuthenticatedUserId(request),
    getAuthenticatedUserId(request),
  ]);
  assert.deepEqual(results, ["cached-user", "cached-user", "cached-user"]);
  assert.equal(await getAuthenticatedUserId(request), "cached-user");
  assert.equal(calls, 1);
});
