# API v1 — contrato do app mobile

Prefixo: `/api/v1`. É a API que o app Expo (`bdsharebrasil/tripapp`, `artifacts/share-brasil`) consome.

Por que versionar: app instalado não atualiza na hora. `/api/v1` não pode mudar de forma incompatível; mudanças de contrato entram em `/api/v2`. As rotas legadas (`/api/weather`, `/api/flightplan`, `/api/aerodromos`) continuam existindo e atendendo o painel web — **nada foi removido**.

## GET /api/v1/aerodromos

Busca de aeródromos com paginação por cursor.

| Parâmetro | Tipo | Padrão | Descrição |
| --- | --- | --- | --- |
| `q` | string | `""` | Busca com `LIKE` em `nome` e `designativo_icao` (case-insensitive, curingas escapados). Máximo 60 caracteres. |
| `limit` | inteiro | `20` | Itens por página. Máximo `50`. |
| `cursor` | string | — | Cursor opaco devolvido em `next_cursor`. |

Resposta `200`:

```json
{
  "data": [
    {
      "id": "8b0f0f5e-2f1e-4a1b-9a35-3f0c0c1c9a11",
      "nome": "GUARULHOS",
      "designativo_icao": "SBGR",
      "coordenadas": "-23.4356,-46.4731"
    }
  ],
  "next_cursor": "U0JTUw"
}
```

- Apenas os quatro campos do contrato são devolvidos (resposta enxuta para rede móvel).
- Ordenação estável por `designativo_icao` (maiúsculo). Paginação por chave, sem `OFFSET`: o cursor é o último `designativo_icao` da página, em base64url.
- `next_cursor` é `null` na última página.
- Erros: `400 {"error":"cursor_invalido"}` e `502 {"error":"falha_ao_consultar_aerodromos"}`.

## GET /api/v1/weather/:icao

Idêntico a `/api/weather/:icao` (METAR/TAF via AISWEB), inclusive rate limit e cache. Resposta em objeto único, sem envelope.

## GET /api/v1/flightplan?adep=&ades=

Idêntico a `/api/flightplan`, com os mesmos parâmetros opcionais (`aeronave_id`, `speed`, `fuel_burn`, `reserve`).

## Autenticação

Hoje as três rotas são públicas, como as legadas. Quando o app tiver login, o token vai em `Authorization: Bearer <jwt do Supabase>` — o Worker já valida esse formato em `src/lib/auth.ts`, então basta aplicar o middleware nas rotas novas.

## CORS

`/api/v1/*` passa pelo middleware global (`src/lib/cors.ts`), que responde apenas às origens listadas em `ALLOWED_ORIGINS` (`wrangler.toml`). O app nativo não precisa de CORS; o build web do Expo no Cloudflare Pages precisa: inclua o domínio do Pages em `ALLOWED_ORIGINS` antes de publicar a versão web.

## Ordem de deploy (importante)

Publique o Worker **antes** de distribuir um app que chame `/api/v1`. Enquanto o Worker antigo estiver no ar, `/api/v1/*` responde `404`.

```bash
pnpm type-check
pnpm exec tsx --test tests/api-v1.test.mjs
pnpm deploy
```
