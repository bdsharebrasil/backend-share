import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import {
  departamentoBatePonto,
  horarioNoFuso,
  instanteLocal,
  escalaDoDia,
  cicloPadrao,
  calcularDiaPonto,
  REGRAS_REFERENCIA,
  validarModeloEscala,
  validarCiclo,
  validarRegras,
  datasMes,
} from "../src/lib/pontoGestao.ts";
import {
  registrarAvisoEntrada,
  registrarMarcacao,
  espelhoPonto,
  hashEspelho,
  fecharCompetenciaPonto,
  apurarBancoPonto,
  podeGerirPonto,
  permissoesPonto,
  listarCoordenadoresPonto,
  prepararFechamentoMensal,
} from "../src/lib/pontoServico.ts";
import { CCT_SINEATA_FENASCON_2025 } from "../src/lib/pontoCct.ts";
const migration = await readFile(
  new URL("../migrations/20261116_ponto_gestao.sql", import.meta.url),
  "utf8",
);
const migrationCoordenadores = await readFile(
  new URL(
    "../migrations/20261116_ponto_multiplos_coordenadores.sql",
    import.meta.url,
  ),
  "utf8",
);
function banco() {
  const sql = new DatabaseSync(":memory:");
  sql.exec(`CREATE TABLE empresa (id TEXT PRIMARY KEY); CREATE TABLE user_profiles (id TEXT PRIMARY KEY,nome_completo TEXT,nome_exibicao TEXT,departamento TEXT,status TEXT,tipo_user TEXT,uf TEXT,cidade TEXT); CREATE TABLE usuarios_funcoes (id TEXT,user_id TEXT,funcao TEXT); CREATE TABLE departamentos_email (id TEXT,nome TEXT);
 CREATE TABLE lancamento_ponto (id TEXT PRIMARY KEY,user_id TEXT NOT NULL,data_entrada TEXT NOT NULL,entrada_hora TEXT,inicio_almoco TEXT,fim_almoco TEXT,saida_hora TEXT,horas_totais REAL,status TEXT,criado_em TEXT DEFAULT CURRENT_TIMESTAMP,atualizado_em TEXT DEFAULT CURRENT_TIMESTAMP);
 CREATE TABLE solicitacoes_correcao_ponto (id TEXT PRIMARY KEY,user_id TEXT,data_entrada TEXT,lancamento_ponto_id TEXT,tipo_correcao TEXT,tempo_original TEXT,tempo_corrigido TEXT,justificativa TEXT,status TEXT DEFAULT 'pending',aprovado_por TEXT,aprovado_em TEXT,motivo_rejeicao TEXT,criado_em TEXT DEFAULT CURRENT_TIMESTAMP);
 CREATE TABLE justificativa_ausencia (id TEXT PRIMARY KEY,id_usuario TEXT,data_registro TEXT,justificativa TEXT,url_documento TEXT,status TEXT DEFAULT 'pendente',aprovado_por TEXT,aprovado_em TEXT,motivo_rejeicao TEXT,criado_em TEXT DEFAULT CURRENT_TIMESTAMP);
 CREATE TABLE lancamento_ponto_anexos (id TEXT PRIMARY KEY,lancamento_ponto_id TEXT,user_id TEXT,data_entrada TEXT,caminho_arquivo TEXT,nome_arquivo TEXT,tipo_arquivo TEXT,tipo_justificativa TEXT,observacoes TEXT,criado_em TEXT DEFAULT CURRENT_TIMESTAMP);
 INSERT INTO user_profiles VALUES ('ana','Ana',NULL,'Financeiro','ativo','colaborador','MT','Cuiabá'),('bea','Bea',NULL,'Operações','ativo','colaborador','MS','Campo Grande'),('piloto','Piloto',NULL,'Tripulante','ativo','colaborador','MT','Cuiabá'),('gestor','Gestor',NULL,'Administrativo','ativo','gestor_master','MT','Cuiabá'),('dp','DP',NULL,'Administrativo','ativo','rh','MT','Cuiabá');`);
  sql.exec(migration);
  sql.exec(migration);
  sql.exec(migrationCoordenadores);
  sql.exec(migrationCoordenadores);
  const db = {
    prepare(query) {
      const criar = (args = []) => ({
        bind: (...a) => criar(a),
        _exec: () => {
          const rows = sql.prepare(query).all(...args);
          return {
            results: rows,
            meta: {
              changes: Number(sql.prepare("SELECT changes() AS n").get().n),
            },
            success: true,
          };
        },
        all: async () => criar(args)._exec(),
        run: async () => criar(args)._exec(),
        first: async () => sql.prepare(query).get(...args) || null,
      });
      return criar();
    },
    async batch(statements) {
      sql.exec("BEGIN");
      try {
        const r = statements.map((s) => s._exec());
        sql.exec("COMMIT");
        return r;
      } catch (e) {
        sql.exec("ROLLBACK");
        throw e;
      }
    },
  };
  const user = (id) =>
    sql.prepare("SELECT * FROM user_profiles WHERE id=?").get(id);
  return { sql, db, user };
}
const esc = {
  tipo: "TRABALHO",
  entrada: "08:00",
  saida: "17:00",
  intervalo_min: 60,
};
const regra = {
  ...REGRAS_REFERENCIA,
  banco_horas: true,
  sobreaviso_validado: true,
};
const linha = (data = "2026-11-16") => ({
  data_entrada: data,
  entrada_hora: "08:00",
  inicio_almoco: "12:00",
  fim_almoco: "13:00",
  saida_hora: "17:00",
});
const hora = (t) => new Date(`2026-11-16T${t}:00-04:00`);

test("apenas os quatro departamentos de ponto são elegíveis e nomes normalizam acentuação", () => {
  for (const d of [
    "Financeiro",
    "Administrativo",
    "Operações",
    "CTM",
    "financeiro_administrativo",
  ])
    assert.equal(departamentoBatePonto(d), true);
  for (const d of [
    "Tripulante",
    "Piloto Chefe",
    "Financeiro Master",
    "Coordenador de Voo",
    "",
    null,
  ])
    assert.equal(departamentoBatePonto(d), false);
});
test("aviso é consumido no primeiro login local e não reaparece em outra sessão/dispositivo", async () => {
  const { db, user, sql } = banco();
  const t = hora("08:00");
  const [a, b] = await Promise.all([
    registrarAvisoEntrada(db, user("ana"), "America/Cuiaba", t),
    registrarAvisoEntrada(db, user("ana"), "America/Cuiaba", t),
  ]);
  assert.equal(Number(a.exibir) + Number(b.exibir), 1);
  assert.equal(
    (
      await registrarAvisoEntrada(
        db,
        user("ana"),
        "America/Cuiaba",
        hora("10:00"),
      )
    ).exibir,
    false,
  );
  assert.equal(
    (await registrarAvisoEntrada(db, user("piloto"), "America/Cuiaba", t))
      .exibir,
    false,
  );
  assert.equal(
    (
      await registrarAvisoEntrada(
        db,
        user("ana"),
        "America/Cuiaba",
        new Date("2026-11-17T04:01:00Z"),
      )
    ).exibir,
    true,
  );
  sql.close();
});
test("entrada já existente elimina o aviso e a recusa não impede marcação manual posterior", async () => {
  const { db, user, sql } = banco();
  await registrarAvisoEntrada(db, user("ana"), "America/Cuiaba", hora("08:00"));
  sql.exec("UPDATE ponto_login_diario SET resposta='ADIADO'");
  const r = await registrarMarcacao(
    db,
    user("ana"),
    {
      acao: "entrada",
      fuso_horario: "America/Cuiaba",
      requisicao_id: "manual-001",
      geolocalizacao: { status: "NEGADA" },
    },
    { ip: null, userAgent: "teste" },
    hora("08:05"),
  );
  assert.equal(r.comprovante.hora_local, "08:05");
  assert.equal(r.comprovante.latitude, null);
  assert.equal(
    (
      await registrarAvisoEntrada(
        db,
        user("ana"),
        "America/Cuiaba",
        hora("09:00"),
      )
    ).exibir,
    false,
  );
  sql.close();
});
test("horário vem do servidor, duplicidade não sobrescreve a entrada e registro é imutável", async () => {
  const { db, user, sql } = banco();
  const body = {
    acao: "entrada",
    hora: "03:00",
    data: "2000-01-01",
    fuso_horario: "America/Cuiaba",
    requisicao_id: "entrada-001",
    geolocalizacao: {
      status: "INFORMADA",
      latitude: -15.6,
      longitude: -56.1,
      precisao_metros: 25,
    },
  };
  const a = await registrarMarcacao(
    db,
    user("ana"),
    body,
    { ip: "ip-teste", userAgent: "teste" },
    hora("08:00"),
  );
  const b = await registrarMarcacao(
    db,
    user("ana"),
    body,
    { ip: null, userAgent: null },
    hora("09:00"),
  );
  assert.equal(a.comprovante.id, b.comprovante.id);
  assert.equal(a.comprovante.hora_local, "08:00");
  await assert.rejects(
    () =>
      registrarMarcacao(
        db,
        user("ana"),
        { ...body, requisicao_id: "entrada-002" },
        { ip: null, userAgent: null },
        hora("10:00"),
      ),
    /marcacao_ja_registrada/,
  );
  assert.throws(
    () => sql.prepare("UPDATE ponto_marcacoes SET hora_local='01:00'").run(),
    /imutavel/,
  );
  assert.throws(
    () => sql.prepare("DELETE FROM ponto_marcacoes").run(),
    /imutavel/,
  );
  sql.close();
});
test("duas entradas concorrentes geram uma única marcação", async () => {
  const { db, user, sql } = banco();
  const r = await Promise.allSettled(
    ["concorrente-001", "concorrente-002"].map((requisicao_id) =>
      registrarMarcacao(
        db,
        user("ana"),
        { acao: "entrada", requisicao_id, fuso_horario: "America/Cuiaba" },
        { ip: null, userAgent: null },
        hora("08:00"),
      ),
    ),
  );
  assert.equal(r.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(
    sql.prepare("SELECT count(*) AS n FROM ponto_marcacoes").get().n,
    1,
  );
  sql.close();
});
test("saída preserva intervalo incompleto para correção e não exige aprovação prévia da hora extra", async () => {
  const { db, user, sql } = banco();
  for (const [acao, t] of [
    ["entrada", "08:00"],
    ["inicio_almoco", "12:00"],
    ["saida", "19:00"],
  ])
    await registrarMarcacao(
      db,
      user("ana"),
      { acao, requisicao_id: `teste-${acao}`, fuso_horario: "America/Cuiaba" },
      { ip: null, userAgent: null },
      hora(t),
    );
  const e = await espelhoPonto(db, "ana", "2026-11", hora("20:00").getTime());
  assert.ok(
    e.dias
      .find((d) => d.data === "2026-11-16")
      .alertas.includes("MARCACAO_INCOMPLETA"),
  );
  sql.close();
});
test("calcula oito horas descontando intervalo e não credita extra sem aprovação", () => {
  const d = calcularDiaPonto(
    "2026-11-16",
    linha(),
    esc,
    regra,
    "America/Cuiaba",
  );
  assert.equal(d.trabalhados_min, 480);
  assert.equal(d.intervalo_min, 60);
  assert.equal(d.extras_min, 0);
  const extra = calcularDiaPonto(
    "2026-11-16",
    { ...linha(), saida_hora: "18:00" },
    esc,
    regra,
    "America/Cuiaba",
  );
  assert.equal(extra.extras_min, 60);
  assert.equal(extra.banco_min, 0);
  assert.ok(extra.alertas.includes("HORA_EXTRA_PENDENTE"));
});
test("CCT 2025: 40% + DSR = 50%, extra útil 100%, domingo/feriado 150%, banco ponderado", () => {
  const r = CCT_SINEATA_FENASCON_2025.parametros;
  const a = calcularDiaPonto(
    "2025-11-17",
    { ...linha("2025-11-17"), saida_hora: "18:00" },
    esc,
    r,
    "America/Campo_Grande",
    [{ tipo: "HORA_EXTRA", minutos: 60 }],
  );
  assert.equal(a.banco_min, 120);
  assert.equal(a.extras_equivalentes_min, 120);
  const domingo = calcularDiaPonto(
    "2025-11-16",
    { ...linha("2025-11-16"), saida_hora: "18:00" },
    esc,
    r,
    "America/Campo_Grande",
    [{ tipo: "HORA_EXTRA", minutos: 60 }],
  );
  assert.equal(domingo.banco_min, 150);
  const feriado = calcularDiaPonto(
    "2025-11-20",
    { ...linha("2025-11-20"), saida_hora: "18:00" },
    esc,
    r,
    "America/Campo_Grande",
    [{ tipo: "HORA_EXTRA", minutos: 60 }],
    [],
    Date.now(),
    ["2025-11-20"],
  );
  assert.equal(feriado.banco_min, 150);
  const noite = calcularDiaPonto(
    "2025-11-17",
    { data_entrada: "2025-11-17", entrada_hora: "22:00", saida_hora: "05:00" },
    null,
    r,
    "America/Campo_Grande",
  );
  assert.equal(noite.adicional_noturno_com_dsr_percentual, 50);
  assert.equal(noite.noturnos_reais_min, 420);
  assert.equal(noite.noturnos_reduzidos_min, 480);
});
test("intervalo curto remunerado não exige registro de pausa na jornada reduzida da CCT", () => {
  const r = CCT_SINEATA_FENASCON_2025.parametros;
  const curta = {
    tipo: "TRABALHO",
    entrada: "08:00",
    saida: "13:00",
    intervalo_min: 15,
  };
  const d = calcularDiaPonto(
    "2025-11-17",
    { data_entrada: "2025-11-17", entrada_hora: "08:00", saida_hora: "13:00" },
    curta,
    r,
    "America/Campo_Grande",
  );
  assert.equal(d.previstos_min, 300);
  assert.equal(d.trabalhados_min, 300);
  assert.ok(!d.alertas.includes("INTERVALO_INSUFICIENTE"));
});
test("turno noturno atravessa meia-noite e retorno após novo login não cria entrada no dia seguinte", async () => {
  const { db, user, sql } = banco();
  await registrarMarcacao(
    db,
    user("ana"),
    {
      acao: "entrada",
      requisicao_id: "noturno-001",
      fuso_horario: "America/Cuiaba",
    },
    { ip: null, userAgent: null },
    hora("22:00"),
  );
  const madrugada = new Date("2026-11-17T09:00:00Z");
  assert.equal(
    (await registrarAvisoEntrada(db, user("ana"), "America/Cuiaba", madrugada))
      .exibir,
    false,
  );
  const r = await registrarMarcacao(
    db,
    user("ana"),
    { acao: "saida", requisicao_id: "noturno-002" },
    { ip: null, userAgent: null },
    madrugada,
  );
  assert.equal(r.comprovante.data_jornada, "2026-11-16");
  assert.equal(
    sql.prepare("SELECT horas_totais FROM lancamento_ponto").get().horas_totais,
    7,
  );
  sql.close();
});
test("escala recorrente preserva fase nas viradas de mês, ano e ano bissexto", () => {
  const ciclo = cicloPadrao("12X36");
  assert.equal(escalaDoDia("2027-01-01", "2026-12-31", ciclo).tipo, "FOLGA");
  assert.equal(escalaDoDia("2027-01-02", "2026-12-31", ciclo).tipo, "TRABALHO");
  assert.equal(datasMes("2024-02").length, 29);
  assert.throws(
    () =>
      validarModeloEscala(
        "12X36",
        validarCiclo([
          {
            tipo: "TRABALHO",
            entrada: "08:00",
            saida: "18:00",
            intervalo_min: 60,
          },
          { tipo: "FOLGA" },
        ]),
      ),
    /12x36/,
  );
});
test("sobreaviso não duplica minutos trabalhados e exige regra própria validada", () => {
  const d = calcularDiaPonto(
    "2026-11-16",
    { data_entrada: "2026-11-16", entrada_hora: "20:00", saida_hora: "22:00" },
    { tipo: "SOBREAVISO", entrada: "18:00", saida: "06:00", intervalo_min: 0 },
    regra,
    "America/Cuiaba",
    [{ tipo: "HORA_EXTRA", minutos: 120 }],
  );
  assert.equal(d.sobreaviso_min, 600);
  assert.equal(d.sobreaviso_equivalente_min, 200);
  const semRegra = calcularDiaPonto(
    "2026-11-16",
    null,
    { tipo: "SOBREAVISO", entrada: "18:00", saida: "06:00", intervalo_min: 0 },
    REGRAS_REFERENCIA,
    "America/Cuiaba",
  );
  assert.equal(semRegra.sobreaviso_equivalente_min, null);
  assert.ok(semRegra.alertas.includes("SOBREAVISO_A_VALIDAR"));
});
test("abono é limitado à jornada e compensação só debita banco com autorização", () => {
  const d = calcularDiaPonto("2026-11-16", null, esc, regra, "America/Cuiaba", [
    { tipo: "ATESTADO", minutos: 1440 },
  ]);
  assert.equal(d.abonados_min, 480);
  assert.equal(d.deficit_min, 0);
  assert.equal(d.banco_min, 0);
  const falta = calcularDiaPonto(
    "2026-11-16",
    null,
    esc,
    regra,
    "America/Cuiaba",
  );
  assert.equal(falta.banco_min, 0);
  const compensacao = calcularDiaPonto(
    "2026-11-16",
    null,
    esc,
    regra,
    "America/Cuiaba",
    [{ tipo: "COMPENSACAO", minutos: 120 }],
  );
  assert.equal(compensacao.banco_min, -120);
  assert.equal(compensacao.deficit_min, 360);
});
test("banco FIFO separa saldo disponível e créditos vencidos, preservando liquidação pendente", () => {
  const m = [
    {
      id: "a",
      data_referencia: "2026-01-10",
      minutos: 120,
      validade_ate: "2026-03-31",
    },
    {
      id: "b",
      data_referencia: "2026-02-10",
      minutos: 60,
      validade_ate: "2026-04-30",
    },
    {
      id: "c",
      data_referencia: "2026-03-10",
      minutos: -90,
      validade_ate: null,
    },
  ];
  assert.deepEqual(apurarBancoPonto(m, "2026-04-01"), {
    saldo_min: 60,
    vencido_a_liquidar_min: 30,
  });
});
test("RH e gestor não autoaprovam e colaborador financeiro não ganha acesso de gestor pelo departamento", async () => {
  const { db, user, sql } = banco();
  assert.equal(await podeGerirPonto(db, user("ana"), "bea"), false);
  assert.equal(await podeGerirPonto(db, user("gestor"), "ana"), true);
  assert.equal(await podeGerirPonto(db, user("dp"), "dp"), false);
  sql.close();
});
test("fuso local é independente de UTC e valida parâmetros inválidos", () => {
  assert.equal(
    horarioNoFuso(new Date("2026-11-17T02:00:00Z"), "America/Cuiaba").data,
    "2026-11-16",
  );
  assert.equal(
    new Date(
      instanteLocal("2026-11-16", "08:00", "America/Cuiaba"),
    ).toISOString(),
    "2026-11-16T12:00:00.000Z",
  );
  assert.throws(
    () => validarRegras({ ...regra, hora_noturna_min: 0 }),
    /invalidas/,
  );
});

test("referência interna de 2026 usa os parâmetros de 2025 sem estender o documento; versão nova aplica ao grupo inteiro", async () => {
  const { db, user, sql } = banco();
  sql.exec(
    `INSERT INTO ponto_escalas (id,nome,tipo,ciclo_json) VALUES ('e','Folgas','ROTATIVA','[{"tipo":"FOLGA"}]'); INSERT INTO ponto_vinculos (id,user_id,escala_id,regra_id,gestor_id,data_base,vigencia_inicio,fuso_horario,criado_por) VALUES ('v','ana','e','referencia-interna-2026-admin','gestor','2026-01-01','2026-01-01','America/Cuiaba','dp')`,
  );
  let e = await espelhoPonto(db, "ana", "2026-11");
  assert.equal(e.dias[0].regra_id, "referencia-interna-2026-admin");
  assert.equal(e.dias[0].regra_status, "REFERENCIA_INTERNA");
  assert.ok(!e.dias[0].alertas.includes("REGRA_PENDENTE"));
  const nova = {
    ...CCT_SINEATA_FENASCON_2025.parametros,
    adicional_noturno_percentual: 45,
    ufs_abrangencia: "",
  };
  sql
    .prepare(
      "INSERT INTO ponto_regras (id,grupo_codigo,nome,vigencia_inicio,vigencia_fim,fonte_documento,parametros_json,status) VALUES ('v2','SINEATA_FENASCON_ADMIN','Nova regra','2026-07-01','2026-12-31','Documento novo',?,'VALIDADA')",
    )
    .run(JSON.stringify(nova));
  e = await espelhoPonto(db, "ana", "2026-11");
  assert.equal(e.dias[0].regra_id, "v2");
  assert.equal(e.dias[0].adicional_noturno_percentual, 45);
  e = await espelhoPonto(
    db,
    "ana",
    "2027-01",
    Date.parse("2027-02-01T12:00:00Z"),
  );
  assert.equal(e.dias[0].regra_id, null);
  assert.ok(e.dias[0].alertas.includes("REGRA_PENDENTE"));
  assert.equal(
    sql
      .prepare(
        "SELECT vigencia_fim FROM ponto_regras WHERE id='cct-sineata-fenascon-2025-admin'",
      )
      .get().vigencia_fim,
    "2025-12-31",
  );
  sql.close();
});

test("autenticação, escopo e fluxo completo de conferência, aprovação e fechamento são verificáveis no espelho", async () => {
  const { pontoGestaoRoutes } =
    await import("../src/routes/pontoGestaoRoutes.ts");
  const { db, user, sql } = banco();
  const anterior = globalThis.fetch;
  globalThis.fetch = async (_url, init) =>
    Response.json({
      id: new Headers(init.headers).get("Authorization").replace("Bearer ", ""),
    });
  const env = {
    SHARE_DB: db,
    SUPABASE_URL: "https://auth.test",
    SUPABASE_ANON_KEY: "teste",
  };
  const api = (userId, path, body) =>
    pontoGestaoRoutes.request(
      path,
      {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${userId}`,
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      env,
    );
  try {
    assert.equal(
      (await pontoGestaoRoutes.request("/contexto", {}, env)).status,
      401,
    );
    assert.equal((await api("ana", "/gestao?mes=2026-10")).status, 403);
    assert.equal(
      (await api("ana", "/espelho?mes=2026-10&user_id=bea")).status,
      403,
    );
    sql.exec(`INSERT INTO ponto_escalas (id,nome,tipo,ciclo_json) VALUES ('e','Folgas','ROTATIVA','[{"tipo":"FOLGA"}]'); INSERT INTO ponto_vinculos (id,user_id,escala_id,regra_id,gestor_id,data_base,vigencia_inicio,fuso_horario,criado_por) VALUES ('v','ana','e','referencia-interna-2026-admin','gestor','2026-01-01','2026-01-01','America/Cuiaba','dp');
  INSERT INTO lancamento_ponto (id,user_id,data_entrada,entrada_hora,inicio_almoco,fim_almoco,saida_hora,status) VALUES ('p','ana','2026-10-16','08:00','12:00','13:00','17:00','finished');
  INSERT INTO ponto_solicitacoes (id,user_id,data_referencia,tipo,minutos,justificativa,status,aprovado_por) VALUES ('s','ana','2026-10-16','HORA_EXTRA',480,'Trabalho autorizado','APROVADA','gestor')`);
    const conferir = await api("ana", "/fechamentos/2026-10/conferir", {});
    assert.equal(
      conferir.status,
      200,
      JSON.stringify(await conferir.clone().json()),
    );
    const proprio = await api("ana", "/fechamentos/2026-10/aprovar", {
      user_id: "ana",
    });
    assert.equal(proprio.status, 403);
    const aprovar = await api("gestor", "/fechamentos/2026-10/aprovar", {
      user_id: "ana",
    });
    assert.equal(
      aprovar.status,
      200,
      JSON.stringify(await aprovar.clone().json()),
    );
    assert.equal(
      (await api("gestor", "/fechamentos/2026-10/fechar", { user_id: "ana" }))
        .status,
      403,
    );
    const fechar = await api("dp", "/fechamentos/2026-10/fechar", {
      user_id: "ana",
    });
    assert.equal(
      fechar.status,
      200,
      JSON.stringify(await fechar.clone().json()),
    );
    const depois = await espelhoPonto(db, "ana", "2026-10");
    assert.equal(depois.congelado, true);
    assert.equal(depois.fechamento.status, "FECHADO_DP");
    assert.equal(
      sql.prepare("SELECT minutos FROM ponto_banco_movimentos").get().minutos,
      960,
    );
    assert.equal(
      sql.prepare("SELECT validade_ate FROM ponto_banco_movimentos").get()
        .validade_ate,
      "2026-12-31",
    );
    await api("dp", "/fechamentos/2026-10/fechar", { user_id: "ana" });
    assert.equal(
      sql.prepare("SELECT count(*) AS n FROM ponto_banco_movimentos").get().n,
      1,
    );
    const correcao = await api("ana", "/solicitacoes", {
      tipo: "CORRECAO",
      data_referencia: "2026-10-16",
      campo: "entrada_hora",
      horario_corrigido: "07:00",
      justificativa: "Tentar alterar fechado",
    });
    assert.equal(correcao.status, 409);
    assert.throws(
      () => sql.exec("UPDATE ponto_banco_movimentos SET minutos=10"),
      /imutavel/,
    );
    sql.exec(migration);
  } finally {
    globalThis.fetch = anterior;
    sql.close();
  }
});

test("correção aprovada preserva marcação original, altera o espelho e invalida conferência anterior", async () => {
  const { db, user, sql } = banco();
  for (const [acao, t] of [
    ["entrada", "08:00"],
    ["inicio_almoco", "12:00"],
    ["fim_almoco", "13:00"],
    ["saida", "17:00"],
  ])
    await registrarMarcacao(
      db,
      user("ana"),
      { acao, requisicao_id: `corr-${acao}`, fuso_horario: "America/Cuiaba" },
      { ip: null, userAgent: null },
      hora(t),
    );
  const antes = await espelhoPonto(db, "ana", "2026-11");
  const hash = await hashEspelho(antes);
  sql
    .prepare(
      "INSERT INTO ponto_fechamentos (id,user_id,competencia,status,fonte_hash) VALUES ('f','ana','2026-11','CONFERIDO',?)",
    )
    .run(hash);
  sql.exec(
    "INSERT INTO ponto_solicitacoes (id,user_id,data_referencia,tipo,campo,horario_corrigido,justificativa,status,aprovado_por) VALUES ('c','ana','2026-11-16','CORRECAO','entrada_hora','07:45','Relógio a conferir','APROVADA','gestor')",
  );
  const depois = await espelhoPonto(db, "ana", "2026-11");
  const dia = depois.dias.find((d) => d.data === "2026-11-16");
  assert.equal(dia.original.entrada_hora, "08:00");
  assert.equal(dia.linha.entrada_hora, "07:45");
  assert.equal(
    sql
      .prepare("SELECT hora_local FROM ponto_marcacoes WHERE tipo='ENTRADA'")
      .get().hora_local,
    "08:00",
  );
  assert.notEqual(await hashEspelho(depois), hash);
  assert.equal(depois.fechamento.status, "EM_CONFERENCIA");
  sql.close();
});

test("aprovação legada altera apenas o campo solicitado e alerta sequência inconsistente sem bloquear", async () => {
  const { pontoGestaoRoutes } = await import("../src/routes/pontoGestaoRoutes.ts");
  const { db, sql } = banco();
  const anterior = globalThis.fetch;
  globalThis.fetch = async (_url, init) =>
    Response.json({
      id: new Headers(init.headers).get("Authorization").replace("Bearer ", ""),
    });
  const env = {
    SHARE_DB: db,
    SUPABASE_URL: "https://auth.test",
    SUPABASE_ANON_KEY: "teste",
  };
  const api = (userId, path, body) =>
    pontoGestaoRoutes.request(
      path,
      {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${userId}`,
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      env,
    );
  try {
    sql.exec(`
      INSERT INTO ponto_escalas (id,nome,tipo,ciclo_json) VALUES ('el','Escala legado','ROTATIVA','[{"tipo":"TRABALHO","entrada":"08:00","saida":"17:00","intervalo_min":60}]');
      INSERT INTO ponto_vinculos (id,user_id,escala_id,regra_id,gestor_id,data_base,vigencia_inicio,fuso_horario,criado_por) VALUES ('vl','ana','el','referencia-interna-2026-admin','gestor','2026-01-01','2026-01-01','America/Cuiaba','dp');
      INSERT INTO lancamento_ponto (id,user_id,data_entrada,entrada_hora,inicio_almoco,fim_almoco,saida_hora,status) VALUES ('pl','ana','2026-08-03','13:15','99:00','13:30','17:30','finished');
      INSERT INTO solicitacoes_correcao_ponto (id,user_id,data_entrada,tipo_correcao,tempo_original,tempo_corrigido,justificativa,status) VALUES ('leg-test','ana','2026-08-03','entrada_hora','13:15','12:30','Esqueci de bater a entrada','pending');
    `);
    await espelhoPonto(db, "ana", "2026-08");
    // A rota precisa ser chamada com o identificador legado no caminho.
    const r = await api("gestor", "/solicitacoes/legado-correcao:leg-test/decisao", {
      status: "APROVADA",
      motivo: "",
      minutos: 0,
    });
    assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
    assert.deepEqual((await r.json()).avisos, ["HORARIOS_INCONSISTENTES"]);
    assert.equal(sql.prepare("SELECT status FROM ponto_solicitacoes WHERE id='legado-correcao:leg-test'").get().status, "APROVADA");
    assert.equal(sql.prepare("SELECT status FROM solicitacoes_correcao_ponto WHERE id='leg-test'").get().status, "approved");
    const e = await espelhoPonto(db, "ana", "2026-08");
    const dia = e.dias.find((d) => d.data === "2026-08-03");
    assert.equal(dia.linha.entrada_hora, "12:30");
    assert.ok(dia.alertas.includes("HORARIOS_INCONSISTENTES"));
  } finally {
    globalThis.fetch = anterior;
    sql.close();
  }
});

test("dia 1 prepara a competência sem forjar aprovação e fecha somente espelho já conferido e aprovado", async () => {
  const { db, sql } = banco();
  sql.exec(
    `INSERT INTO ponto_escalas (id,nome,tipo,ciclo_json) VALUES ('e','Folgas','ROTATIVA','[{"tipo":"FOLGA"}]'); INSERT INTO ponto_vinculos (id,user_id,escala_id,regra_id,gestor_id,data_base,vigencia_inicio,fuso_horario,criado_por) VALUES ('v','ana','e','referencia-interna-2026-admin','gestor','2026-01-01','2026-01-01','America/Cuiaba','dp')`,
  );
  const agora = new Date("2026-11-01T12:00:00Z");
  await prepararFechamentoMensal(db, agora);
  assert.equal(
    sql.prepare("SELECT status FROM ponto_fechamentos").get().status,
    "EM_CONFERENCIA",
  );
  const espelho = await espelhoPonto(db, "ana", "2026-10", agora.getTime());
  const hash = await hashEspelho(espelho);
  sql
    .prepare(
      "UPDATE ponto_fechamentos SET status='APROVADO_GESTOR',fonte_hash=?,conferido_em=?,aprovado_por='gestor',aprovado_em=?",
    )
    .run(hash, agora.toISOString(), agora.toISOString());
  await prepararFechamentoMensal(db, agora);
  assert.equal(
    sql.prepare("SELECT status FROM ponto_fechamentos").get().status,
    "FECHADO_DP",
  );
  assert.equal(
    sql.prepare("SELECT fechado_por FROM ponto_fechamentos").get().fechado_por,
    "SISTEMA",
  );
  await prepararFechamentoMensal(db, agora);
  assert.equal(
    sql
      .prepare(
        "SELECT count(*) AS n FROM ponto_auditoria WHERE acao='COMPETENCIA_FECHADA'",
      )
      .get().n,
    1,
  );
  sql.close();
});

test("gestor vinculado não acessa marcações ou atestados posteriores à transferência da equipe", async () => {
  const { pontoGestaoRoutes } =
    await import("../src/routes/pontoGestaoRoutes.ts");
  const { db, sql, user } = banco();
  const anterior = globalThis.fetch;
  sql.exec(
    `INSERT INTO user_profiles VALUES ('gerente','Gerente',NULL,'Administrativo','ativo','colaborador','MT','Cuiabá'); INSERT INTO ponto_escalas (id,nome,tipo,ciclo_json) VALUES ('e','Folga','ROTATIVA','[{"tipo":"FOLGA"}]');INSERT INTO ponto_vinculos (id,user_id,escala_id,regra_id,gestor_id,data_base,vigencia_inicio,vigencia_fim,fuso_horario,criado_por) VALUES ('v','ana','e','referencia-interna-2026-admin','gerente','2026-01-01','2026-01-01','2026-10-31','America/Cuiaba','dp')`,
  );
  assert.equal(
    await podeGerirPonto(db, user("gerente"), "ana", false, "2026-10-16"),
    true,
  );
  assert.equal(
    await podeGerirPonto(db, user("gerente"), "ana", false, "2026-11-16"),
    false,
  );
  globalThis.fetch = async (_url, init) =>
    Response.json({
      id: new Headers(init.headers).get("Authorization").replace("Bearer ", ""),
    });
  const env = {
    SHARE_DB: db,
    SUPABASE_URL: "https://auth.test",
    SUPABASE_ANON_KEY: "teste",
  };
  try {
    const r = await pontoGestaoRoutes.request(
      "/gestao?mes=2026-11",
      { headers: { Authorization: "Bearer gerente" } },
      env,
    );
    assert.equal(r.status, 200);
    assert.equal((await r.json()).equipe.length, 0);
    const privado = await pontoGestaoRoutes.request(
      "/espelho?mes=2026-11&user_id=ana",
      { headers: { Authorization: "Bearer gerente" } },
      env,
    );
    assert.equal(privado.status, 403);
  } finally {
    globalThis.fetch = anterior;
    sql.close();
  }
});

test("turno aberto na virada do mês permanece disponível para o colaborador, mas sem vínculo não aparece na gestão", async (t) => {
  t.mock.timers.enable({
    apis: ["Date"],
    now: new Date("2026-11-01T06:00:00Z"),
  });
  const { pontoGestaoRoutes } =
    await import("../src/routes/pontoGestaoRoutes.ts");
  const { db, sql, user } = banco();
  const anterior = globalThis.fetch;
  await registrarMarcacao(
    db,
    user("ana"),
    {
      acao: "entrada",
      requisicao_id: "virada-entrada",
      fuso_horario: "America/Cuiaba",
    },
    { ip: null, userAgent: null },
    new Date("2026-10-31T22:00:00-04:00"),
  );
  globalThis.fetch = async (_url, init) =>
    Response.json({
      id: new Headers(init.headers).get("Authorization").replace("Bearer ", ""),
    });
  const env = {
    SHARE_DB: db,
    SUPABASE_URL: "https://auth.test",
    SUPABASE_ANON_KEY: "teste",
  };
  try {
    const contexto = await pontoGestaoRoutes.request(
      "/contexto?fuso=America%2FCuiaba",
      { headers: { Authorization: "Bearer ana" } },
      env,
    );
    assert.equal(contexto.status, 200);
    const c = await contexto.json();
    assert.equal(c.hoje, "2026-11-01");
    assert.equal(c.linha_atual.data_entrada, "2026-10-31");
    assert.equal(c.linha_atual.entrada_hora, "22:00");
    const gestao = await pontoGestaoRoutes.request(
      "/gestao?mes=2026-11",
      { headers: { Authorization: "Bearer gestor" } },
      env,
    );
    assert.equal(gestao.status, 200);
    const equipe = (await gestao.json()).equipe;
    assert.equal(equipe.find((u) => u.id === "ana"), undefined);
    await registrarMarcacao(
      db,
      user("ana"),
      {
        acao: "saida",
        requisicao_id: "virada-saida",
        fuso_horario: "America/Cuiaba",
      },
      { ip: null, userAgent: null },
      new Date("2026-11-01T06:00:00-04:00"),
    );
    assert.equal(
      sql.prepare("SELECT count(*) AS n FROM lancamento_ponto").get().n,
      1,
    );
    assert.equal(
      sql.prepare("SELECT saida_hora FROM lancamento_ponto").get().saida_hora,
      "06:00",
    );
  } finally {
    globalThis.fetch = anterior;
    sql.close();
  }
});

async function apiCoordenacao(fn) {
  const { pontoGestaoRoutes } =
    await import("../src/routes/pontoGestaoRoutes.ts");
  const { db, sql, user } = banco();
  const anterior = globalThis.fetch;
  globalThis.fetch = async (_url, init) =>
    Response.json({
      id: new Headers(init.headers).get("Authorization").replace("Bearer ", ""),
    });
  const env = {
    SHARE_DB: db,
    SUPABASE_URL: "https://auth.test",
    SUPABASE_ANON_KEY: "teste",
  };
  const api = (userId, path, body) =>
    pontoGestaoRoutes.request(
      path,
      {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${userId}`,
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      env,
    );
  try {
    await fn({ db, sql, user, api });
  } finally {
    globalThis.fetch = anterior;
    sql.close();
  }
}
function prepararCoordenacao(sql) {
  sql.exec(`INSERT INTO user_profiles VALUES
    ('admin-ponto','Admin',NULL,'Administrativo','ativo','colaborador','MT','Cuiabá'),
    ('contabil','Contabilidade',NULL,'dep-contabil','ativo','colaborador','MT','Cuiabá'),
    ('inativo-ponto','Admin inativo',NULL,'Administrativo','inativo','admin','MT','Cuiabá');
    INSERT INTO departamentos_email VALUES ('dep-contabil','Contabilidade');
    INSERT INTO usuarios_funcoes VALUES ('func-admin','admin-ponto','ADMIN');`);
}
const dadosVinculo = (escala) => ({
  user_id: "ana",
  escala_id: escala,
  regra_id: "referencia-interna-2026-admin",
  gestores_ids: ["gestor", "admin-ponto", "contabil"],
  data_base: "2026-11-01",
  vigencia_inicio: "2026-11-01",
  comunicada_em: "2026-09-01",
  fuso_horario: "America/Cuiaba",
});

test("configuração sem escalas oferece modelos e criar escala retorna opção real para o vínculo", async () => {
  await apiCoordenacao(async ({ api }) => {
    let r = await api("dp", "/configuracao");
    assert.equal(r.status, 200);
    let config = await r.json();
    assert.equal(config.escalas.length, 0);
    assert.deepEqual(
      Object.keys(config.modelos).sort(),
      ["12X36", "5X2", "6X1", "ROTATIVA", "SOBREAVISO"].sort(),
    );
    r = await api("dp", "/escalas", {
      nome: "Administrativo 5 × 2",
      tipo: "5X2",
      ciclo: config.modelos["5X2"],
    });
    assert.equal(r.status, 201);
    const id = (await r.json()).id;
    config = await (await api("dp", "/configuracao")).json();
    assert.equal(config.escalas.length, 1);
    assert.equal(config.escalas[0].id, id);
    assert.equal(config.escalas[0].tipo, "5X2");
  });
});

test("vínculo aceita Gestor Master, Admin por função e Contabilidade por departamento juntos; contabilidade fica restrita à equipe", async () => {
  await apiCoordenacao(async ({ api, db, sql, user }) => {
    prepararCoordenacao(sql);
    sql.exec("PRAGMA foreign_keys=ON");
    assert.equal((await api("contabil", "/gestao?mes=2026-11")).status, 403);
    const config = await (await api("dp", "/configuracao")).json();
    assert.deepEqual(config.gestores.find((g) => g.id === "contabil").perfis, [
      "Contabilidade",
    ]);
    assert.deepEqual(
      config.gestores.find((g) => g.id === "admin-ponto").perfis,
      ["Admin"],
    );
    assert.deepEqual(config.gestores.find((g) => g.id === "gestor").perfis, [
      "Gestor Master",
    ]);
    assert(
      !config.gestores.some((g) => ["inativo-ponto", "ana"].includes(g.id)),
    );
    const escala = await api("dp", "/escalas", {
      nome: "Escala teste",
      tipo: "5X2",
      ciclo: config.modelos["5X2"],
    });
    const body = dadosVinculo((await escala.json()).id);
    const r = await api("dp", "/vinculos", {
      ...body,
      gestores_ids: [...body.gestores_ids, "contabil"],
    });
    assert.equal(r.status, 201, JSON.stringify(await r.clone().json()));
    const id = (await r.json()).id;
    assert.equal(
      sql
        .prepare(
          "SELECT count(*) AS n FROM ponto_vinculos_gestores WHERE vinculo_id=?",
        )
        .get(id).n,
      3,
    );
    const c = await (await api("dp", "/configuracao")).json();
    assert.deepEqual(
      new Set(c.vinculos.find((v) => v.id === id).gestores_ids),
      new Set(body.gestores_ids),
    );
    assert.deepEqual(await permissoesPonto(db, user("contabil")), {
      dp: false,
      gestor: true,
      geral: false,
    });
    const equipe = await (await api("contabil", "/gestao?mes=2026-11")).json();
    assert.deepEqual(
      equipe.equipe.map((u) => u.id),
      ["ana"],
    );
    assert.equal(
      (await api("contabil", "/espelho?mes=2026-11&user_id=ana")).status,
      200,
    );
    assert.equal(
      (await api("contabil", "/espelho?mes=2026-11&user_id=bea")).status,
      403,
    );
    assert.equal((await api("contabil", "/vinculos", body)).status, 403);
    assert.equal(
      await podeGerirPonto(
        db,
        user("contabil"),
        "contabil",
        false,
        "2026-11-16",
      ),
      false,
    );
    sql.exec(
      `INSERT INTO ponto_solicitacoes (id,user_id,data_referencia,tipo,minutos,justificativa) VALUES ('pedido-equipe','ana','2026-11-16','DISPENSA',60,'Ausência justificada'),('pedido-fora','bea','2026-11-16','DISPENSA',60,'Ausência justificada'),('pedido-proprio','contabil','2026-11-16','DISPENSA',60,'Ausência justificada')`,
    );
    assert.equal(
      (
        await api("contabil", "/solicitacoes/pedido-equipe/decisao", {
          status: "APROVADA",
          minutos: 60,
        })
      ).status,
      200,
    );
    assert.equal(
      sql
        .prepare(
          "SELECT aprovado_por FROM ponto_solicitacoes WHERE id='pedido-equipe'",
        )
        .get().aprovado_por,
      "contabil",
    );
    for (const id of ["pedido-fora", "pedido-proprio"])
      assert.equal(
        (
          await api("contabil", `/solicitacoes/${id}/decisao`, {
            status: "APROVADA",
            minutos: 60,
          })
        ).status,
        403,
      );
    const auditoria = sql
      .prepare(
        "SELECT dados_json FROM ponto_auditoria WHERE acao='VINCULO_DEFINIDO' AND entidade_id=?",
      )
      .get(id);
    assert.deepEqual(
      JSON.parse(auditoria.dados_json).gestores_ids,
      body.gestores_ids,
    );
    sql
      .prepare("UPDATE ponto_vinculos SET vigencia_fim='2026-11-30' WHERE id=?")
      .run(id);
    assert.equal(
      await podeGerirPonto(db, user("contabil"), "ana", false, "2026-11-30"),
      true,
    );
    assert.equal(
      await podeGerirPonto(db, user("contabil"), "ana", false, "2026-12-01"),
      false,
    );
    assert.equal(
      (await api("contabil", "/espelho?mes=2026-12&user_id=ana")).status,
      403,
    );
    const posterior = await (
      await api("contabil", "/gestao?mes=2026-12")
    ).json();
    assert.equal(posterior.equipe.length, 0);
  });
});

test("coordenadores precisam ser ativos e elegíveis, sem autocoordenação, com gravação atômica", async () => {
  await apiCoordenacao(async ({ api, sql }) => {
    prepararCoordenacao(sql);
    const config = await (await api("dp", "/configuracao")).json();
    const escala = await api("dp", "/escalas", {
      nome: "Escala teste",
      tipo: "5X2",
      ciclo: config.modelos["5X2"],
    });
    const body = dadosVinculo((await escala.json()).id);
    for (const gestores_ids of [
      [],
      ["ana"],
      ["inativo-ponto"],
      ["nao-existe"],
      ["bea"],
      ["gestor", "contabil", "inativo-ponto"],
      "contabil",
      [null],
    ]) {
      const r = await api("dp", "/vinculos", { ...body, gestores_ids });
      assert.equal(
        r.status,
        400,
        JSON.stringify({ gestores_ids, response: await r.clone().json() }),
      );
      assert.equal(
        sql.prepare("SELECT count(*) AS n FROM ponto_vinculos").get().n,
        0,
      );
      assert.equal(
        sql.prepare("SELECT count(*) AS n FROM ponto_vinculos_gestores").get()
          .n,
        0,
      );
    }
  });
});

test("migração de coordenadores é idempotente e preserva o gestor legado; cliente antigo pode enviar um gestor", async () => {
  await apiCoordenacao(async ({ api, sql, db, user }) => {
    const config = await (await api("dp", "/configuracao")).json();
    const escala = await api("dp", "/escalas", {
      nome: "Escala teste",
      tipo: "5X2",
      ciclo: config.modelos["5X2"],
    });
    const body = dadosVinculo((await escala.json()).id);
    delete body.gestores_ids;
    body.gestor_id = "gestor";
    const r = await api("dp", "/vinculos", body);
    assert.equal(r.status, 201);
    const id = (await r.json()).id;
    sql
      .prepare("DELETE FROM ponto_vinculos_gestores WHERE vinculo_id=?")
      .run(id);
    sql.exec(migrationCoordenadores);
    sql.exec(migrationCoordenadores);
    assert.equal(
      sql.prepare("SELECT count(*) AS n FROM ponto_vinculos_gestores").get().n,
      1,
    );
    assert.equal(
      await podeGerirPonto(db, user("gestor"), "ana", false, "2026-11-16"),
      true,
    );
    assert((await listarCoordenadoresPonto(db)).some((g) => g.id === "gestor"));
  });
});
