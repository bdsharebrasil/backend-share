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
