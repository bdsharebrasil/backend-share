import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/routes/ctmRoutes.ts", import.meta.url), "utf8");
const inicio = source.indexOf("ctmRoutes.get('/api/ctm/relatorios-manutencao'");
const fim = source.indexOf("for (const [slug", inicio);
const rota = source.slice(inicio, fim);

test("relatórios de manutenção listam somente aeronaves ativas", () => {
  assert.match(rota, /FROM aeronave WHERE lower\(COALESCE\(status, 'ativa'\)\) LIKE 'ativ%'/i);
  assert.match(rota, /r\.aeronave_id IN \(SELECT id FROM aeronave WHERE lower\(COALESCE\(status, 'ativa'\)\) LIKE 'ativ%'\)/i);
});
