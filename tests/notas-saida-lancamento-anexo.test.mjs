import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { notasSaidaRoutes } from '../src/financeiro/notasSaidaRoutes.ts';

function criarAplicacao() {
  const uploads = [];
  const db = {
    prepare() {
      return {
        bind() { return this; },
        async first() { return { autorizado: 1 }; },
      };
    },
  };
  const bucket = {
    async put(key, value, options) {
      uploads.push({ key, value, options });
    },
  };
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('userId', 'admin');
    await next();
  });
  app.route('/', notasSaidaRoutes);

  return {
    uploads,
    async enviarArquivo({ conteudo, nome = '2 - FGTS 09-2026 - EMPR CONSIGNADO.PDF', tipo = 'application/pdf' }) {
      const form = new FormData();
      form.set('arquivo', new File([conteudo], nome, { type: tipo }));
      form.set('origem', 'lancamento');
      form.set('documento_id', 'lancamento-1');
      const response = await app.request('/notas-saida/anexos', {
        method: 'POST',
        body: form,
      }, { SHARE_DB: db, SHARE_FILES: bucket });
      return { response, body: await response.json() };
    },
  };
}

test('aceita e armazena PDF válido como anexo de lançamento, inclusive com nome original com espaços e extensão maiúscula', async () => {
  const { uploads, enviarArquivo } = criarAplicacao();
  const conteudo = new TextEncoder().encode('%PDF-1.7\nconteudo de teste');
  const { response, body } = await enviarArquivo({ conteudo });

  assert.equal(response.status, 201, JSON.stringify(body));
  assert.equal(uploads.length, 1);
  assert.match(uploads[0].key, /^share\/lancamento\/lancamento-1\//);
  assert.match(uploads[0].key, /2 - FGTS 09-2026 - EMPR CONSIGNADO\.PDF$/);
  assert.equal(uploads[0].options.httpMetadata.contentType, 'application/pdf');
  assert.deepEqual(new Uint8Array(uploads[0].value), conteudo);
  assert.equal(typeof body.url, 'string');
});

test('rejeita arquivo com MIME PDF mas sem assinatura PDF e não grava no bucket', async () => {
  const { uploads, enviarArquivo } = criarAplicacao();
  const { response, body } = await enviarArquivo({ conteudo: new TextEncoder().encode('não é PDF') });

  assert.equal(response.status, 415);
  assert.equal(body.error, 'conteudo_pdf_invalido');
  assert.equal(uploads.length, 0);
});

test('continua aceitando imagens em lançamentos e rejeita outros MIME types', async () => {
  const imagem = criarAplicacao();
  const resultadoImagem = await imagem.enviarArquivo({
    conteudo: new Uint8Array([0xff, 0xd8, 0xff]),
    nome: 'comprovante.jpg',
    tipo: 'image/jpeg',
  });
  assert.equal(resultadoImagem.response.status, 201, JSON.stringify(resultadoImagem.body));

  const outroFormato = criarAplicacao();
  const resultadoOutro = await outroFormato.enviarArquivo({
    conteudo: new TextEncoder().encode('word'),
    nome: 'comprovante.docx',
    tipo: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
  assert.equal(resultadoOutro.response.status, 415);
  assert.equal(resultadoOutro.body.error, 'formato_de_anexo_nao_permitido');
  assert.equal(outroFormato.uploads.length, 0);
});
