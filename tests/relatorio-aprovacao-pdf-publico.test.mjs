import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../src/worker.ts", import.meta.url), "utf8");

test("PDF público do relatório exige um token de aprovação válido", async () => {
  assert.match(source, /app\.get\('\/api\/public\/relatorios-despesa-viagem\/aprovacao\/:token\/pdf'/);
  assert.match(source, /token_aprovacao_tripulante_1 = \?1 OR r\.token_aprovacao_tripulante_2 = \?1/);
  assert.match(source, /Content-Type': 'application\/pdf'/);
  assert.match(source, /shareBrasilBucket\(c\)\.get\(row\.pdf_path\)/);
});
