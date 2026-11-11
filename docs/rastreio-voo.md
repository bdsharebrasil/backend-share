# Histórico de rastreio dos agendamentos

Aplicar `migrations/20261111_rastreio_historico.sql` no D1 antes de implantar o backend. A migração cria as estruturas ausentes e preserva a tabela de posições já existente:

```sh
pnpm exec wrangler d1 execute bd_sharebrasil --remote --file=migrations/20261111_rastreio_historico.sql
```

Implantar o backend antes do frontend. O cron configurado em `wrangler.toml` coleta posições a cada minuto mesmo sem usuários com a página aberta. O painel consulta a cada dez segundos enquanto houver operações. A fila financeira conserva a frequência de quinze minutos.

A coleta considera agendamentos aprovados ou em operação dentro do período agendado (incluindo a virada de dia). ADS-B recente no ar identifica um voo mesmo sem AC/DEP ou quando o status de solo ainda não foi atualizado. Se a mesma aeronave tem mais de um agendamento elegível, o horário programado mais próximo da coleta determina o vínculo; convém manter os horários programados corretos para distinguir voos sucessivos da mesma aeronave.

Pontos e eventos ficam vinculados à solicitação, inclusive quando a jornada/perna é criada posteriormente. Não há mais exclusão automática após três dias. `GET /api/interno/solicitacoes/:id/rastreio` lê o histórico de qualquer data sem depender de consulta ao provedor. Exige a mesma autenticação interna do painel.

Eventos:

- `SINAL_RECEBIDO`: primeira aparição ou retorno do sinal; usa o instante observado (`seen_pos`), em UTC.
- `SINAL_PERDIDO`: ausência de posição recente por mais de 120 segundos; guarda o horário do último sinal e, separadamente, quando a ausência foi detectada. Não modifica POU ou o status do agendamento.
- `EM_SOLO_ADSB`: o provedor informou solo após uma posição no ar. Não altera os horários da tripulação.

Uma indisponibilidade de ambos os provedores não é registrada como perda de sinal. A perda de cobertura pode ocorrer em voo e é exibida como possível pouso, separada de POU. O mapa não desenha retas para substituir lacunas maiores que três minutos ou ligar pernas distintas. Histórico mostra primeiro/último sinal, eventos e horários AC/DEP/POU/COR; avião ao vivo aparece apenas com posição recente no ar.

Não há reconstrução retroativa: o histórico usa pontos já existentes e os que forem coletados após a implantação. Voos anteriores sem pontos permanecem sem percurso. Se as tabelas não estiverem disponíveis, a API informa `historico_disponivel: false` e a interface mostra a indisponibilidade.
