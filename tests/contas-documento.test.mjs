import test from "node:test";
import assert from "node:assert/strict";
import { mapConta } from "../src/financeiro/contas.ts";

test("conta a receber de relatório usa a URL de visualização do PDF", () => {
  const conta = mapConta({
    id: "conta-1",
    numero_doc: "REL-001/26",
    relatorio_pdf_url: "/api/financeiro/relatorios-despesa-viagem/relatorio-1/pdf",
    url_doc: "share/relatorio_despesa_viagem/pdf_relatorios/REL-001.pdf",
  });

  assert.equal(conta.documentoUrl, "/api/financeiro/relatorios-despesa-viagem/relatorio-1/pdf");
});

test("documentos de recibos continuam usando a URL financeira existente", () => {
  const conta = mapConta({ id: "conta-2", url_recibo: "https://example.test/recibo.pdf" });
  assert.equal(conta.documentoUrl, "https://example.test/recibo.pdf");
});

test("contas preservam cada URL de anexo para a tabela do Financeiro Share", () => {
  const conta = mapConta({
    id: "conta-3",
    url_demonstrativo: "https://example.test/demonstrativo.pdf",
    url_nf: "https://example.test/nota.png",
    url_recibo: "https://example.test/recibo.pdf",
    url_boleto: "https://example.test/boleto.pdf",
    url_doc: "https://example.test/outro.jpg",
  });

  assert.equal(conta.url_demonstrativo, "https://example.test/demonstrativo.pdf");
  assert.equal(conta.url_nf, "https://example.test/nota.png");
  assert.equal(conta.url_recibo, "https://example.test/recibo.pdf");
  assert.equal(conta.url_boleto, "https://example.test/boleto.pdf");
  assert.equal(conta.url_doc, "https://example.test/outro.jpg");
  assert.equal(conta.documentoUrl, "https://example.test/demonstrativo.pdf");
});

test("conta a pagar preserva o colaborador como favorecido mesmo com fornecedor associado", () => {
  const conta = mapConta({
    id: "conta-colaborador",
    colaborador_id: "colaborador-1",
    colaborador_nome: "Ana Souza",
    fornecedor_id: "fornecedor-1",
    fornecedor_nome: "Fornecedor Exemplo",
  });

  assert.equal(conta.colaboradorId, "colaborador-1");
  assert.equal(conta.colaboradorNome, "Ana Souza");
  assert.equal(conta.fornecedor, "Fornecedor Exemplo");
});
