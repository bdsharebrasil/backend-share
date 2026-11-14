# Quiz v3: site e backend Share

O site usa por padrão `https://api.share-brasil.com/api/quiz/leads`. Essa API pertence ao repositório `bdsharebrasil/backend-share` e usa o binding existente `SHARE_DB`, do banco `bd_sharebrasil`. Não é preciso publicar outro serviço para usar essa integração.

A recomendação é mostrada no navegador ao terminar as oito perguntas. A gravação ocorre em paralelo e não exige abrir o WhatsApp. O backend recalcula o resultado; não confia em indicação enviada pelo cliente.

## Contato opcional

A abertura pede somente nome e WhatsApp opcionais e oferece “Começar sem informar contato”. A autorização de contato também é opcional. Dados autorizados podem ser parciais: nome sem telefone, telefone sem nome ou ambos. Campos vazios são `NULL`, sem inventar cidade. Sem autorização, nenhum dado pessoal é enviado pelo site ou mantido pelo backend.

Participações concluídas sem contato são registradas sem identificação. Não é possível saber quem é a pessoa que optou por não se identificar. Quem abandona antes de concluir não gera registro por este fluxo. O contato fica apenas em memória no navegador; não é salvo em localStorage.

## Ativar no backend existente

1. Incorpore e publique o PR correspondente em `backend-share`, com `src/quiz/modelo.js`, `src/quiz/captura.js`, `src/quizRoutes.ts` e os ajustes de montagem.
2. Aplique **somente a migração nova** no banco correto. Na raiz do backend:

```sh
npx wrangler d1 execute bd_sharebrasil --remote --file=migrations/20261114_quiz_participacoes.sql
```

3. Configure um segredo aleatório estável, de pelo menos 32 caracteres, no ambiente do Worker:

```sh
npx wrangler secret put QUIZ_HASH_SECRET
```

4. As origens do site estão em `QUIZ_ALLOWED_ORIGINS`: `https://conheca.share-brasil.com,https://conheca-share.pages.dev`. Use URLs de origem exatas, sem barra final. Outras origens de homologação podem ser adicionadas separadas por vírgulas. O CORS dessa rota é isolado; não é necessário liberar o site nas APIs financeiras ou operacionais.
5. Publique backend e site usando a mesma versão do contrato, `2026-11-v3`. O backend rejeita outras versões, evitando registrar um resultado divergente.

A migração cria `quiz_participacoes`, `quiz_eventos` e os contadores técnicos, sem alterar `leads_quiz` ou `eventos_quiz` antigos. Editar um `CREATE TABLE IF NOT EXISTS` já executado não muda o CHECK ou os NOT NULL do banco existente. Por isso a evolução é aditiva. Não execute DROP de tabelas antigas.

O segredo de eventos é exclusivo do quiz; não reutiliza `INTERNAL_TOKEN`. A API não oferece consulta pública dos registros. O cron do backend limpa somente os contadores técnicos vencidos. Não apaga contatos comerciais.

## Verificar no D1

Participações concluídas:

```sql
SELECT protocolo, nome, telefone, aeronave_sugerida, consentimento,
       criado_em, whatsapp_clicado_em
FROM quiz_participacoes
ORDER BY criado_em DESC;
```

Pessoas que autorizaram contato e forneceram telefone, mesmo sem WhatsApp:

```sql
SELECT protocolo, nome, telefone, aeronave_sugerida, criado_em
FROM quiz_participacoes
WHERE consentimento = 1 AND telefone IS NOT NULL
ORDER BY criado_em DESC;
```

Resumo incluindo participações sem identificação:

```sql
SELECT COALESCE(aeronave_sugerida, 'ANALISE_PERSONALIZADA') AS perfil,
       COUNT(*) AS participacoes,
       SUM(CASE WHEN telefone IS NOT NULL THEN 1 ELSE 0 END) AS com_telefone,
       SUM(CASE WHEN whatsapp_clicado_em IS NOT NULL THEN 1 ELSE 0 END) AS cliques_whatsapp
FROM quiz_participacoes
GROUP BY aeronave_sugerida;
```

Para histórico de versões anteriores, consulte também `leads_quiz`. Um clique só indica abertura do link; não comprova envio da mensagem.

## Homologação

Se o site no Pages mostrar “No Access-Control-Allow-Origin”, confira a variável `QUIZ_ALLOWED_ORIGINS` no ambiente publicado do Worker `api-workers`. Ela deve incluir `https://conheca-share.pages.dev`. Uma variável personalizada substitui a lista padrão do código. A correção precisa ser publicada no backend; republicar apenas o site não muda o CORS da API.

Confira o preflight sem criar um lead:

```sh
curl -i -X OPTIONS https://api.share-brasil.com/api/quiz/leads \
  -H 'Origin: https://conheca-share.pages.dev' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: content-type'
```

O retorno esperado é `204` com `Access-Control-Allow-Origin: https://conheca-share.pages.dev`. Depois, conclua o quiz e confirme a gravação no D1. Erros de configuração do banco/segredo também mantêm o CORS para origens autorizadas, permitindo enxergar a resposta real da API.

Conclua o quiz sem contato, com nome sozinho, com telefone sozinho e com ambos autorizados. Confirme o resultado antes de qualquer clique no WhatsApp, depois o registro no D1. Verifique reenvio sem duplicação, rejeição de versão antiga e de resultado adulterado e ausência de listagem pública. Uma falha da API não pode impedir o resultado.

O Worker separado de `cloudflare/quiz/worker.js` permanece como alternativa, usando binding `DB`, `ORIGENS_PERMITIDAS`, o mesmo segredo e a migração `0002_quiz_participacoes.sql`. O uso principal é o backend existente. Não rode dois serviços diferentes para gravar a mesma participação.

Os módulos de modelo e captura devem permanecer equivalentes nos dois repositórios. A revisão das regras e das faixas comerciais está em `docs/revisao-quiz-sete-aeronaves.md`. As fotos usam os URLs de cada modelo já configurados no R2 da Share.
