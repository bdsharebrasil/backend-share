import { BASES_CCT_PONTO, REFERENCIAS_INTERNAS_2026 } from "../lib/pontoCct";
import { Hono } from "hono";
import { shareBrasilUser, type Colaborador } from "../lib/auth";
import { uuid } from "../lib/strings";
import type { Env } from "../types/env";
import {
  cicloPadrao,
  dataValida,
  datasMes,
  horaValida,
  horarioNoFuso,
  somarDias,
  validarCiclo,
  validarFuso,
  validarRegras,
  validarModeloEscala,
  type LinhaPonto,
  type TipoEscala,
} from "../lib/pontoGestao";
import {
  auditoriaPonto,
  elegivelPonto,
  espelhoPonto,
  exigir,
  fusoUsuario,
  hashEspelho,
  linhaAtualPonto,
  fecharCompetenciaPonto,
  instantesLinha,
  pendenciasFechamento,
  permissoesPonto,
  podeGerirPonto,
  PontoErro,
  registrarAvisoEntrada,
  registrarMarcacao,
  REGRAS_REFERENCIA,
  verificarMesAberto,
} from "../lib/pontoServico";
type Bindings = Pick<
  Env,
  | "SHARE_DB"
  | "SUPABASE_URL"
  | "SUPABASE_ANON_KEY"
  | "SUPABASE_SERVICE_ROLE_KEY"
  | "SHARE_FILES"
  | "FILES"
>;
type Variables = { usuarioPonto: Colaborador };
export const pontoGestaoRoutes = new Hono<{
  Bindings: Bindings;
  Variables: Variables;
}>();
pontoGestaoRoutes.use("*", async (c, next) => {
  c.header("Cache-Control", "private, no-store");
  const user = await shareBrasilUser(c);
  if (!user) return c.json({ error: "nao_autorizado" }, 401);
  if (["inativo", "inactive"].includes(String(user.status).toLowerCase()))
    return c.json({ error: "perfil_inativo" }, 403);
  c.set("usuarioPonto", user);
  return next();
});
pontoGestaoRoutes.onError((error, c) => {
  if (/competencia_fechada/.test(error.message))
    return c.json({ error: "competencia_fechada" }, 409);
  if (error instanceof PontoErro)
    return c.json({ error: error.message }, error.status);
  console.warn("[ponto]", error.message);
  return c.json(
    {
      error: /no such (table|column)/i.test(error.message)
        ? "atualizacao_ponto_pendente_migracao"
        : "falha_no_modulo_de_ponto",
    },
    503,
  );
});
const usuario = (c: any): Colaborador => c.get("usuarioPonto");
function competencia(c: any) {
  const mes =
    c.req.query("mes") ||
    horarioNoFuso(Date.now(), "America/Sao_Paulo").data.slice(0, 7);
  try {
    datasMes(mes);
  } catch {
    throw new PontoErro("competencia_invalida");
  }
  return mes as string;
}
async function listarEquipe(db: D1Database, gestor: Colaborador, mes?: string) {
  const p = await permissoesPonto(db, gestor);
  if (!p.gestor) return [];
  const rows = await db
    .prepare(
      `SELECT id,nome_completo,nome_exibicao,departamento,status FROM user_profiles u ${p.geral ? "" : "WHERE EXISTS (SELECT 1 FROM ponto_vinculos v WHERE v.user_id = u.id AND v.gestor_id = ?)"} ORDER BY nome_completo`,
    )
    .bind(...(p.geral ? [] : [gestor.id]))
    .all<any>();
  const elegiveis = [];
  for (const user of rows.results) {
    let historico = false;
    if (mes)
      historico = Boolean(
        await db
          .prepare(
            "SELECT id FROM lancamento_ponto WHERE user_id=? AND substr(data_entrada,1,7)=? LIMIT 1",
          )
          .bind(user.id, mes)
          .first(),
      );
    if ((await elegivelPonto(db, user)) || historico) elegiveis.push(user);
  }
  return elegiveis;
}
pontoGestaoRoutes.get("/contexto", async (c) => {
  const user = usuario(c);
  const db = c.env.SHARE_DB;
  const fuso = await fusoUsuario(db, user.id, c.req.query("fuso"));
  return c.json({
    user_id: user.id,
    elegivel: await elegivelPonto(db, user),
    permissoes: await permissoesPonto(db, user),
    fuso_horario: fuso,
    horario_servidor: new Date().toISOString(),
    hoje: horarioNoFuso(Date.now(), fuso).data,
    linha_atual: await linhaAtualPonto(
      db,
      user.id,
      horarioNoFuso(Date.now(), fuso).data,
    ),
  });
});
pontoGestaoRoutes.post("/entrada-login", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  return c.json(
    await registrarAvisoEntrada(c.env.SHARE_DB, usuario(c), b.fuso_horario),
  );
});
pontoGestaoRoutes.post("/entrada-login/dispensar", async (c) => {
  const user = usuario(c);
  const fuso = await fusoUsuario(c.env.SHARE_DB, user.id);
  await c.env.SHARE_DB.prepare(
    "UPDATE ponto_login_diario SET resposta='ADIADO' WHERE user_id=? AND data_local=? AND resposta='EXIBIDO'",
  )
    .bind(user.id, horarioNoFuso(Date.now(), fuso).data)
    .run();
  return c.json({ success: true });
});
pontoGestaoRoutes.post("/marcar", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return c.json(
    await registrarMarcacao(c.env.SHARE_DB, usuario(c), body, {
      ip: c.req.header("cf-connecting-ip") || null,
      userAgent: c.req.header("user-agent") || null,
    }),
  );
});
pontoGestaoRoutes.get("/espelho", async (c) => {
  const user = usuario(c);
  const alvo = c.req.query("user_id") || user.id;
  const mes = competencia(c);
  exigir(
    alvo === user.id ||
      (await podeGerirPonto(
        c.env.SHARE_DB,
        user,
        alvo,
        false,
        `${mes}-01`,
        datasMes(mes).slice(-1)[0],
      )),
    "acesso_ao_espelho_negado",
    403,
  );
  const resultado = await espelhoPonto(c.env.SHARE_DB, alvo, mes);
  return c.json(resultado);
});
pontoGestaoRoutes.get("/gestao", async (c) => {
  const user = usuario(c);
  const db = c.env.SHARE_DB;
  const p = await permissoesPonto(db, user);
  exigir(p.gestor, "acesso_restrito_ao_gestor", 403);
  const mes = competencia(c);
  const equipe = await listarEquipe(db, user, mes);
  const membros = [];
  for (const membro of equipe) {
    const espelho = await espelhoPonto(db, membro.id, mes);
    const escopos = p.geral
      ? []
      : (
          await db
            .prepare(
              "SELECT vigencia_inicio,vigencia_fim FROM ponto_vinculos WHERE user_id=? AND gestor_id=?",
            )
            .bind(membro.id, user.id)
            .all<{ vigencia_inicio: string; vigencia_fim: string | null }>()
        ).results;
    const permitido = (data: string) =>
      p.geral ||
      escopos.some(
        (v) =>
          v.vigencia_inicio <= data &&
          (!v.vigencia_fim || v.vigencia_fim >= data),
      );
    if (!p.geral) {
      espelho.dias = espelho.dias.filter((d: any) => permitido(d.data));
      if (!espelho.dias.length) continue;
      espelho.solicitacoes = espelho.solicitacoes.filter((s: any) =>
        permitido(s.data_referencia),
      );
      espelho.totais = Object.fromEntries(
        Object.keys(espelho.totais).map((k) => [
          k,
          espelho.dias.reduce((n: number, d: any) => n + Number(d[k] || 0), 0),
        ]),
      );
      const hojeLocal = horarioNoFuso(
        Date.now(),
        await fusoUsuario(db, membro.id),
      ).data;
      if (!permitido(hojeLocal))
        espelho.banco = {
          saldo_min: 0,
          vencido_a_liquidar_min: 0,
          movimentos: [],
        };
    }
    const diaAtual = horarioNoFuso(
      Date.now(),
      await fusoUsuario(db, membro.id),
    ).data;
    const hoje = espelho.dias.find((d: any) => d.data === diaAtual) || null;
    let ontem = espelho.dias.find(
      (d: any) =>
        d.data === somarDias(diaAtual, -1) &&
        d.linha?.entrada_hora &&
        !d.linha?.saida_hora,
    );
    if (
      !ontem &&
      diaAtual.endsWith("-01") &&
      mes === diaAtual.slice(0, 7) &&
      permitido(somarDias(diaAtual, -1))
    ) {
      const anterior = await espelhoPonto(
        db,
        membro.id,
        somarDias(diaAtual, -1).slice(0, 7),
      );
      ontem = anterior.dias.find(
        (d: any) =>
          d.data === somarDias(diaAtual, -1) &&
          d.linha?.entrada_hora &&
          !d.linha?.saida_hora,
      );
    }
    membros.push({
      ...membro,
      hoje: ontem || hoje,
      fechamento: espelho.fechamento,
      totais: espelho.totais,
      banco: espelho.banco,
      pendencias: pendenciasFechamento(espelho),
      solicitacoes: espelho.solicitacoes,
    });
  }
  return c.json({
    competencia: mes,
    atualizado_em: new Date().toISOString(),
    equipe: membros,
    permissoes: p,
  });
});
async function salvarSolicitacao(c: any, modo?: "CORRECAO" | "ATESTADO") {
  const user = usuario(c);
  const db: D1Database = c.env.SHARE_DB;
  exigir(
    await elegivelPonto(db, user),
    "departamento_sem_registro_de_ponto",
    403,
  );
  const multipart = (c.req.header("content-type") || "").includes(
    "multipart/form-data",
  );
  const form = multipart ? await c.req.formData() : null;
  const body = form ? Object.fromEntries(form.entries()) : await c.req.json();
  const tipo = modo || String(body.tipo || "");
  const data = String(
    body.data_referencia || body.data_entrada || body.data_registro || "",
  );
  exigir(dataValida(data), "data_invalida");
  exigir(
    ["CORRECAO", "ATESTADO", "DISPENSA", "HORA_EXTRA", "COMPENSACAO"].includes(
      tipo,
    ),
    "tipo_invalido",
  );
  await verificarMesAberto(db, user.id, data);
  const hoje = horarioNoFuso(Date.now(), await fusoUsuario(db, user.id)).data;
  exigir(
    data <= somarDias(hoje, 366) && data >= somarDias(hoje, -730),
    "data_fora_do_periodo_permitido",
  );
  const justificativa = String(body.justificativa || "").trim();
  exigir(
    justificativa.length >= 5 && justificativa.length <= 4000,
    "justificativa_deve_ter_5_a_4000_caracteres",
  );
  const campoRaw = String(body.campo || body.tipo_correcao || "");
  const campo =
    ({ entrada: "entrada_hora", saida: "saida_hora" } as any)[campoRaw] ||
    campoRaw;
  const horario = body.horario_corrigido || body.tempo_corrigido || null;
  if (tipo === "CORRECAO") {
    exigir(
      ["entrada_hora", "inicio_almoco", "fim_almoco", "saida_hora"].includes(
        campo,
      ) && horaValida(horario),
      "campo_ou_horario_invalido",
    );
    exigir(data <= hoje, "correcao_futura_nao_permitida");
  }
  const minutos =
    tipo === "CORRECAO"
      ? 0
      : Number(body.minutos || (modo === "ATESTADO" ? 1440 : 0));
  exigir(
    Number.isInteger(minutos) &&
      minutos >= (tipo === "CORRECAO" ? 0 : 1) &&
      minutos <= 1440,
    "duracao_invalida",
  );
  const id = uuid();
  let caminho: string | null = null;
  let anexo: string | null = null;
  const file = form?.get("arquivo");
  const bucket: R2Bucket | undefined = c.env.SHARE_FILES || c.env.FILES;
  try {
    const comandos: D1PreparedStatement[] = [];
    if (file && typeof file === "object" && "size" in file && file.size > 0) {
      exigir(
        file.size <= 10 * 1024 * 1024 &&
          ["application/pdf", "image/jpeg", "image/png", "image/webp"].includes(
            file.type,
          ),
        "arquivo_invalido_ou_acima_de_10mb",
      );
      exigir(bucket, "armazenamento_indisponivel", 409);
      anexo = uuid();
      caminho = `ponto/${user.id}/${anexo}`;
      await bucket.put(caminho, file.stream(), {
        httpMetadata: { contentType: file.type },
      });
      comandos.push(
        db
          .prepare(
            "INSERT INTO lancamento_ponto_anexos (id,user_id,data_entrada,caminho_arquivo,nome_arquivo,tipo_arquivo,tipo_justificativa,observacoes) VALUES (?,?,?,?,?,?,?,?)",
          )
          .bind(
            anexo,
            user.id,
            data,
            caminho,
            file.name.replace(/[\r\n"\\]/g, "_").slice(0, 200),
            file.type,
            tipo === "ATESTADO" ? "medical" : "other",
            justificativa,
          ),
      );
    }
    comandos.push(
      db
        .prepare(
          `INSERT INTO ponto_solicitacoes (id,user_id,data_referencia,tipo,minutos,campo,horario_corrigido,justificativa,anexo_id)
      SELECT ?,?,?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM ponto_fechamentos WHERE user_id=? AND competencia=? AND status='FECHADO_DP')`,
        )
        .bind(
          id,
          user.id,
          data,
          tipo,
          minutos,
          tipo === "CORRECAO" ? campo : null,
          tipo === "CORRECAO" ? horario : null,
          justificativa,
          anexo,
          user.id,
          data.slice(0, 7),
        ),
    );
    comandos.push(
      db
        .prepare(
          "UPDATE ponto_fechamentos SET status='EM_CONFERENCIA',espelho_json=NULL,fonte_hash=NULL WHERE user_id=? AND competencia=? AND status<>'FECHADO_DP'",
        )
        .bind(user.id, data.slice(0, 7)),
    );
    comandos.push(
      auditoriaPonto(db, user.id, user.id, "SOLICITACAO_CRIADA", id, {
        tipo,
        data,
        minutos,
      }),
    );
    await db.batch(comandos);
    exigir(
      await db
        .prepare("SELECT id FROM ponto_solicitacoes WHERE id=?")
        .bind(id)
        .first(),
      "competencia_fechada",
      409,
    );
    return c.json({ id, status: "PENDENTE" }, 201);
  } catch (error) {
    if (caminho && bucket) await bucket.delete(caminho).catch(() => undefined);
    throw error;
  }
}
pontoGestaoRoutes.post("/solicitacoes", (c) => salvarSolicitacao(c));
pontoGestaoRoutes.post("/correcao", (c) => salvarSolicitacao(c, "CORRECAO"));
pontoGestaoRoutes.post("/justificativa", (c) =>
  salvarSolicitacao(c, "ATESTADO"),
);
pontoGestaoRoutes.get("/solicitacoes/:id/anexo", async (c) => {
  const db = c.env.SHARE_DB;
  const user = usuario(c);
  const pedido = await db
    .prepare("SELECT * FROM ponto_solicitacoes WHERE id=?")
    .bind(c.req.param("id"))
    .first<any>();
  exigir(pedido, "solicitacao_nao_encontrada", 404);
  exigir(
    pedido.user_id === user.id ||
      (await podeGerirPonto(
        db,
        user,
        pedido.user_id,
        false,
        pedido.data_referencia,
      )),
    "acesso_ao_anexo_negado",
    403,
  );
  let anexo = pedido.anexo_id
    ? await db
        .prepare(
          "SELECT * FROM lancamento_ponto_anexos WHERE id=? AND user_id=?",
        )
        .bind(pedido.anexo_id, pedido.user_id)
        .first<any>()
    : null;
  if (!anexo && pedido.origem_tipo === "AUSENCIA_LEGADA") {
    const antiga = await db
      .prepare(
        "SELECT url_documento FROM justificativa_ausencia WHERE id=? AND id_usuario=?",
      )
      .bind(pedido.origem_id, pedido.user_id)
      .first<any>();
    if (antiga?.url_documento)
      anexo = {
        caminho_arquivo: antiga.url_documento,
        tipo_arquivo: "application/octet-stream",
        nome_arquivo: "comprovante",
      };
  }
  exigir(anexo, "anexo_nao_encontrado", 404);
  const objeto = await (c.env.SHARE_FILES || c.env.FILES)?.get(
    anexo.caminho_arquivo,
  );
  exigir(objeto, "arquivo_nao_encontrado", 404);
  c.header("Cache-Control", "private, no-store");
  return new Response(objeto.body, {
    headers: {
      "Content-Type": anexo.tipo_arquivo || "application/octet-stream",
      "Content-Disposition": `attachment; filename="${String(anexo.nome_arquivo).replace(/[\r\n"\\]/g, "_")}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
pontoGestaoRoutes.post("/solicitacoes/:id/decisao", async (c) => {
  const db = c.env.SHARE_DB;
  const user = usuario(c);
  const pedido = await db
    .prepare("SELECT * FROM ponto_solicitacoes WHERE id=?")
    .bind(c.req.param("id"))
    .first<any>();
  exigir(pedido, "solicitacao_nao_encontrada", 404);
  exigir(
    await podeGerirPonto(
      db,
      user,
      pedido.user_id,
      false,
      pedido.data_referencia,
    ),
    "gestor_sem_permissao_ou_autoaprovacao",
    403,
  );
  exigir(pedido.status === "PENDENTE", "solicitacao_ja_decidida", 409);
  await verificarMesAberto(db, pedido.user_id, pedido.data_referencia);
  const body = await c.req.json();
  exigir(["APROVADA", "REJEITADA"].includes(body.status), "decisao_invalida");
  const motivo = String(body.motivo || "").trim();
  exigir(
    body.status !== "REJEITADA" || motivo.length >= 5,
    "informe_o_motivo_da_rejeicao",
  );
  const minutos =
    body.minutos === undefined ? pedido.minutos : Number(body.minutos);
  exigir(
    Number.isInteger(minutos) && minutos >= 0 && minutos <= 1440,
    "duracao_invalida",
  );
  exigir(
    body.status !== "APROVADA" || pedido.tipo === "CORRECAO" || minutos > 0,
    "informe_a_duracao_do_abono_ou_da_autorizacao",
  );
  if (pedido.tipo === "CORRECAO" && body.status === "APROVADA") {
    exigir(
      ["entrada_hora", "inicio_almoco", "fim_almoco", "saida_hora"].includes(
        pedido.campo,
      ) && horaValida(pedido.horario_corrigido),
      "correcao_legada_precisa_ser_refeita",
    );
    const espelho = await espelhoPonto(
      db,
      pedido.user_id,
      pedido.data_referencia.slice(0, 7),
    );
    const dia = espelho.dias.find(
      (d: any) => d.data === pedido.data_referencia,
    );
    const linha: LinhaPonto = {
      ...(dia?.linha || { data_entrada: pedido.data_referencia }),
      [pedido.campo]: pedido.horario_corrigido,
    };
    try {
      instantesLinha(linha, dia?.fuso_horario || "America/Sao_Paulo");
    } catch {
      throw new PontoErro("sequencia_de_horarios_corrigidos_invalida");
    }
  }
  const instante = new Date().toISOString();
  const resultado = await db.batch([
    db
      .prepare(
        `UPDATE ponto_solicitacoes SET status=?,minutos=?,aprovado_por=?,aprovado_em=?,motivo_rejeicao=? WHERE id=? AND status='PENDENTE'
      AND NOT EXISTS (SELECT 1 FROM ponto_fechamentos WHERE user_id=? AND competencia=? AND status='FECHADO_DP')`,
      )
      .bind(
        body.status,
        minutos,
        user.id,
        instante,
        body.status === "REJEITADA" ? motivo : null,
        pedido.id,
        pedido.user_id,
        pedido.data_referencia.slice(0, 7),
      ),
    db
      .prepare(
        "UPDATE ponto_fechamentos SET status='EM_CONFERENCIA',espelho_json=NULL,fonte_hash=NULL WHERE user_id=? AND competencia=? AND status<>'FECHADO_DP'",
      )
      .bind(pedido.user_id, pedido.data_referencia.slice(0, 7)),
    db
      .prepare(
        `INSERT OR IGNORE INTO ponto_auditoria (id,ator_id,user_id,acao,entidade_id,dados_json) SELECT ?,?,?,?,?,? FROM ponto_solicitacoes WHERE id=? AND aprovado_por=? AND aprovado_em=?`,
      )
      .bind(
        `decisao:${pedido.id}`,
        user.id,
        pedido.user_id,
        "SOLICITACAO_DECIDIDA",
        pedido.id,
        JSON.stringify({
          antes: pedido.status,
          depois: body.status,
          minutos,
          motivo,
        }),
        pedido.id,
        user.id,
        instante,
      ),
  ]);
  exigir(
    Number(resultado[0]?.meta.changes || 0) === 1,
    "solicitacao_alterada_por_outro_gestor",
    409,
  );
  if (pedido.origem_tipo === "CORRECAO_LEGADA")
    await db
      .prepare(
        "UPDATE solicitacoes_correcao_ponto SET status=?,aprovado_por=?,aprovado_em=?,motivo_rejeicao=? WHERE id=?",
      )
      .bind(
        body.status === "APROVADA" ? "approved" : "rejected",
        user.id,
        instante,
        motivo || null,
        pedido.origem_id,
      )
      .run();
  if (pedido.origem_tipo === "AUSENCIA_LEGADA")
    await db
      .prepare(
        "UPDATE justificativa_ausencia SET status=?,aprovado_por=?,aprovado_em=?,motivo_rejeicao=? WHERE id=?",
      )
      .bind(
        body.status === "APROVADA" ? "aprovada" : "rejeitada",
        user.id,
        instante,
        motivo || null,
        pedido.origem_id,
      )
      .run();
  return c.json({ success: true });
});
pontoGestaoRoutes.get("/configuracao", async (c) => {
  const user = usuario(c);
  const db = c.env.SHARE_DB;
  const permissoes = await permissoesPonto(db, user);
  exigir(permissoes.gestor, "acesso_restrito_ao_gestor", 403);
  const [regras, escalas, vinculos] = await Promise.all([
    db
      .prepare(
        "SELECT * FROM ponto_regras ORDER BY vigencia_inicio DESC,criado_em DESC",
      )
      .all(),
    db.prepare("SELECT * FROM ponto_escalas ORDER BY nome").all(),
    db
      .prepare(
        `SELECT * FROM ponto_vinculos ${permissoes.geral ? "" : "WHERE gestor_id=?"} ORDER BY vigencia_inicio DESC`,
      )
      .bind(...(permissoes.geral ? [] : [user.id]))
      .all(),
  ]);
  const gestores = permissoes.dp
    ? await db
        .prepare(
          "SELECT id,nome_completo FROM user_profiles WHERE lower(COALESCE(status,'ativo')) NOT IN ('inativo','inactive') ORDER BY nome_completo",
        )
        .all()
    : { results: [] };
  return c.json({
    regras: regras.results,
    escalas: escalas.results,
    vinculos: vinculos.results,
    equipe: await listarEquipe(db, user),
    gestores: gestores.results,
    referencia_regras: REGRAS_REFERENCIA,
    bases_cct: [...REFERENCIAS_INTERNAS_2026, ...BASES_CCT_PONTO],
    feriados: (
      await db.prepare("SELECT * FROM ponto_feriados ORDER BY data,nome").all()
    ).results,
    modelos: Object.fromEntries(
      (["12X36", "6X1", "5X2", "ROTATIVA", "SOBREAVISO"] as TipoEscala[]).map(
        (tipo) => [tipo, cicloPadrao(tipo)],
      ),
    ),
    permissoes,
  });
});
pontoGestaoRoutes.post("/regras", async (c) => {
  const db = c.env.SHARE_DB;
  const user = usuario(c);
  exigir(
    (await permissoesPonto(db, user)).dp,
    "somente_dp_pode_validar_regras",
    403,
  );
  const b = await c.req.json();
  let parametros;
  try {
    parametros = validarRegras(b.parametros);
  } catch (error) {
    throw new PontoErro((error as Error).message);
  }
  exigir(
    String(b.grupo_codigo || "").trim().length >= 3 &&
      String(b.nome || "").trim().length >= 3 &&
      String(b.fonte_documento || "").trim().length >= 5 &&
      dataValida(b.vigencia_inicio),
    "nome_documento_e_vigencia_obrigatorios",
  );
  exigir(
    !b.vigencia_fim ||
      (dataValida(b.vigencia_fim) && b.vigencia_fim >= b.vigencia_inicio),
    "vigencia_invalida",
  );
  exigir(
    !(await db
      .prepare(
        "SELECT f.id FROM ponto_fechamentos f JOIN ponto_vinculos v ON v.user_id=f.user_id JOIN ponto_regras r ON r.id=v.regra_id WHERE r.grupo_codigo=? AND f.competencia>=? AND f.status='FECHADO_DP' LIMIT 1",
      )
      .bind(b.grupo_codigo.trim(), b.vigencia_inicio.slice(0, 7))
      .first()),
    "nova_regra_alteraria_competencia_fechada",
    409,
  );
  const id = uuid();
  const status = b.validar === true ? "VALIDADA" : "RASCUNHO";
  await db.batch([
    db
      .prepare(
        "INSERT INTO ponto_regras (id,grupo_codigo,nome,vigencia_inicio,vigencia_fim,fonte_documento,parametros_json,status,criado_por,validado_por,validado_em) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      )
      .bind(
        id,
        b.grupo_codigo.trim(),
        b.nome.trim(),
        b.vigencia_inicio,
        b.vigencia_fim || null,
        b.fonte_documento.trim(),
        JSON.stringify(parametros),
        status,
        user.id,
        status === "VALIDADA" ? user.id : null,
        status === "VALIDADA" ? new Date().toISOString() : null,
      ),
    auditoriaPonto(db, user.id, user.id, "REGRA_VERSIONADA", id, {
      nome: b.nome,
      status,
      parametros,
    }),
  ]);
  return c.json({ id, status }, 201);
});
pontoGestaoRoutes.post("/escalas", async (c) => {
  const user = usuario(c);
  const db = c.env.SHARE_DB;
  exigir(
    (await permissoesPonto(db, user)).dp,
    "somente_dp_configura_escalas",
    403,
  );
  const b = await c.req.json();
  exigir(
    ["12X36", "6X1", "5X2", "ROTATIVA", "SOBREAVISO"].includes(b.tipo) &&
      String(b.nome || "").trim().length >= 3,
    "escala_invalida",
  );
  let ciclo;
  try {
    ciclo = validarCiclo(b.ciclo);
    validarModeloEscala(b.tipo, ciclo);
  } catch (error) {
    throw new PontoErro((error as Error).message);
  }
  const id = uuid();
  await db.batch([
    db
      .prepare(
        "INSERT INTO ponto_escalas (id,nome,tipo,ciclo_json,criado_por) VALUES (?,?,?,?,?)",
      )
      .bind(id, b.nome.trim(), b.tipo, JSON.stringify(ciclo), user.id),
    auditoriaPonto(db, user.id, user.id, "ESCALA_CRIADA", id, {
      nome: b.nome,
      tipo: b.tipo,
      ciclo,
    }),
  ]);
  return c.json({ id }, 201);
});
pontoGestaoRoutes.post("/vinculos", async (c) => {
  const user = usuario(c);
  const db = c.env.SHARE_DB;
  exigir(
    (await permissoesPonto(db, user)).dp,
    "somente_dp_configura_vinculos",
    403,
  );
  const b = await c.req.json();
  exigir(
    dataValida(b.vigencia_inicio) && dataValida(b.data_base),
    "datas_invalidas",
  );
  let fuso: string;
  try {
    fuso = validarFuso(b.fuso_horario);
  } catch {
    throw new PontoErro("fuso_invalido");
  }
  const alvo = await db
    .prepare("SELECT * FROM user_profiles WHERE id=?")
    .bind(b.user_id)
    .first<Colaborador>();
  exigir(
    alvo && (await elegivelPonto(db, alvo)),
    "colaborador_fora_dos_departamentos_de_ponto",
  );
  exigir(
    await db
      .prepare("SELECT id FROM ponto_escalas WHERE id=?")
      .bind(b.escala_id)
      .first(),
    "escala_nao_encontrada",
  );
  const referencia = await db
    .prepare(
      "SELECT grupo_codigo FROM ponto_regras WHERE id=? AND status IN ('VALIDADA','REFERENCIA_INTERNA')",
    )
    .bind(b.regra_id)
    .first<{ grupo_codigo: string }>();
  exigir(referencia, "regra_precisa_ser_validada_pelo_dp");
  const vigente = await db
    .prepare(
      "SELECT * FROM ponto_regras WHERE grupo_codigo=? AND status IN ('VALIDADA','REFERENCIA_INTERNA') AND vigencia_inicio<=? ORDER BY vigencia_inicio DESC LIMIT 1",
    )
    .bind(referencia.grupo_codigo, b.vigencia_inicio)
    .first<any>();
  exigir(
    vigente &&
      (!vigente.vigencia_fim || vigente.vigencia_fim >= b.vigencia_inicio),
    "regra_fora_da_vigencia",
  );
  const parametros = JSON.parse(vigente.parametros_json);
  exigir(
    !parametros.ufs_abrangencia ||
      (alvo.uf &&
        parametros.ufs_abrangencia.split(",").includes(alvo.uf.toUpperCase())),
    "enquadramento_territorial_da_regra_incompativel",
  );
  exigir(
    dataValida(b.comunicada_em) && b.comunicada_em <= b.vigencia_inicio,
    "informe_quando_a_escala_foi_comunicada",
  );
  const antecedencia = Math.round(
    (Date.parse(b.vigencia_inicio) - Date.parse(b.comunicada_em)) / 86400000,
  );
  exigir(
    antecedencia >= parametros.antecedencia_escala_dias ||
      (String(b.justificativa_escala || "").trim().length >= 10 &&
        b.anuencia_colaborador === true),
    "antecedencia_insuficiente_informe_forca_maior_e_anuencia",
  );
  exigir(
    b.gestor_id &&
      b.gestor_id !== b.user_id &&
      (await db
        .prepare("SELECT id FROM user_profiles WHERE id=?")
        .bind(b.gestor_id)
        .first()),
    "defina_outro_usuario_como_gestor",
  );
  exigir(
    !(await db
      .prepare(
        "SELECT id FROM ponto_fechamentos WHERE user_id=? AND competencia>=? AND status='FECHADO_DP' LIMIT 1",
      )
      .bind(b.user_id, b.vigencia_inicio.slice(0, 7))
      .first()),
    "vinculo_alteraria_competencia_fechada",
    409,
  );
  exigir(
    !(await db
      .prepare(
        "SELECT id FROM ponto_vinculos WHERE user_id=? AND vigencia_inicio>=? LIMIT 1",
      )
      .bind(b.user_id, b.vigencia_inicio)
      .first()),
    "ja_existe_vinculo_nesta_vigencia_ou_posterior",
    409,
  );
  const id = uuid();
  await db.batch([
    db
      .prepare(
        "UPDATE ponto_vinculos SET vigencia_fim=? WHERE user_id=? AND (vigencia_fim IS NULL OR vigencia_fim>=?)",
      )
      .bind(somarDias(b.vigencia_inicio, -1), b.user_id, b.vigencia_inicio),
    db
      .prepare(
        "INSERT INTO ponto_vinculos (id,user_id,escala_id,regra_id,gestor_id,data_base,vigencia_inicio,fuso_horario,criado_por,comunicada_em,justificativa_escala,anuencia_colaborador) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .bind(
        id,
        b.user_id,
        b.escala_id,
        b.regra_id,
        b.gestor_id,
        b.data_base,
        b.vigencia_inicio,
        fuso,
        user.id,
        b.comunicada_em,
        b.justificativa_escala || null,
        b.anuencia_colaborador ? 1 : 0,
      ),
    auditoriaPonto(db, user.id, b.user_id, "VINCULO_DEFINIDO", id, b),
  ]);
  return c.json({ id }, 201);
});
pontoGestaoRoutes.post("/fechamentos/:mes/conferir", async (c) => {
  const db = c.env.SHARE_DB;
  const user = usuario(c);
  const mes = c.req.param("mes");
  const espelho = await espelhoPonto(db, user.id, mes);
  exigir(
    mes <=
      horarioNoFuso(Date.now(), await fusoUsuario(db, user.id)).data.slice(
        0,
        7,
      ),
    "competencia_futura",
  );
  exigir(!espelho.congelado, "competencia_fechada", 409);
  const pendencias = pendenciasFechamento(espelho);
  exigir(
    !pendencias.length,
    `resolva_as_pendencias: ${pendencias.slice(0, 5).join("; ")}`,
    409,
  );
  const id = `fechamento:${user.id}:${mes}`;
  const hash = await hashEspelho(espelho);
  await db.batch([
    db
      .prepare(
        `INSERT INTO ponto_fechamentos (id,user_id,competencia,status,espelho_json,fonte_hash,conferido_em) VALUES (?,?,?,'CONFERIDO',?,?,?) ON CONFLICT(user_id,competencia) DO UPDATE SET status='CONFERIDO',espelho_json=excluded.espelho_json,fonte_hash=excluded.fonte_hash,conferido_em=excluded.conferido_em WHERE ponto_fechamentos.status<>'FECHADO_DP'`,
      )
      .bind(
        id,
        user.id,
        mes,
        JSON.stringify({ ...espelho, fechamento: null }),
        hash,
        new Date().toISOString(),
      ),
    auditoriaPonto(db, user.id, user.id, "ESPELHO_CONFERIDO", id, { hash }),
  ]);
  return c.json({ success: true, fonte_hash: hash });
});
pontoGestaoRoutes.post("/fechamentos/:mes/aprovar", async (c) => {
  const db = c.env.SHARE_DB;
  const user = usuario(c);
  const b = await c.req.json();
  const mes = c.req.param("mes");
  exigir(
    await podeGerirPonto(
      db,
      user,
      b.user_id,
      false,
      `${mes}-01`,
      datasMes(mes).slice(-1)[0],
    ),
    "gestor_sem_permissao_ou_autoaprovacao",
    403,
  );
  const espelho = await espelhoPonto(db, b.user_id, mes);
  const hash = await hashEspelho(espelho);
  exigir(
    espelho.fechamento?.status === "CONFERIDO" &&
      espelho.fechamento.fonte_hash === hash &&
      !pendenciasFechamento(espelho).length,
    "espelho_alterado_ou_pendente_de_conferencia",
    409,
  );
  const result = await db.batch([
    db
      .prepare(
        "UPDATE ponto_fechamentos SET status='APROVADO_GESTOR',aprovado_por=?,aprovado_em=? WHERE id=? AND status='CONFERIDO' AND fonte_hash=?",
      )
      .bind(user.id, new Date().toISOString(), espelho.fechamento.id, hash),
    auditoriaPonto(
      db,
      user.id,
      b.user_id,
      "ESPELHO_APROVADO",
      espelho.fechamento.id,
      { hash },
    ),
  ]);
  exigir(Number(result[0]?.meta.changes || 0) === 1, "espelho_alterado", 409);
  return c.json({ success: true });
});
pontoGestaoRoutes.post("/fechamentos/:mes/fechar", async (c) => {
  const db = c.env.SHARE_DB;
  const user = usuario(c);
  exigir((await permissoesPonto(db, user)).dp, "somente_dp_pode_fechar", 403);
  const body = await c.req.json();
  return c.json(
    await fecharCompetenciaPonto(db, body.user_id, c.req.param("mes"), user.id),
  );
});
pontoGestaoRoutes.post("/regras/:id/validar", async (c) => {
  const db = c.env.SHARE_DB;
  const user = usuario(c);
  exigir(
    (await permissoesPonto(db, user)).dp,
    "somente_dp_pode_validar_regras",
    403,
  );
  const regra = await db
    .prepare("SELECT * FROM ponto_regras WHERE id=?")
    .bind(c.req.param("id"))
    .first<any>();
  exigir(regra, "regra_nao_encontrada", 404);
  exigir(
    ["RASCUNHO", "REFERENCIA_INTERNA"].includes(regra.status),
    "regra_ja_validada",
    409,
  );
  const resultado = await db.batch([
    db
      .prepare(
        "UPDATE ponto_regras SET status IN ('VALIDADA','REFERENCIA_INTERNA'),validado_por=?,validado_em=? WHERE id=? AND status IN ('RASCUNHO','REFERENCIA_INTERNA')",
      )
      .bind(user.id, new Date().toISOString(), regra.id),
    auditoriaPonto(db, user.id, user.id, "REGRA_VALIDADA", regra.id, {
      nome: regra.nome,
      vigencia_inicio: regra.vigencia_inicio,
      vigencia_fim: regra.vigencia_fim,
    }),
  ]);
  exigir(
    Number(resultado[0]?.meta.changes || 0) === 1,
    "regra_ja_validada",
    409,
  );
  return c.json({ success: true });
});
pontoGestaoRoutes.post("/feriados", async (c) => {
  const user = usuario(c);
  const db = c.env.SHARE_DB;
  exigir(
    (await permissoesPonto(db, user)).dp,
    "somente_dp_configura_calendario",
    403,
  );
  const b = await c.req.json();
  exigir(
    dataValida(b.data) &&
      String(b.nome || "").trim().length >= 3 &&
      (!b.uf || /^[A-Z]{2}$/.test(b.uf)),
    "feriado_invalido",
  );
  const id = uuid();
  await db.batch([
    db
      .prepare(
        "INSERT INTO ponto_feriados (id,data,nome,uf,municipio,recorrente_anual,criado_por) VALUES (?,?,?,?,?,?,?)",
      )
      .bind(
        id,
        b.data,
        b.nome.trim(),
        b.uf || null,
        String(b.municipio || "").trim() || null,
        b.recorrente_anual ? 1 : 0,
        user.id,
      ),
    auditoriaPonto(db, user.id, user.id, "FERIADO_CADASTRADO", id, b),
  ]);
  return c.json({ id }, 201);
});
