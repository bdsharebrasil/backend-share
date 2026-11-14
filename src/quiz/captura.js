import { recomendar, respostasCompletas, PERGUNTAS, VERSAO_QUIZ } from "./modelo.js";

const encoder = new TextEncoder();
const hex = (buffer) =>
  [...new Uint8Array(buffer)].map((x) => x.toString(16).padStart(2, "0")).join("");
const hash = async (value) => hex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
async function assinar(secret, value) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}
const uuid = (v) =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const texto = (v, max) =>
  typeof v === "string"
    ? v
        .trim()
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .slice(0, max)
    : "";
export function validarEnvio(body) {
  if (!body || typeof body !== "object" || body.website)
    throw new Error("Não foi possível validar o envio.");
  if (
    !uuid(body.chave_reenvio) ||
    body.versao !== VERSAO_QUIZ ||
    !respostasCompletas(body.respostas)
  )
    throw new Error("Atualize a página e revise as respostas do quiz.");
  // Contato é opcional. Sem autorização, dados pessoais são descartados.
  const informado = body.contato && typeof body.contato === "object" ? body.contato : {};
  const c = informado.consentimento === true ? informado : {};
  const nome = texto(c.nome, 100),
    cidade = texto(c.cidade, 100),
    rotas = texto(c.rotas, 250);
  let telefone = typeof c.telefone === "string" ? c.telefone.replace(/\D/g, "") : "";
  if (telefone.length === 10 || telefone.length === 11) telefone = `55${telefone}`;
  if ((nome && nome.length < 2) || (telefone && !/^55[1-9]{2}[2-9][0-9]{7,8}$/.test(telefone)))
    throw new Error("Confira os dados opcionais que preencheu.");
  const momento = c.momento || "EXPLORANDO";
  if (!["EXPLORANDO", "ATE_3_MESES", "ATE_6_MESES", "ESTE_ANO"].includes(momento))
    throw new Error("Momento de compra inválido.");
  const consentimento = c.consentimento === true && !!(nome || telefone || cidade || rotas) ? 1 : 0;
  const respostas = Object.fromEntries(PERGUNTAS.map((p) => [p.id, body.respostas[p.id]]));
  const origem = {};
  for (const campo of ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"]) {
    if (body.origem?.[campo]) origem[campo] = texto(body.origem[campo], 150);
  }
  return {
    chave_reenvio: body.chave_reenvio.toLowerCase(),
    nome: nome || null,
    telefone: telefone || null,
    cidade: cidade || null,
    rotas: rotas || null,
    momento,
    consentimento,
    respostas,
    origem,
    duracao_segundos: Number.isFinite(body.duracao_segundos)
      ? Math.max(0, Math.min(86400, Math.floor(body.duracao_segundos)))
      : 0,
  };
}
async function lerJson(request) {
  // Limite também para corpos chunked: não depende de Content-Length.
  if (Number(request.headers.get("content-length")) > 12000)
    throw Object.assign(new Error("Envio muito grande."), { status: 413 });
  const reader = request.body?.getReader();
  if (!reader) throw Object.assign(new Error("Envio inválido."), { status: 400 });
  let bytes = 0;
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > 12000) {
      await reader.cancel();
      throw Object.assign(new Error("Envio muito grande."), { status: 413 });
    }
    chunks.push(value);
  }
  const data = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder().decode(data));
  } catch {
    throw Object.assign(new Error("JSON inválido."), { status: 400 });
  }
}
async function limitar(request, env) {
  const agora = Math.floor(Date.now() / 1000),
    janela = Math.floor(agora / 3600);
  const ip = request.headers.get("CF-Connecting-IP") || "local";
  const chave = await assinar(env.QUIZ_HASH_SECRET, `limite:${ip}:${janela}`);
  const row = await env.DB.prepare(
    "INSERT INTO limites_quiz (chave,quantidade,expira_em) VALUES (?,1,?) ON CONFLICT(chave) DO UPDATE SET quantidade=quantidade+1 RETURNING quantidade",
  )
    .bind(chave, (janela + 2) * 3600)
    .first();
  return row.quantidade <= 60;
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url),
      origin = request.headers.get("Origin");
    const permitidas = (env.ORIGENS_PERMITIDAS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const headers = {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      Vary: "Origin",
      "X-Content-Type-Options": "nosniff",
    };
    if (origin && permitidas.includes(origin)) {
      headers["Access-Control-Allow-Origin"] = origin;
      headers["Access-Control-Allow-Methods"] = "POST, OPTIONS";
      headers["Access-Control-Allow-Headers"] = "Content-Type";
    }
    const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers });
    if (!origin || !permitidas.includes(origin))
      return json({ erro: "Origem não autorizada." }, 403);
    const evento = url.pathname.match(/^\/api\/quiz\/leads\/([a-f0-9-]{36})\/eventos$/i);
    if (url.pathname !== "/api/quiz/leads" && !evento)
      return json({ erro: "Rota não encontrada." }, 404);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (request.method !== "POST") return json({ erro: "Método não permitido." }, 405);
    if (!env.DB || !env.QUIZ_HASH_SECRET)
      return json({ erro: "O registro de perfis está temporariamente indisponível." }, 503);
    if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json"))
      return json({ erro: "Use application/json." }, 415);
    try {
      if (!(await limitar(request, env)))
        return json({ erro: "Muitas tentativas. Tente novamente mais tarde." }, 429);
      const body = await lerJson(request);
      if (evento) {
        if (
          body?.tipo !== "WHATSAPP_CLICADO" ||
          typeof body.token !== "string" ||
          !/^[a-f0-9]{64}$/.test(body.token)
        )
          return json({ erro: "Evento inválido." }, 400);
        const lead = await env.DB.prepare(
          "SELECT id FROM quiz_participacoes WHERE id=? AND token_evento_hash=?",
        )
          .bind(evento[1], await hash(body.token))
          .first();
        if (!lead) return json({ erro: "Registro não encontrado." }, 404);
        await env.DB.batch([
          env.DB.prepare(
            "INSERT OR IGNORE INTO quiz_eventos (id,lead_id,tipo) VALUES (?,?,'WHATSAPP_CLICADO')",
          ).bind(crypto.randomUUID(), lead.id),
          env.DB.prepare(
            "UPDATE quiz_participacoes SET whatsapp_clicado_em=COALESCE(whatsapp_clicado_em,CURRENT_TIMESTAMP),atualizado_em=CURRENT_TIMESTAMP WHERE id=?",
          ).bind(lead.id),
        ]);
        return json({ registrado: true });
      }
      let dados;
      try {
        dados = validarEnvio(body);
      } catch (e) {
        return json({ erro: e.message }, 400);
      }
      const resultado = recomendar(dados.respostas);
      const resumo = await hash(JSON.stringify(dados));
      const chaveHash = await hash(dados.chave_reenvio);
      // Token determinístico e opaco permite reenvio sem duplicar o cadastro.
      const token = await assinar(env.QUIZ_HASH_SECRET, `evento:${dados.chave_reenvio}`);
      const id = crypto.randomUUID();
      const protocolo = `SH-${id.replace(/-/g, "").slice(0, 12).toUpperCase()}`;
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO quiz_participacoes
          (id,protocolo,chave_reenvio,resumo_envio,nome,telefone,cidade,rotas,momento,respostas_json,resultado_json,aeronave_sugerida,aeronave_alternativa,versao_quiz,origem_json,duracao_segundos,consentimento,versao_consentimento,consentimento_em,token_evento_hash)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'2026-11-v3',?,?) ON CONFLICT(chave_reenvio) DO NOTHING`,
        ).bind(
          id,
          protocolo,
          chaveHash,
          resumo,
          dados.nome,
          dados.telefone,
          dados.cidade,
          dados.rotas || null,
          dados.momento,
          JSON.stringify(dados.respostas),
          JSON.stringify(resultado),
          resultado.principal,
          resultado.segunda,
          VERSAO_QUIZ,
          JSON.stringify(dados.origem),
          dados.duracao_segundos,
          dados.consentimento,
          dados.consentimento ? new Date().toISOString() : null,
          await hash(token),
        ),
        env.DB.prepare(
          "INSERT OR IGNORE INTO quiz_eventos (id,lead_id,tipo) SELECT ?,id,'PERFIL_SALVO' FROM quiz_participacoes WHERE chave_reenvio=?",
        ).bind(crypto.randomUUID(), chaveHash),
      ]);
      // Somente metadados do próprio envio; não há endpoint público de consulta de leads.
      const salvo = await env.DB.prepare(
        "SELECT id,protocolo,resumo_envio,resultado_json FROM quiz_participacoes WHERE chave_reenvio=?",
      )
        .bind(chaveHash)
        .first();
      if (salvo.resumo_envio !== resumo)
        return json(
          {
            erro: "Este envio já foi registrado com outros dados. Refaça o quiz para criar outro perfil.",
          },
          409,
        );
      return json(
        {
          id: salvo.id,
          protocolo: salvo.protocolo,
          token_evento: token,
          resultado: JSON.parse(salvo.resultado_json),
        },
        201,
      );
    } catch (e) {
      // Nunca registra payload, telefone, IP ou mensagem de banco nos logs.
      return json(
        {
          erro: e.status
            ? "Não foi possível validar o envio."
            : "Não foi possível salvar agora. Tente novamente.",
        },
        e.status || 503,
      );
    }
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(
      env.DB.batch([
        env.DB.prepare("DELETE FROM limites_quiz WHERE expira_em < ?").bind(
          Math.floor(Date.now() / 1000),
        ),
      ]),
    );
  },
};
