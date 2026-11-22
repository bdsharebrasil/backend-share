# Acompanhamento de voo do Trip Share

## Consulta

`GET /api/colaborador/meus-voos/:id/acompanhamento`

Exige tripulação escalada, operações ou gestor, conforme o controle operacional existente. Retorna os metadados da perna atual, coordenadas de aeródromos, trilha histórica, fonte e posição ADS-B com `observado_em` e `consultado_em` separados. Usa os mesmos provedores já configurados; nunca usa a hora da consulta como hora do sinal. Um voo encerrado/cancelado/excluído ou com último corte não recebe posição atual da aeronave. Voos antigos sem operação recente também retornam apenas histórico.

## Fila GPS

`POST /api/colaborador/meus-voos/:id/posicoes-gps`

Body: `{ pontos: [{ id, lat, lon, registrado_em, precisao_m, alt_ft, gs_kt, rumo_graus }] }`.

Exige conta autenticada e autorização naquele voo. O usuário gravado vem da sessão, não do body. Máximo de 100 pontos, 64 KB por requisição, 30 lotes/minuto por conta; precisão <= 200 m, timestamp dos últimos sete dias e sem mais de 60 segundos no futuro. Sensores opcionais nulos não viram zero. INSERT idempotente pela chave `(voo_id,user_id,ponto_id)`; a resposta confirma somente IDs do lote persistido.

Os pontos são armazenados como GPS do aparelho em tabela própria. Não entram na trilha ADS-B, não representam sinal de transponder e não alteram status, horários ou diário. Nesta entrega o envio ao servidor é feito pelo app aberto; não há coleta em segundo plano nem mudança no mapa do painel da operação.

## Migração e publicação

`migrations/20261122_rastreio_gps_tripulante.sql` cria tabela e índice sem alterar tabelas existentes. O workflow aplica a migração idempotente antes de publicar o Worker e executa os testes do acompanhamento no check do PR. O app atualizado deve ser distribuído depois deste backend.

Testes: validação de sensores, replay sem duplicação em SQLite, isolamento por voo/usuário, limite de body, ADS-B atual por matrícula, histórico de voo encerrado, permissões e compatibilidade do D1.
