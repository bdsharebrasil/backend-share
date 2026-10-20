import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { calcularVencimentoReembolsoTripulante, findLancamentoClientId } from "../src/relatorioFinanceiro.ts";

const worker = await readFile(new URL("../src/worker.ts", import.meta.url), "utf8");
const financeiro = await readFile(new URL("../src/relatorioFinanceiro.ts", import.meta.url), "utf8");
const moduloContaReceber = await readFile(new URL("../src/financeiro/relatorioContaReceber.ts", import.meta.url), "utf8");
const migrationContaReceber = await readFile(new URL("../migrations/20261015_relatorio_conta_receber_unicidade.sql", import.meta.url), "utf8");
const migrationCustoIntegral = await readFile(new URL("../migrations/20261015_relatorio_viagem_custo_integral.sql", import.meta.url), "utf8");
const frontendRelatorio = await readFile(new URL("../../Share-Brasil-Financeiro/src/pages/RelatorioDespesaViagem.tsx", import.meta.url), "utf8");
const migrationHistorico = await readFile(new URL("../migrations/20261013_relatorio_despesa_viagem_historico_ajustes.sql", import.meta.url), "utf8");
const inicioEnvioCliente = worker.indexOf("app.post('/api/financeiro/relatorios-despesa-viagem/:id/enviar-cliente'");
const fimEnvioCliente = worker.indexOf("app.post('/api/public/relatorios-despesa-viagem/aprovacao/:token'", inicioEnvioCliente);
const rotaEnvioCliente = worker.slice(inicioEnvioCliente, fimEnvioCliente);
const inicioPatch = worker.indexOf("app.patch('/api/financeiro/relatorios-despesa-viagem/:id'");
const fimPatch = worker.indexOf("app.post('/api/financeiro/relatorios-despesa-viagem/:id/finalizar'");
const rotaAtualizacao = worker.slice(inicioPatch, fimPatch);
const inicioMinhas = worker.indexOf("app.get('/api/financeiro/relatorios-despesa-viagem/minhas'");
const fimMinhas = worker.indexOf("app.get('/api/financeiro/relatorios-despesa-viagem',", inicioMinhas);
const rotaMinhas = worker.slice(inicioMinhas, fimMinhas);
const inicioAprovacaoAutenticada = worker.indexOf("app.post('/api/financeiro/relatorios-despesa-viagem/:id/aprovacao'");
const fimAprovacaoAutenticada = worker.indexOf("app.get('/api/financeiro/relatorios-despesa-viagem/:id/programacao-reembolso'", inicioAprovacaoAutenticada);
const rotaAprovacaoAutenticada = worker.slice(inicioAprovacaoAutenticada, fimAprovacaoAutenticada);

test("criação de relatório exige trecho e tripulante", () => {
  const inicioCriacao = worker.indexOf("app.post('/api/financeiro/relatorios-despesa-viagem'");
  const fimCriacao = worker.indexOf("app.patch('/api/financeiro/relatorios-despesa-viagem/:id'");
  const rotaCriacao = worker.slice(inicioCriacao, fimCriacao);

  assert.match(rotaCriacao, /if \(!rota\) return c\.json\(\{ error: 'trecho_obrigatorio' \}, 400\)/);
  assert.match(rotaCriacao, /if \(!tripulacaoId && !nomeTripulante\) return c\.json\(\{ error: 'tripulante_obrigatorio' \}, 400\)/);
});

test("atualização rejeita campos obrigatórios vazios e preserva valores não enviados", () => {
  assert.match(rotaAtualizacao, /let rota = body\.rota === undefined \? String\(atual\.rota \|\| ''\)\.trim\(\)/);
  assert.match(rotaAtualizacao, /if \(!rota\) return c\.json\(\{ error: 'trecho_obrigatorio' \}, 400\)/);
  assert.match(rotaAtualizacao, /if \(!tripulacaoId && !nomeTripulante\) return c\.json\(\{ error: 'tripulante_obrigatorio' \}, 400\)/);
  assert.match(rotaAtualizacao, /rota = \?7/);
  assert.match(rotaAtualizacao, /tripulacaoId \|\| null, nomeTripulante \|\| null/);
});

test("rota do voo é calculada no servidor e as opções incluem pernas e rota legível", () => {
  const inicioOpcoes = worker.indexOf("app.get('/api/financeiro/relatorios-despesa-viagem/opcoes'");
  const fimOpcoes = worker.indexOf("app.get('/api/financeiro/relatorios-despesa-viagem/minhas'", inicioOpcoes);
  const rotaOpcoes = worker.slice(inicioOpcoes, fimOpcoes);
  const inicioCriacao = worker.indexOf("app.post('/api/financeiro/relatorios-despesa-viagem'");
  const fimCriacao = worker.indexOf("app.patch('/api/financeiro/relatorios-despesa-viagem/:id'", inicioCriacao);
  const rotaCriacao = worker.slice(inicioCriacao, fimCriacao);

  assert.match(worker, /sequenciaRotaRelatorio\(/);
  assert.match(rotaOpcoes, /FROM pernas_jornada_voo p[\s\S]*j\.jornada_principal_id IS NULL/);
  assert.match(rotaOpcoes, /rota_nome: nomearRotaRelatorio/);
  assert.match(rotaCriacao, /const rotaCalculada = await montarRotaRelatorioViagem/);
  assert.match(rotaCriacao, /rota = rotaCalculada\.rota_nome/);
  assert.match(rotaAtualizacao, /if \(numeroVoo !== numeroVooAnterior\)[\s\S]*montarRotaRelatorioViagem/);
});

test("finalização de relatório rejeitado conclui o ajuste e reabre a aprovação", () => {
  const inicioFinalizacao = worker.indexOf("app.post('/api/financeiro/relatorios-despesa-viagem/:id/finalizar'");
  const fimFinalizacao = worker.indexOf("app.post('/api/financeiro/relatorios-despesa-viagem/:id/voltar-rascunho'", inicioFinalizacao);
  const rotaFinalizacao = worker.slice(inicioFinalizacao, fimFinalizacao);
  const inicioEnvio = worker.indexOf("app.post('/api/financeiro/relatorios-despesa-viagem/:id/enviar-aprovacao'");
  const fimEnvio = worker.indexOf("app.get('/api/public/relatorios-despesa-viagem/aprovacao/:token'", inicioEnvio);
  const rotaEnvio = worker.slice(inicioEnvio, fimEnvio);

  assert.match(worker, /'ajuste_concluido'/);
  assert.match(rotaFinalizacao, /statusAtual === 'ajuste_necessario' \? 'ajuste_concluido' : 'finalizado'/);
  assert.match(rotaFinalizacao, /status_aprovacao_tripulante = CASE WHEN \?1 = 'ajuste_concluido' THEN 'pendente'/);
  assert.match(rotaFinalizacao, /lower\(COALESCE\(status, 'rascunho'\)\) = \?3/);
  assert.match(rotaEnvio, /status IN \('finalizado', 'ajuste_concluido'\)/);
  assert.match(rotaEnvio, /status = CASE WHEN status IN \('finalizado', 'ajuste_concluido'\) THEN 'aguardando_aprovacao'/);
});

test("aprovação já gravada pode repetir a sincronização financeira sem duplicar decisão", () => {
  const inicioPublica = worker.indexOf("app.post('/api/public/relatorios-despesa-viagem/aprovacao/:token'");
  const fimPublica = worker.indexOf("app.delete('/api/financeiro/relatorios-despesa-viagem/:id'", inicioPublica);
  const rotaPublica = worker.slice(inicioPublica, fimPublica);

  assert.match(rotaPublica, /retryApprovedSync = body\.aprovado === true && currentApprovalStatus === 'aprovado' && reportStatus === 'aprovado'/);
  assert.match(rotaPublica, /if \(!retryApprovedSync\) \{\s*const updateStatement = c\.env\.SHARE_DB\.prepare\(`UPDATE relatorio_despesa_viagem/);
  assert.match(rotaPublica, /if \(!retryApprovedSync\) \{\s*try \{\s*await notifyReportDecision/);
  assert.match(rotaPublica, /await sincronizarRelatorioViagemFinanceiro\(c\.env\.SHARE_DB, \{ \.\.\.updated, data_vencimento_reembolso: dataVencimentoReembolso \}/);
});

test("ajuste concluído pode ser aprovado novamente pela rota autenticada e pelo link público", () => {
  assert.match(rotaAprovacaoAutenticada, /pendingAdjustment = reportStatus === 'ajuste_concluido' && approvalStatus === 'pendente'/);
  assert.match(rotaAprovacaoAutenticada, /reportStatus === 'aguardando_aprovacao' \|\| pendingAdjustment/);

  const inicioPublica = worker.indexOf("app.post('/api/public/relatorios-despesa-viagem/aprovacao/:token'");
  const fimPublica = worker.indexOf("app.delete('/api/financeiro/relatorios-despesa-viagem/:id'", inicioPublica);
  const rotaPublica = worker.slice(inicioPublica, fimPublica);
  assert.match(rotaPublica, /pendingAdjustment = reportStatus === 'ajuste_concluido' && currentApprovalStatus === 'pendente'/);
  assert.match(rotaPublica, /reportStatus === 'aguardando_aprovacao' \|\| pendingAdjustment/);
});

test("rejeições são guardadas no histórico e a migração cria a tabela de solicitações", () => {
  assert.match(worker, /historicoAjusteStatements\(c\.env\.SHARE_DB, report, pos/);
  assert.match(worker, /historicoAjusteStatements\(c\.env\.SHARE_DB, row, pos/);
  assert.match(rotaMinhas, /historico_ajustes: ajustesPorRelatorio\.get\(row\.id\) \|\| \[\]/);
  assert.match(migrationHistorico, /CREATE TABLE IF NOT EXISTS relatorio_despesa_viagem_historico_ajustes/);
  assert.match(migrationHistorico, /CREATE INDEX IF NOT EXISTS idx_relatorio_viagem_historico_ajustes_relatorio/);
});

test("aprovação persiste vencimento e normaliza cliente/data de emissão antes de gerar os financeiros", () => {
  assert.equal(calcularVencimentoReembolsoTripulante({ aprovado_tripulante_1_em: "2026-10-13T20:00:00.000Z" }), "2026-10-16");
  assert.match(financeiro, /async function dataEmissaoRelatorio\(db: D1Database, report: ReportRow, lancamentoId: string \| null\)/);
  assert.match(financeiro, /AND \(\?2 IS NULL OR id <> \?2\)/);
  assert.match(financeiro, /dateValue\(sibling\?\.data_emissao, dateValue\(approvalDate, new Date\(\)\.toISOString\(\)\.slice\(0, 10\)\)\)/);
  assert.match(financeiro, /const dataEmissao = await dataEmissaoRelatorio\(db, report, lancamentoId\)/);
  assert.match(financeiro, /const dataEmissao = await dataEmissaoRelatorio\(db, report, null\)/);
  assert.match(financeiro, /cliente_id = \?, data_emissao = \?, data_vencimento = \?/);
  assert.match(financeiro, /SELECT id FROM cliente WHERE id = \?1 LIMIT 1/);
  assert.match(financeiro, /cliente_id: kind === 'CLIENTE' \? clienteLancamentoId : null/);
  assert.match(worker, /persistirMetadadosFinanceirosRelatorio\(c\.env\.SHARE_DB, id, userId, null, false, dataVencimentoReembolso\)/);
  assert.match(financeiro, /addTripulantePayableStatements\(/);
});

test("lookup de cliente consulta a tabela singular existente no D1", async () => {
  const consultas = [];
  let parametros = [];
  const db = {
    prepare(sql) {
      consultas.push(sql);
      return {
        bind(...values) {
          parametros = values;
          return { first: async () => ({ id: "cliente-1" }) };
        },
      };
    },
  };

  assert.equal(await findLancamentoClientId(db, " cliente-1 "), "cliente-1");
  assert.deepEqual(consultas, ["SELECT id FROM cliente WHERE id = ?1 LIMIT 1"]);
  assert.deepEqual(parametros, ["cliente-1"]);
});

test("envio ao cliente usa uma categoria compatível com cada FK e tipo de caixa", () => {
  assert.match(rotaEnvioCliente, /categoria_cliente_id FROM categoria_movimentacao_share/);
  assert.match(rotaEnvioCliente, /SELECT id, nome FROM categoria_movimentacao_cliente WHERE id = \?1 LIMIT 1/);
  assert.match(rotaEnvioCliente, /categoria_cliente_id, categoria_nome, grupo_categoria/);
  assert.match(rotaEnvioCliente, /categoriaClienteId, categoriaCliente\.nome/);
  assert.match(rotaEnvioCliente, /categoriaClienteId, categoriaCliente\.nome, valorCentavos/);
  assert.match(rotaEnvioCliente, /categoria_id: categoriaReceitaShare\.id/);
  assert.match(rotaEnvioCliente, /descricao, categoriaClienteId, categoriaCliente\.nome, 'CAIXA CLIENTE'/);
  assert.match(rotaEnvioCliente, /categoriaReceitaShare\.id, categoriaReceitaShare\.nome, 'REEMBOLSOS ENTRADAS'/);
  assert.match(rotaEnvioCliente, /categoria_cliente_relatorio_viagem_nao_encontrada/);
  assert.match(rotaEnvioCliente, /categoria_share_entrada_reembolso_nao_encontrada/);
});
test("envio ao cliente cria lançamentos antes do recebível que os referencia por FK", () => {
  const insertLancamento = rotaEnvioCliente.indexOf("INSERT INTO lancamentos");
  const insertRecebivel = rotaEnvioCliente.indexOf("statements.push(receivable.statement)");
  assert.notEqual(insertLancamento, -1);
  assert.notEqual(insertRecebivel, -1);
  assert.ok(insertLancamento < insertRecebivel);
});
test("envio ao cliente reconcilia o recebível sem interromper a criação dos lançamentos ausentes", () => {
  assert.match(rotaEnvioCliente, /ensureRelatorioContaAReceber\(db, \{/);
  assert.match(moduloContaReceber, /const canonicalKey = `RELATORIO_DESPESA_VIAGEM:\$\{reportId\}:CONTA_RECEBER`/);
  assert.match(rotaEnvioCliente, /if \(!existingClientLancamento\) statements\.push/);
  assert.match(rotaEnvioCliente, /if \(!existingShareLancamento\) statements\.push/);
  assert.doesNotMatch(rotaEnvioCliente, /if \(existing\) \{[\s\S]*?return c\.json/);
});

test("migração normaliza vínculos e protege unicidade ativa por relatório e devedor", () => {
  assert.match(migrationContaReceber, /REEMBOLSO_CLIENTE:CONTA_RECEBER/);
  assert.match(migrationContaReceber, /UPDATE contas_areceber[\s\S]*idempotency_key = 'RELATORIO_DESPESA_VIAGEM:'/);
  assert.match(migrationContaReceber, /DELETE FROM financeiro_vinculos[\s\S]*destino_tipo = 'CONTA_RECEBER'/);
  assert.match(migrationContaReceber, /INSERT OR IGNORE INTO financeiro_vinculos[\s\S]*cr\.id/);
  assert.match(migrationContaReceber, /CREATE UNIQUE INDEX idx_contas_areceber_relatorio_devedor_ativo/);
  assert.match(migrationContaReceber, /ON contas_areceber \(origem_id, cotista_id\)/);
  assert.doesNotMatch(migrationContaReceber, /DELETE FROM contas_areceber/);
});

test("holding compartilha reconciliação e vincula recebível ao movimento, não a lançamento", () => {
  assert.match(rotaEnvioCliente, /if \(report\.socio_id\)/);
  assert.match(rotaEnvioCliente, /movimentos_id: movimentoId,[\s\S]*?lancamentos_id: null/);
  assert.match(rotaEnvioCliente, /communicated: true/);
  assert.match(rotaEnvioCliente, /reconciliation_required/);
  assert.match(moduloContaReceber, /status: 'reconciliation_required'/);
});

test("envio ao cliente só grava cliente_id se existir na tabela de cadastro", () => {
  assert.match(worker, /import \{ calcularVencimentoReembolsoTripulante, findLancamentoClientId, sincronizarRelatorioViagemFinanceiro \}/);
  assert.match(worker, /import \{ ensureRelatorioContaAReceber, repairRelatorioContaReceberLinkStatements \} from '\.\/financeiro\/relatorioContaReceber'/);
  assert.match(rotaEnvioCliente, /const clienteIdLancamentoFk = await findLancamentoClientId\(db, report\.cliente_id\)/);
  assert.match(rotaEnvioCliente, /cotista\.id, clienteIdLancamentoFk, hoje, body\.data_vencimento/);
  assert.match(rotaEnvioCliente, /clienteIdLancamentoFk, periodicidade, tipoRateio, 'SHARE BRASIL'/);
});

test("programação de reembolso pré-preenche vencimento, periodicidade e tipo de rateio", () => {
  assert.match(worker, /r\.data_vencimento_reembolso/);
  assert.match(worker, /data_vencimento_reembolso: row\.data_vencimento_reembolso \|\| null/);
  assert.match(worker, /periodicidade: 'EVENTUAL', tipo_rateio: 'VARIAVEL POR VOO'/);
  assert.match(rotaEnvioCliente, /const periodicidade = String\(body\.periodicidade \|\| 'EVENTUAL'\)/);
  assert.match(rotaEnvioCliente, /const tipoRateio = String\(body\.tipo_rateio \|\| 'VARIAVEL POR VOO'\)/);
  assert.match(rotaEnvioCliente, /periodicidade, tipo_rateio, status, fluxo/);
  assert.match(frontendRelatorio, /vencimento: prefill\.data_vencimento_reembolso \|\| new Date\(\)\.toISOString\(\)\.slice\(0, 10\)/);
  assert.match(frontendRelatorio, /periodicidade: prefill\.periodicidade \|\| PERIODICIDADE_REEMBOLSO_PADRAO/);
  assert.match(frontendRelatorio, /tipoRateio: prefill\.tipo_rateio \|\| TIPO_RATEIO_REEMBOLSO_PADRAO/);
});

test("listagem autenticada inclui comprovantes por despesa sem expor o caminho de armazenamento", () => {
  assert.match(rotaMinhas, /FROM relatorio_despesa_viagem_anexos/);
  assert.match(rotaMinhas, /WHERE relatorio_despesa_viagem_id IN \(\$\{placeholders\}\)/);
  assert.match(rotaMinhas, /url_arquivo: `\/api\/financeiro\/relatorios-despesa-viagem/);
  assert.match(rotaMinhas, /anexos: anexosPorRelatorio\.get\(row\.id\) \|\| \[\]/);
  assert.doesNotMatch(rotaMinhas, /caminho_arquivo/);
});

test("rejeição autenticada aceita imagem multipart e persiste o anexo no diretório R2 de comprovantes", () => {
  assert.match(rotaAprovacaoAutenticada, /content-type.*multipart\/form-data/s);
  assert.match(rotaAprovacaoAutenticada, /form\.get\('anexo_rejeicao'\)/);
  assert.match(rotaAprovacaoAutenticada, /image\/heic/);
  assert.match(rotaAprovacaoAutenticada, /5 \* 1024 \* 1024/);
  assert.match(rotaAprovacaoAutenticada, /relatorio_despesa_viagem\/anexos_notas\/\$\{id\}/);
  assert.match(rotaAprovacaoAutenticada, /anexos_rejeicao = COALESCE\(\?, anexos_rejeicao\)/);
  assert.match(rotaAprovacaoAutenticada, /notifyReportRejection\(c, updated/);
  assert.match(rotaMinhas, /anexos_rejeicao: rejectionAttachments\(row\.anexos_rejeicao, row\.id\)/);
  assert.match(worker, /anexos-rejeicao\/\$\{encodeURIComponent\(id\)\}\/arquivo/);
});

test("lançamento Share da rota de envio é classificado fora do custo do cotista", () => {
  assert.match(rotaEnvioCliente, /idempotency_key, escopo_financeiro, url_doc/);
  assert.match(rotaEnvioCliente, /'CAIXA_SHARE'/);
  assert.match(rotaEnvioCliente, /UPDATE lancamentos SET escopo_financeiro = 'CAIXA_SHARE' WHERE id = \?/);
});

test("migração de custo integral vincula rateios e reconhece pagamentos diretos sem criar eventos de baixa", () => {
  assert.match(migrationCustoIntegral, /:CUSTO_INTEGRAL/);
  assert.match(migrationCustoIntegral, /UPDATE rateio_despesas AS rd[\s\S]*SET lancamento_id =/);
  assert.match(migrationCustoIntegral, /valor_pago_real_centavos = CASE[\s\S]*MIN\(CAST\(ROUND\(COALESCE\(r\.total_cliente/);
  assert.match(migrationCustoIntegral, /pago_diretamente = CASE[\s\S]*>= COALESCE\(rd\.valor_rateado_centavos/);
  assert.match(migrationCustoIntegral, /SET escopo_financeiro = 'CAIXA_SHARE'/);
  assert.doesNotMatch(migrationCustoIntegral, /INSERT INTO rateio_pagamentos|INSERT INTO auditoria_financeira/);
});
