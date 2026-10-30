import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/financeiro/enviosPagamentoRoutes.ts", import.meta.url), "utf8");

test("registro de e-mail enviado é limitado ao criador ou ao papel financeiro", () => {
  assert.match(source, /enviosPagamentoRoutes\.post\('\/envios-pagamento\/:id\/email-enviado'/);
  assert.match(source, /if \(somenteProprietario\)[\s\S]*?if \(!podeGerenciar && current\.criado_por !== userId\) return c\.notFound\(\)/);
  assert.match(source, /if \(requested !== 'EMAIL_ENVIADO'\) return c\.json/);
});

test("usuário comum só converte envio próprio de cliente ou reembolso", () => {
  assert.match(source, /if \(!podeGerenciar && \(request\.criado_por !== userId \|\| !\['cliente', 'reembolso'\]\.includes\(String\(request\.tipo\)\)\)\) return c\.notFound\(\)/);
  assert.match(source, /if \(!podeGerenciar && request\.tipo === 'reembolso' && !\['EMAIL_ENVIADO', 'CONVERTIDO'\]\.includes\(String\(request\.status\)\.toUpperCase\(\)\)\)/);
});
