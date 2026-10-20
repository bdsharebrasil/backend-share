import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { selecionarAnexosEnvioPagamento } from "../src/financeiro/paymentEmailAttachments.ts";

const source = await readFile(new URL("../src/routes/emailsRoutes.ts", import.meta.url), "utf8");

test("resolve anexos por UUID a partir do envio persistido no rascunho", () => {
  const anexosSalvos = JSON.stringify([
    { id: "anexo-cotista-a", url: "https://files.example/share/a.pdf", cotista_id: "cotista-a" },
    { id: "anexo-cotista-b", url: "https://files.example/share/b.pdf", cotista_id: "cotista-b" },
    { id: "anexo-compartilhado", url: "https://files.example/share/shared.pdf" },
  ]);

  assert.deepEqual(
    selecionarAnexosEnvioPagamento(anexosSalvos, ["anexo-cotista-a", "anexo-cotista-b", "anexo-compartilhado"], "cotista-a"),
    [
      { id: "anexo-cotista-a", url: "https://files.example/share/a.pdf", cotista_id: "cotista-a" },
      { id: "anexo-compartilhado", url: "https://files.example/share/shared.pdf" },
    ],
  );
});

test("mantém anexos com escopo quando o email não é individualizado por cotista", () => {
  assert.deepEqual(
    selecionarAnexosEnvioPagamento([{ id: "anexo-1", cotista_id: "cotista-a" }], ["anexo-1"], ""),
    [{ id: "anexo-1", cotista_id: "cotista-a" }],
  );
});

test("o envio falha se um UUID selecionado não existir no envio ou não estiver acessível no R2", () => {
  assert.match(source, /anexo_envio_despesa_nao_encontrado/);
  assert.match(source, /anexo_envio_despesa_indisponivel/);
  assert.match(source, /share\/nf-boletos-clients\/\$\{user\.id\}\/`/);
  assert.match(source, /attachments: \[\.\.\.logoInline, \.\.\.anexos\]/);
  assert.match(source, /JSON\.stringify\(anexosDetalhes\), anexos\.length/);
});
