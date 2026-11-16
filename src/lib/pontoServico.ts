import type { Colaborador } from "./auth";
import { uuid } from "./strings";
import {
  calcularDiaPonto,
  dataValida,
  datasMes,
  departamentoBatePonto,
  escalaDoDia,
  horarioNoFuso,
  instantesLinha,
  normalizarPonto,
  REGRAS_REFERENCIA,
  somarDias,
  validarFuso,
  type LinhaPonto,
  type MarcacaoPonto,
  type RegrasPonto,
} from "./pontoGestao";
export class PontoErro extends Error {
  constructor(
    message: string,
    public status: 400 | 403 | 404 | 409 = 400,
  ) {
    super(message);
  }
}
export function exigir(
  condicao: unknown,
  mensagem: string,
  status: 400 | 403 | 404 | 409 = 400,
): asserts condicao {
  if (!condicao) throw new PontoErro(mensagem, status);
}
export function auditoriaPonto(
  db: D1Database,
  ator: string,
  usuario: string,
  acao: string,
  entidade: string,
  dados: unknown,
) {
  return db
    .prepare(
      "INSERT INTO ponto_auditoria (id,ator_id,user_id,acao,entidade_id,dados_json) VALUES (?,?,?,?,?,?)",
    )
    .bind(uuid(), ator, usuario, acao, entidade, JSON.stringify(dados));
}
export async function elegivelPonto(
  db: D1Database,
  user: Pick<Colaborador, "id" | "departamento" | "status">,
): Promise<boolean> {
  if (["inativo", "inactive"].includes(normalizarPonto(user.status)))
    return false;
  if (departamentoBatePonto(user.departamento)) return true;
  // Algumas instalações guardam o ID da lotação, outras o nome.
  if (!user.departamento) return false;
  const tabela = await db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='departamentos_email'",
    )
    .first();
  if (!tabela) return false;
  const departamento = await db
    .prepare("SELECT nome FROM departamentos_email WHERE id = ?")
    .bind(user.departamento)
    .first<{ nome: string }>();
  return departamentoBatePonto(departamento?.nome);
}
// Dois parâmetros mantêm a compatibilidade com o responsável único legado.
export const escopoGestorPontoSql = (alias = "v") =>
  `(${alias}.gestor_id = ? OR EXISTS (SELECT 1 FROM ponto_vinculos_gestores vg WHERE vg.vinculo_id = ${alias}.id AND vg.gestor_id = ?))`;

export function perfisCoordenacaoPonto(
  tipo: unknown,
  funcoes: string[],
  departamento: unknown,
) {
  const papeis = [tipo, ...funcoes].map(normalizarPonto);
  const perfis: string[] = [];
  if (papeis.some((p) => ["gestor master", "gestormaster"].includes(p)))
    perfis.push("Gestor Master");
  if (papeis.some((p) => ["admin", "administrador"].includes(p)))
    perfis.push("Admin");
  if ([...papeis, normalizarPonto(departamento)].includes("contabilidade"))
    perfis.push("Contabilidade");
  if (papeis.some((p) => ["rh", "rh master"].includes(p))) perfis.push("RH");
  return perfis;
}

export async function listarCoordenadoresPonto(db: D1Database) {
  const [usuarios, funcoes, vinculados, temDepartamentos] = await Promise.all([
    db
      .prepare(
        "SELECT id,nome_completo,tipo_user,departamento FROM user_profiles WHERE lower(trim(COALESCE(status,'ativo'))) NOT IN ('inativo','inactive') ORDER BY nome_completo",
      )
      .all<{
        id: string;
        nome_completo: string;
        tipo_user: string | null;
        departamento: string | null;
      }>(),
    db
      .prepare("SELECT user_id,funcao FROM usuarios_funcoes")
      .all<{ user_id: string; funcao: string }>(),
    db
      .prepare(
        "SELECT gestor_id FROM ponto_vinculos WHERE gestor_id IS NOT NULL UNION SELECT gestor_id FROM ponto_vinculos_gestores",
      )
      .all<{ gestor_id: string }>(),
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='departamentos_email'",
      )
      .first(),
  ]);
  const departamentos = temDepartamentos
    ? (
        await db
          .prepare("SELECT id,nome FROM departamentos_email")
          .all<{ id: string; nome: string }>()
      ).results
    : [];
  const nomesDepartamentos = new Map(departamentos.map((d) => [d.id, d.nome]));
  const porUsuario = new Map<string, string[]>();
  for (const f of funcoes.results)
    porUsuario.set(f.user_id, [...(porUsuario.get(f.user_id) || []), f.funcao]);
  const existentes = new Set(vinculados.results.map((v) => v.gestor_id));
  return usuarios.results.flatMap((u) => {
    const perfis = perfisCoordenacaoPonto(
      u.tipo_user,
      porUsuario.get(u.id) || [],
      nomesDepartamentos.get(u.departamento || "") || u.departamento,
    );
    // Preserva responsáveis já cadastrados, mesmo que usem outro perfil.
    if (!perfis.length && existentes.has(u.id))
      perfis.push("Coordenador vinculado");
    return perfis.length
      ? [{ id: u.id, nome_completo: u.nome_completo, perfis }]
      : [];
  });
}

export async function permissoesPonto(db: D1Database, user: Colaborador) {
  const funcoes = await db
    .prepare("SELECT funcao FROM usuarios_funcoes WHERE user_id = ?")
    .bind(user.id)
    .all<{ funcao: string }>();
  const papeis = [
    user.tipo_user,
    ...(funcoes.results || []).map((x) => x.funcao),
  ].map(normalizarPonto);
  const dp = papeis.some((x) =>
    ["admin", "administrador", "rh", "rh master"].includes(x),
  );
  const geral =
    dp || papeis.some((x) => ["gestor master", "gestormaster"].includes(x));
  const vinculo = await db
    .prepare(
      `SELECT v.id FROM ponto_vinculos v WHERE ${escopoGestorPontoSql()} LIMIT 1`,
    )
    .bind(user.id, user.id)
    .first();
  return { dp, gestor: geral || Boolean(vinculo), geral };
}
export async function podeGerirPonto(
  db: D1Database,
  ator: Colaborador,
  alvo: string,
  permitirProprio = false,
  inicioEscopo = new Date().toISOString().slice(0, 10),
  fimEscopo = inicioEscopo,
): Promise<boolean> {
  if (ator.id === alvo && !permitirProprio) return false;
  const p = await permissoesPonto(db, ator);
  if (p.geral) return true;
  return Boolean(
    await db
      .prepare(
        `SELECT v.id FROM ponto_vinculos v WHERE v.user_id = ? AND ${escopoGestorPontoSql()} AND v.vigencia_inicio <= ? AND (v.vigencia_fim IS NULL OR v.vigencia_fim >= ?) LIMIT 1`,
      )
      .bind(alvo, ator.id, ator.id, inicioEscopo, fimEscopo)
      .first(),
  );
}
export async function fusoUsuario(
  db: D1Database,
  userId: string,
  informado?: unknown,
): Promise<string> {
  const atual = await db
    .prepare("SELECT fuso_horario FROM ponto_preferencias WHERE user_id = ?")
    .bind(userId)
    .first<{ fuso_horario: string }>();
  const base =
    atual?.fuso_horario ||
    (informado ? validarFuso(informado) : "America/Sao_Paulo");
  const hoje = horarioNoFuso(Date.now(), base).data;
  const vinculo = await db
    .prepare(
      "SELECT fuso_horario FROM ponto_vinculos WHERE user_id = ? AND vigencia_inicio <= ? AND (vigencia_fim IS NULL OR vigencia_fim >= ?) ORDER BY vigencia_inicio DESC,criado_em DESC LIMIT 1",
    )
    .bind(userId, hoje, hoje)
    .first<{ fuso_horario: string }>();
  if (vinculo) return validarFuso(vinculo.fuso_horario);
  if (atual) return atual.fuso_horario;
  if (!informado) return "America/Sao_Paulo";
  const fuso = validarFuso(informado);
  await db
    .prepare(
      "INSERT OR IGNORE INTO ponto_preferencias (user_id,fuso_horario) VALUES (?,?)",
    )
    .bind(userId, fuso)
    .run();
  return (await db
    .prepare("SELECT fuso_horario FROM ponto_preferencias WHERE user_id = ?")
    .bind(userId)
    .first<{ fuso_horario: string }>())!.fuso_horario;
}
export async function verificarMesAberto(
  db: D1Database,
  userId: string,
  data: string,
) {
  exigir(dataValida(data), "data_invalida");
  const fechado = await db
    .prepare(
      "SELECT id FROM ponto_fechamentos WHERE user_id = ? AND competencia = ? AND status = 'FECHADO_DP'",
    )
    .bind(userId, data.slice(0, 7))
    .first();
  exigir(!fechado, "competencia_fechada", 409);
}
// Recupera o turno iniciado ontem mesmo na mudança de competência.
export async function linhaAtualPonto(
  db: D1Database,
  userId: string,
  dataLocal: string,
) {
  const aberta = await db
    .prepare(
      "SELECT * FROM lancamento_ponto WHERE user_id = ? AND entrada_hora IS NOT NULL AND saida_hora IS NULL AND data_entrada BETWEEN ? AND ? ORDER BY data_entrada DESC,criado_em DESC LIMIT 1",
    )
    .bind(userId, somarDias(dataLocal, -1), dataLocal)
    .first<LinhaPonto & { id: string }>();
  return (
    aberta ||
    (await db
      .prepare(
        "SELECT * FROM lancamento_ponto WHERE user_id = ? AND data_entrada = ? ORDER BY criado_em,id LIMIT 1",
      )
      .bind(userId, dataLocal)
      .first<LinhaPonto & { id: string }>())
  );
}
export async function registrarAvisoEntrada(
  db: D1Database,
  user: Colaborador,
  fusoInformado: unknown,
  agora = new Date(),
) {
  if (!(await elegivelPonto(db, user)))
    return { exibir: false, elegivel: false, ponto_ativo: false };
  const fuso = await fusoUsuario(db, user.id, fusoInformado);
  const local = horarioNoFuso(agora, fuso);
  const aberto = await db
    .prepare(
      "SELECT id FROM lancamento_ponto WHERE user_id = ? AND entrada_hora IS NOT NULL AND saida_hora IS NULL AND data_entrada BETWEEN ? AND ? LIMIT 1",
    )
    .bind(user.id, somarDias(local.data, -1), local.data)
    .first();
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO ponto_login_diario (user_id,data_local,fuso_horario,exibido_em)
    SELECT ?1,?2,?3,?4 WHERE NOT EXISTS (SELECT 1 FROM lancamento_ponto WHERE user_id = ?1 AND data_entrada = ?2 AND entrada_hora IS NOT NULL) AND ?5 = 0`,
    )
    .bind(user.id, local.data, fuso, agora.toISOString(), aberto ? 1 : 0)
    .run();
  return {
    exibir: Number(result.meta?.changes || 0) === 1,
    elegivel: true,
    data_local: local.data,
    hora_local: local.hora,
    fuso_horario: fuso,
    horario_servidor: agora.toISOString(),
    ponto_ativo: Boolean(aberto),
  };
}
const acoes: Record<
  string,
  {
    campo: keyof LinhaPonto;
    tipo: string;
    status: string;
    anterior?: keyof LinhaPonto;
  }
> = {
  entrada: { campo: "entrada_hora", tipo: "ENTRADA", status: "working" },
  inicio_almoco: {
    campo: "inicio_almoco",
    tipo: "INICIO_INTERVALO",
    status: "lunch",
    anterior: "entrada_hora",
  },
  pausa: {
    campo: "inicio_almoco",
    tipo: "INICIO_INTERVALO",
    status: "lunch",
    anterior: "entrada_hora",
  },
  fim_almoco: {
    campo: "fim_almoco",
    tipo: "FIM_INTERVALO",
    status: "working",
    anterior: "inicio_almoco",
  },
  saida: {
    campo: "saida_hora",
    tipo: "SAIDA",
    status: "finished",
    anterior: "entrada_hora",
  },
  encerrar: {
    campo: "saida_hora",
    tipo: "SAIDA",
    status: "finished",
    anterior: "entrada_hora",
  },
};
export async function registrarMarcacao(
  db: D1Database,
  user: Colaborador,
  body: Record<string, unknown>,
  meta: { ip: string | null; userAgent: string | null },
  agora = new Date(),
) {
  exigir(
    await elegivelPonto(db, user),
    "departamento_sem_registro_de_ponto",
    403,
  );
  const alvo = acoes[String(body.acao || "")];
  exigir(alvo, "acao_invalida");
  const requisicao =
    typeof body.requisicao_id === "string" ? body.requisicao_id : uuid();
  exigir(
    requisicao.length >= 8 && requisicao.length <= 100,
    "requisicao_invalida",
  );
  const repetida = await db
    .prepare(
      "SELECT * FROM ponto_marcacoes WHERE user_id = ? AND requisicao_id = ?",
    )
    .bind(user.id, requisicao)
    .first();
  if (repetida) {
    exigir(
      (repetida as any).tipo === alvo.tipo,
      "chave_de_requisicao_reutilizada",
      409,
    );
    return { success: true, comprovante: repetida, repetida: true };
  }
  const fuso = await fusoUsuario(db, user.id, body.fuso_horario);
  const local = horarioNoFuso(agora, fuso);
  // Um turno noturno iniciado ontem é encerrado no mesmo lançamento, sem abrir outra entrada.
  const linha = await linhaAtualPonto(db, user.id, local.data);
  const data = linha?.data_entrada || local.data;
  await verificarMesAberto(db, user.id, data);
  exigir(!linha?.[alvo.campo], "marcacao_ja_registrada", 409);
  exigir(!linha?.saida_hora, "jornada_ja_encerrada", 409);
  exigir(
    !alvo.anterior || linha?.[alvo.anterior],
    "sequencia_de_marcacoes_invalida",
    409,
  );
  const geo =
    body.geolocalizacao && typeof body.geolocalizacao === "object"
      ? (body.geolocalizacao as Record<string, unknown>)
      : {};
  const geoStatus = String(geo.status || "NAO_SOLICITADA");
  exigir(
    ["INFORMADA", "NEGADA", "INDISPONIVEL", "NAO_SOLICITADA"].includes(
      geoStatus,
    ),
    "geolocalizacao_invalida",
  );
  const informada = geoStatus === "INFORMADA";
  exigir(
    !informada ||
      (typeof geo.latitude === "number" &&
        Number.isFinite(geo.latitude) &&
        Math.abs(geo.latitude) <= 90 &&
        typeof geo.longitude === "number" &&
        Number.isFinite(geo.longitude) &&
        Math.abs(geo.longitude) <= 180 &&
        typeof geo.precisao_metros === "number" &&
        geo.precisao_metros >= 0 &&
        Number.isFinite(geo.precisao_metros)),
    "coordenadas_invalidas",
  );
  const registroId = linha?.id || `ponto:${user.id}:${data}`;
  const marcacaoId = uuid();
  const statements: D1PreparedStatement[] = [];
  if (!linha)
    statements.push(
      db
        .prepare(
          "INSERT OR IGNORE INTO lancamento_ponto (id,user_id,data_entrada,status) VALUES (?,?,?,'not_started')",
        )
        .bind(registroId, user.id, data),
    );
  const condicao = `user_id = ?1 AND id = ?2 AND ${alvo.campo} IS NULL AND saida_hora IS NULL${alvo.anterior ? ` AND ${alvo.anterior} IS NOT NULL` : ""}`;
  statements.push(
    db
      .prepare(
        `INSERT OR IGNORE INTO ponto_marcacoes (id,lancamento_ponto_id,user_id,data_jornada,tipo,registrado_em,hora_local,fuso_horario,latitude,longitude,precisao_metros,geolocalizacao_status,ip,user_agent,requisicao_id)
    SELECT ?3,?2,?1,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15 FROM lancamento_ponto WHERE ${condicao}`,
      )
      .bind(
        user.id,
        registroId,
        marcacaoId,
        data,
        alvo.tipo,
        agora.toISOString(),
        local.hora,
        fuso,
        informada ? geo.latitude : null,
        informada ? geo.longitude : null,
        informada ? geo.precisao_metros : null,
        geoStatus,
        meta.ip,
        meta.userAgent,
        requisicao,
      ),
  );
  statements.push(
    db
      .prepare(
        `UPDATE lancamento_ponto SET ${alvo.campo} = ?,status = ?,atualizado_em = CURRENT_TIMESTAMP WHERE id = ? AND EXISTS (SELECT 1 FROM ponto_marcacoes WHERE id = ?)`,
      )
      .bind(local.hora, alvo.status, registroId, marcacaoId),
  );
  statements.push(
    db
      .prepare(
        "UPDATE ponto_login_diario SET resposta = 'REGISTRADO' WHERE user_id = ? AND data_local = ? AND EXISTS (SELECT 1 FROM ponto_marcacoes WHERE id = ?)",
      )
      .bind(user.id, local.data, marcacaoId),
  );
  statements.push(
    db
      .prepare(
        "UPDATE ponto_fechamentos SET status = 'EM_CONFERENCIA',fonte_hash = NULL,espelho_json = NULL WHERE user_id = ? AND competencia = ? AND status <> 'FECHADO_DP'",
      )
      .bind(user.id, data.slice(0, 7)),
  );
  await db.batch(statements);
  const gravada = await db
    .prepare(
      "SELECT * FROM ponto_marcacoes WHERE user_id = ? AND requisicao_id = ?",
    )
    .bind(user.id, requisicao)
    .first();
  exigir(gravada, "marcacao_concorrente_atualize_a_pagina", 409);
  const atualizada = await db
    .prepare("SELECT * FROM lancamento_ponto WHERE id = ?")
    .bind(registroId)
    .first<LinhaPonto>();
  const marcas = await db
    .prepare(
      "SELECT tipo,registrado_em FROM ponto_marcacoes WHERE lancamento_ponto_id = ? ORDER BY registrado_em",
    )
    .bind(registroId)
    .all<MarcacaoPonto>();
  if (atualizada?.saida_hora) {
    const calculo = calcularDiaPonto(
      data,
      atualizada,
      null,
      null,
      fuso,
      [],
      marcas.results,
    );
    await db
      .prepare("UPDATE lancamento_ponto SET horas_totais = ? WHERE id = ?")
      .bind(Math.round((calculo.trabalhados_min / 60) * 100) / 100, registroId)
      .run();
  }
  return {
    success: true,
    comprovante: gravada,
    data_entrada: data,
    campo: alvo.campo,
    hora: local.hora,
    status: alvo.status,
  };
}
export async function importarPedidosLegados(db: D1Database, usuario?: string) {
  const filtro =
    (usuario ? " WHERE user_id = ? AND " : " WHERE ") +
    "NOT EXISTS (SELECT 1 FROM ponto_solicitacoes p WHERE p.origem_tipo='CORRECAO_LEGADA' AND p.origem_id=solicitacoes_correcao_ponto.id) AND NOT EXISTS (SELECT 1 FROM ponto_fechamentos f WHERE f.user_id=solicitacoes_correcao_ponto.user_id AND f.competencia=substr(solicitacoes_correcao_ponto.data_entrada,1,7) AND f.status='FECHADO_DP')";
  const filtroAusencia =
    (usuario ? " WHERE id_usuario = ? AND " : " WHERE ") +
    "NOT EXISTS (SELECT 1 FROM ponto_solicitacoes p WHERE p.origem_tipo='AUSENCIA_LEGADA' AND p.origem_id=justificativa_ausencia.id) AND NOT EXISTS (SELECT 1 FROM ponto_fechamentos f WHERE f.user_id=justificativa_ausencia.id_usuario AND f.competencia=substr(justificativa_ausencia.data_registro,1,7) AND f.status='FECHADO_DP')";
  await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO ponto_solicitacoes (id,user_id,data_referencia,tipo,campo,horario_corrigido,justificativa,status,aprovado_por,aprovado_em,motivo_rejeicao,origem_tipo,origem_id,criado_em)
      SELECT 'legado-correcao:' || id,user_id,data_entrada,'CORRECAO',CASE tipo_correcao WHEN 'entrada' THEN 'entrada_hora' WHEN 'saida' THEN 'saida_hora' WHEN 'entrada_hora' THEN 'entrada_hora' WHEN 'inicio_almoco' THEN 'inicio_almoco' WHEN 'fim_almoco' THEN 'fim_almoco' WHEN 'saida_hora' THEN 'saida_hora' END,tempo_corrigido,justificativa,CASE lower(status) WHEN 'approved' THEN 'APROVADA' WHEN 'aprovada' THEN 'APROVADA' WHEN 'rejected' THEN 'REJEITADA' WHEN 'rejeitada' THEN 'REJEITADA' ELSE 'PENDENTE' END,aprovado_por,aprovado_em,motivo_rejeicao,'CORRECAO_LEGADA',id,criado_em FROM solicitacoes_correcao_ponto${filtro}`,
      )
      .bind(...(usuario ? [usuario] : [])),
    db
      .prepare(
        `INSERT OR IGNORE INTO ponto_solicitacoes (id,user_id,data_referencia,tipo,minutos,justificativa,status,aprovado_por,aprovado_em,motivo_rejeicao,origem_tipo,origem_id,criado_em)
      SELECT 'legado-ausencia:' || id,id_usuario,data_registro,'ATESTADO',0,justificativa,CASE lower(status) WHEN 'approved' THEN 'APROVADA' WHEN 'aprovada' THEN 'APROVADA' WHEN 'rejected' THEN 'REJEITADA' WHEN 'rejeitada' THEN 'REJEITADA' ELSE 'PENDENTE' END,aprovado_por,aprovado_em,motivo_rejeicao,'AUSENCIA_LEGADA',id,criado_em FROM justificativa_ausencia${filtroAusencia}`,
      )
      .bind(...(usuario ? [usuario] : [])),
  ]);
}
export async function espelhoPonto(
  db: D1Database,
  usuario: string,
  mes: string,
  agora = Date.now(),
) {
  const datas = datasMes(mes);
  await importarPedidosLegados(db, usuario);
  const [
    linhas,
    marcacoes,
    vinculos,
    solicitacoes,
    fechamento,
    banco,
    versoes,
    feriados,
    perfil,
  ] = await Promise.all([
    db
      .prepare(
        "SELECT * FROM lancamento_ponto WHERE user_id = ? AND data_entrada BETWEEN ? AND ? ORDER BY criado_em,id",
      )
      .bind(usuario, datas[0], datas[datas.length - 1])
      .all<LinhaPonto & { id: string }>(),
    db
      .prepare(
        "SELECT * FROM ponto_marcacoes WHERE user_id = ? AND data_jornada BETWEEN ? AND ? ORDER BY registrado_em",
      )
      .bind(usuario, datas[0], datas[datas.length - 1])
      .all<
        MarcacaoPonto & {
          id: string;
          data_jornada: string;
          fuso_horario: string;
        }
      >(),
    db
      .prepare(
        `SELECT v.*,e.ciclo_json,r.grupo_codigo,r.parametros_json,r.status AS regra_status,r.vigencia_inicio AS regra_inicio,r.vigencia_fim AS regra_fim FROM ponto_vinculos v JOIN ponto_escalas e ON e.id = v.escala_id JOIN ponto_regras r ON r.id = v.regra_id WHERE v.user_id = ? AND v.vigencia_inicio <= ? AND (v.vigencia_fim IS NULL OR v.vigencia_fim >= ?) ORDER BY v.vigencia_inicio DESC,v.criado_em DESC`,
      )
      .bind(
        usuario,
        somarDias(datas[datas.length - 1], 6),
        somarDias(datas[0]!, -6),
      )
      .all<any>(),
    db
      .prepare(
        "SELECT * FROM ponto_solicitacoes WHERE user_id = ? AND data_referencia BETWEEN ? AND ? ORDER BY criado_em,id",
      )
      .bind(usuario, datas[0], datas[datas.length - 1])
      .all<any>(),
    db
      .prepare(
        "SELECT * FROM ponto_fechamentos WHERE user_id = ? AND competencia = ?",
      )
      .bind(usuario, mes)
      .first<any>(),
    db
      .prepare(
        "SELECT * FROM ponto_banco_movimentos WHERE user_id = ? ORDER BY criado_em,id",
      )
      .bind(usuario)
      .all<any>(),
    db
      .prepare(
        "SELECT r.* FROM ponto_regras r WHERE r.status IN ('VALIDADA','REFERENCIA_INTERNA') AND EXISTS (SELECT 1 FROM ponto_vinculos v JOIN ponto_regras original ON original.id=v.regra_id WHERE v.user_id=? AND original.grupo_codigo=r.grupo_codigo) ORDER BY r.vigencia_inicio DESC,r.criado_em DESC",
      )
      .bind(usuario)
      .all<any>(),
    db
      .prepare(
        "SELECT * FROM ponto_feriados WHERE data BETWEEN ? AND ? OR recorrente_anual=1",
      )
      .bind(datas[0], datas[datas.length - 1])
      .all<any>(),
    db
      .prepare("SELECT uf,cidade FROM user_profiles WHERE id=?")
      .bind(usuario)
      .first<{ uf: string | null; cidade: string | null }>(),
  ]);
  if (fechamento?.status === "FECHADO_DP" && fechamento.espelho_json)
    return {
      ...JSON.parse(fechamento.espelho_json),
      fechamento,
      congelado: true,
    };
  const padrao = await fusoUsuario(db, usuario);
  const dias = datas.map((data) => {
    const vinculo = vinculos.results.find(
      (v) =>
        v.vigencia_inicio <= data &&
        (!v.vigencia_fim || v.vigencia_fim >= data),
    );
    const linhaOriginal =
      linhas.results.find((l) => l.data_entrada === data) || null;
    const linha: LinhaPonto | null = linhaOriginal
      ? { ...linhaOriginal }
      : null;
    const pedidos = solicitacoes.results.filter(
      (s) => s.data_referencia === data,
    );
    const correcoes = pedidos.filter(
      (s) => s.tipo === "CORRECAO" && s.status === "APROVADA",
    );
    const efetiva =
      linha ||
      (correcoes.length ? ({ data_entrada: data } as LinhaPonto) : null);
    for (const pedido of correcoes)
      if (
        efetiva &&
        ["entrada_hora", "inicio_almoco", "fim_almoco", "saida_hora"].includes(
          pedido.campo,
        )
      )
        (efetiva as any)[pedido.campo] = pedido.horario_corrigido;
    const fuso =
      marcacoes.results.find((m) => m.data_jornada === data)?.fuso_horario ||
      vinculo?.fuso_horario ||
      padrao;
    const candidata = vinculo
      ? versoes.results.find(
          (r) =>
            r.grupo_codigo === vinculo.grupo_codigo &&
            r.vigencia_inicio <= data,
        )
      : null;
    const versao =
      candidata && (!candidata.vigencia_fim || candidata.vigencia_fim >= data)
        ? candidata
        : null;
    let regra: RegrasPonto | null = versao
      ? JSON.parse(versao.parametros_json)
      : null;
    const abrangenciaPendente = Boolean(
      regra?.ufs_abrangencia &&
      (!perfil?.uf ||
        !regra.ufs_abrangencia.split(",").includes(perfil.uf.toUpperCase())),
    );
    if (abrangenciaPendente) regra = null;
    const calendario = feriados.results
      .filter(
        (f) =>
          (!f.uf || f.uf === perfil?.uf) &&
          (!f.municipio ||
            normalizarPonto(f.municipio) === normalizarPonto(perfil?.cidade)),
      )
      .map((f) =>
        f.recorrente_anual ? `${data.slice(0, 4)}-${f.data.slice(5)}` : f.data,
      );
    const escala = vinculo
      ? escalaDoDia(data, vinculo.data_base, JSON.parse(vinculo.ciclo_json))
      : null;
    const marcas = marcacoes.results.filter(
      (m) =>
        m.data_jornada === data &&
        !correcoes.some(
          (c) =>
            (
              ({
                ENTRADA: "entrada_hora",
                INICIO_INTERVALO: "inicio_almoco",
                FIM_INTERVALO: "fim_almoco",
                SAIDA: "saida_hora",
              }) as any
            )[m.tipo] === c.campo,
        ),
    );
    let calculo;
    try {
      calculo = calcularDiaPonto(
        data,
        efetiva,
        escala,
        regra,
        fuso,
        pedidos.filter((s) => s.status === "APROVADA"),
        marcas,
        agora,
        calendario,
      );
    } catch {
      calculo = calcularDiaPonto(
        data,
        null,
        escala,
        regra,
        fuso,
        [],
        [],
        agora,
      );
      calculo.alertas.push("HORARIOS_INCONSISTENTES");
    }
    if (abrangenciaPendente) calculo.alertas.push("ABRANGENCIA_CCT_PENDENTE");
    if (linhas.results.filter((l) => l.data_entrada === data).length > 1)
      calculo.alertas.push("REGISTROS_LEGADOS_DUPLICADOS");
    if (pedidos.some((s) => s.status === "PENDENTE"))
      calculo.alertas.push("SOLICITACAO_PENDENTE");
    if (
      calculo.deficit_min > 0 &&
      pedidos.some(
        (s) =>
          s.status === "APROVADA" &&
          ["ATESTADO", "DISPENSA"].includes(s.tipo) &&
          !s.minutos,
      )
    )
      calculo.alertas.push("ABONO_LEGADO_SEM_DURACAO");
    const hoje = horarioNoFuso(agora, fuso).data;
    if (data > hoje) calculo.alertas = [];
    return {
      ...calculo,
      linha: efetiva,
      original: linhaOriginal,
      fuso_horario: fuso,
      regra_id: versao?.id || null,
      regra_nome: versao?.nome || null,
      regra_status: versao?.status || null,
      gestor_id: vinculo?.gestor_id || null,
      marcas,
      solicitacoes: pedidos,
      saldo_banco_provisorio: true,
    };
  });
  const semanas = new Map<string, { minutos: number; limite: number }>();
  for (const dia of dias) {
    const semanaDia = new Date(`${dia.data}T12:00:00Z`).getUTCDay();
    const segunda = somarDias(dia.data, -((semanaDia + 6) % 7));
    if (!semanas.has(segunda)) {
      let minutos = 0;
      let limite = Infinity;
      for (let i = 0; i < 7; i++) {
        const data = somarDias(segunda, i);
        const v = vinculos.results.find(
          (v) =>
            v.vigencia_inicio <= data &&
            (!v.vigencia_fim || v.vigencia_fim >= data),
        );
        if (!v) continue;
        const r = versoes.results.find(
          (r) => r.grupo_codigo === v.grupo_codigo && r.vigencia_inicio <= data,
        );
        if (!r || (r.vigencia_fim && r.vigencia_fim < data)) continue;
        const parametros = JSON.parse(r.parametros_json) as RegrasPonto;
        limite = Math.min(limite, parametros.carga_semanal_limite_min);
        minutos += calcularDiaPonto(
          data,
          null,
          escalaDoDia(data, v.data_base, JSON.parse(v.ciclo_json)),
          parametros,
          v.fuso_horario,
          [],
          [],
          agora,
        ).previstos_min;
      }
      semanas.set(segunda, { minutos, limite });
    }
    const semana = semanas.get(segunda)!;
    if (semana.minutos > semana.limite)
      dia.alertas.push("CARGA_SEMANAL_EXCEDIDA");
  }
  const total = (campo: string) =>
    Math.round(
      dias.reduce((s, d) => s + Number((d as any)[campo] || 0), 0) * 100,
    ) / 100;
  const result = {
    user_id: usuario,
    competencia: mes,
    dias,
    solicitacoes: solicitacoes.results,
    totais: Object.fromEntries(
      [
        "previstos_min",
        "trabalhados_min",
        "abonados_min",
        "extras_min",
        "extras_aprovadas_min",
        "extras_pendentes_min",
        "noturnos_reduzidos_min",
        "sobreaviso_equivalente_min",
        "banco_min",
      ].map((k) => [k, total(k)]),
    ),
    banco: {
      ...apurarBancoPonto(banco.results, horarioNoFuso(agora, padrao).data),
      movimentos: banco.results,
    },
    fechamento,
    congelado: false,
  };
  return result;
}
export async function hashEspelho(
  espelho: Awaited<ReturnType<typeof espelhoPonto>>,
) {
  const fonte = {
    competencia: espelho.competencia,
    dias: espelho.dias,
    solicitacoes: espelho.solicitacoes,
  };
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(fonte)),
  );
  return Array.from(new Uint8Array(bytes), (n) =>
    n.toString(16).padStart(2, "0"),
  ).join("");
}
export function pendenciasFechamento(
  espelho: Awaited<ReturnType<typeof espelhoPonto>>,
): string[] {
  const bloqueadores = new Set([
    "REGRA_PENDENTE",
    "ESCALA_PENDENTE",
    "MARCACAO_INCOMPLETA",
    "SOLICITACAO_PENDENTE",
    "HORA_EXTRA_PENDENTE",
    "HORARIOS_INCONSISTENTES",
    "REGISTROS_LEGADOS_DUPLICADOS",
    "ABONO_LEGADO_SEM_DURACAO",
    "INTERVALO_INSUFICIENTE",
    "ABRANGENCIA_CCT_PENDENTE",
    "SOBREAVISO_A_VALIDAR",
    "CARGA_SEMANAL_EXCEDIDA",
  ]);
  return espelho.dias.flatMap((d: any) =>
    d.alertas
      .filter((a: string) => bloqueadores.has(a))
      .map((a: string) => `${d.data}: ${a}`),
  );
}
export async function prepararFechamentoMensal(
  db: D1Database,
  agora = new Date(),
) {
  // Só prepara a conferência; nunca presume a aprovação do colaborador ou do gestor.
  const local = horarioNoFuso(agora, "America/Sao_Paulo");
  if (local.data.slice(-2) !== "01") return;
  const mes = somarDias(`${local.data.slice(0, 7)}-01`, -1).slice(0, 7);
  await db
    .prepare(
      `INSERT OR IGNORE INTO ponto_fechamentos (id,user_id,competencia) SELECT 'fechamento:' || v.user_id || ':' || ?1,v.user_id,?1 FROM ponto_vinculos v WHERE v.vigencia_inicio <= ?2 AND (v.vigencia_fim IS NULL OR v.vigencia_fim >= ?3) GROUP BY v.user_id`,
    )
    .bind(mes, datasMes(mes).slice(-1)[0], `${mes}-01`)
    .run();
  const prontos = await db
    .prepare(
      "SELECT user_id FROM ponto_fechamentos WHERE competencia=? AND status='APROVADO_GESTOR'",
    )
    .bind(mes)
    .all<{ user_id: string }>();
  for (const pronto of prontos.results) {
    const regra = await db
      .prepare(
        "SELECT r.parametros_json FROM ponto_vinculos v JOIN ponto_regras original ON original.id=v.regra_id JOIN ponto_regras r ON r.grupo_codigo=original.grupo_codigo WHERE r.status IN ('VALIDADA','REFERENCIA_INTERNA') AND r.vigencia_inicio<=?1 AND v.user_id=?2 AND v.vigencia_inicio<=?1 AND (v.vigencia_fim IS NULL OR v.vigencia_fim>=?1) ORDER BY v.vigencia_inicio DESC,r.vigencia_inicio DESC LIMIT 1",
      )
      .bind(datasMes(mes).slice(-1)[0], pronto.user_id)
      .first<{ parametros_json: string }>();
    if (
      regra &&
      JSON.parse(regra.parametros_json).fechamento_automatico === true
    ) {
      try {
        await fecharCompetenciaPonto(
          db,
          pronto.user_id,
          mes,
          "SISTEMA",
          agora.getTime(),
        );
      } catch (error) {
        console.warn(
          "[ponto/fechamento]",
          pronto.user_id,
          (error as Error).message,
        );
      }
    }
  }
}
export { REGRAS_REFERENCIA, instantesLinha };
export async function fecharCompetenciaPonto(
  db: D1Database,
  usuario: string,
  mes: string,
  ator: string,
  agora = Date.now(),
) {
  const espelho = await espelhoPonto(db, usuario, mes, agora);
  if (espelho.congelado) return { success: true, repetida: true };
  const local = horarioNoFuso(agora, await fusoUsuario(db, usuario)).data.slice(
    0,
    7,
  );
  exigir(mes < local, "competencia_ainda_em_curso", 409);
  const fechamento = espelho.fechamento;
  const hash = await hashEspelho(espelho);
  exigir(
    fechamento?.status === "APROVADO_GESTOR" &&
      fechamento.fonte_hash === hash &&
      !pendenciasFechamento(espelho).length,
    "fechamento_possui_pendencias_ou_espelho_alterado",
    409,
  );
  const banco = espelho.totais.banco_min || 0;
  const regraIds = [
    ...new Set(espelho.dias.map((d: any) => d.regra_id).filter(Boolean)),
  ];
  let validade = 12;
  for (const id of regraIds) {
    const regra = await db
      .prepare("SELECT parametros_json FROM ponto_regras WHERE id=?")
      .bind(id)
      .first<{ parametros_json: string }>();
    const r = regra ? JSON.parse(regra.parametros_json) : null;
    if (r?.banco_horas) validade = Math.min(validade, r.banco_validade_meses);
  }
  const instante = new Date(agora).toISOString();
  const comandos: D1PreparedStatement[] = [
    db
      .prepare(
        "UPDATE ponto_fechamentos SET status='FECHADO_DP',fechado_por=?,fechado_em=?,espelho_json=? WHERE id=? AND status='APROVADO_GESTOR' AND fonte_hash=?",
      )
      .bind(
        ator,
        instante,
        JSON.stringify({ ...espelho, fechamento: null }),
        fechamento.id,
        hash,
      ),
  ];
  for (const dia of espelho.dias)
    for (const [tipo, minutos] of [
      ["CREDITO", dia.credito_banco_min],
      ["DEBITO", -dia.debito_banco_min],
    ] as const) {
      if (!minutos) continue;
      const [y, m] = dia.data.split("-").map(Number);
      const vencimento = new Date(Date.UTC(y!, m! + validade, 0))
        .toISOString()
        .slice(0, 10);
      comandos.push(
        db
          .prepare(
            `INSERT OR IGNORE INTO ponto_banco_movimentos (id,user_id,fechamento_id,origem_chave,data_referencia,minutos,validade_ate) SELECT ?,user_id,id,?,?,?,? FROM ponto_fechamentos WHERE id=? AND status='FECHADO_DP' AND fonte_hash=? AND fechado_em=?`,
          )
          .bind(
            `banco:${fechamento.id}:${dia.data}:${tipo}`,
            `${dia.data}:${tipo}`,
            dia.data,
            minutos,
            minutos > 0 ? vencimento : null,
            fechamento.id,
            hash,
            instante,
          ),
      );
    }
  comandos.push(
    db
      .prepare(
        `INSERT OR IGNORE INTO ponto_auditoria (id,ator_id,user_id,acao,entidade_id,dados_json) SELECT ?,?,user_id,'COMPETENCIA_FECHADA',id,? FROM ponto_fechamentos WHERE id=? AND status='FECHADO_DP' AND fechado_em=?`,
      )
      .bind(
        `fechamento:${fechamento.id}`,
        ator,
        JSON.stringify({ hash, banco_minutos: banco }),
        fechamento.id,
        instante,
      ),
  );
  const resultado = await db.batch(comandos);
  exigir(
    Number(resultado[0]?.meta.changes || 0) === 1,
    "espelho_alterado_durante_o_fechamento",
    409,
  );
  return { success: true, fonte_hash: hash, banco_minutos: banco };
}

export function apurarBancoPonto(
  movimentos: Array<{
    id: string;
    minutos: number;
    data_referencia: string;
    validade_ate: string | null;
  }>,
  hoje: string,
) {
  const creditos: Array<{ restante: number; validade: string | null }> = [];
  let devedor = 0;
  for (const m of [...movimentos].sort(
    (a, b) =>
      a.data_referencia.localeCompare(b.data_referencia) ||
      a.id.localeCompare(b.id),
  )) {
    if (m.minutos > 0) {
      const abatido = Math.min(devedor, m.minutos);
      devedor -= abatido;
      creditos.push({
        restante: m.minutos - abatido,
        validade: m.validade_ate,
      });
      continue;
    }
    let debito = -m.minutos;
    for (const c of creditos) {
      if (c.validade && c.validade < m.data_referencia) continue;
      const uso = Math.min(c.restante, debito);
      c.restante -= uso;
      debito -= uso;
      if (!debito) break;
    }
    devedor += debito;
  }
  const vencidos = creditos
    .filter((c) => c.validade && c.validade < hoje)
    .reduce((s, c) => s + c.restante, 0);
  const disponivel =
    creditos
      .filter((c) => !c.validade || c.validade >= hoje)
      .reduce((s, c) => s + c.restante, 0) - devedor;
  return {
    saldo_min: Math.round(disponivel * 100) / 100,
    vencido_a_liquidar_min: Math.round(vencidos * 100) / 100,
  };
}
