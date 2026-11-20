# Custos reais no Portal do Cliente

## Contrato do espelho financeiro (20/11/2026)

A fonte de competência é **sempre `data_emissao`**, tanto no Balanço e
Financeiro do Portal quanto no dashboard interno e na view `vw_balanco_rateios`.
`data_competencia_demonstrativo` permanece como informação documental legada,
não como referência para atribuição financeira mensal.

- O custo da **aeronave** é o somatório de parcelas financeiras da aeronave,
  sem multiplicar `valor_total_centavos` por quantidade de cotistas.
- O custo **atribuído à cota** segue o vínculo exato
  `user_cliente.cotista_id → cotista_aeronave.id`; quando for sócio, a
  subdivisão vem de `rateio_hold`. Custo da cota nunca pode ser dividido
  pelas horas de toda a aeronave.
- O custo/hora operacional utiliza **AC–COR** e, se horários ausentes,
  o respectivo `tempo_total`. DEP–POU (fallback `tempo_voo`) é **tempo de
  voo**, indicador separado. Sem minutos operacionais confiáveis, custo/hora é nulo.
- Em TR/VT, divide-se a duração física por partes iguais entre cotistas
  ativos com participação positiva. Voos particulares exigem titular explícito;
  empréstimos pertencem apenas ao tomador identificado.
- A natureza econômica usa o mesmo `shared/natureza-custo.ts` do
  Financeiro Share; `tipo_rateio` não representa custo fixo/variável.
  Custos não classificados não recebem divisão artificial na projeção.
- O `GET /api/portal/balanco` filtra o vínculo da sessão e a aeronave
  selecionada e expõe `conciliacao` preliminar da mesma função
  `calcularBalancoMensal` usada internamente; não expõe o ledger de outros.
- Os tickets de viagem e combustível são calculados por categoria e IDs
  distintos, somando apenas parcelas atribuídas ao cotista.

**Importante:** como a view legada tinha prioridade de demonstrativo, aplicar
`migrations/20261120_balanco_competencia_emissao.sql` em homologação e testar
as validações de ajustes antes de migrar o D1 remoto. O SQL altera somente a
view, nunca tabelas ou rateios.



O portal consulta `GET /api/portal/financeiro/custos?aeronave_id=UUID&meses=AAAA-MM,...` para os indicadores do balanço e as premissas do simulador. A sessão deve ter o módulo financeiro e o vínculo exato da aeronave em `user_cliente.cotista_id`.

## Balanço

- Aeronave: soma de `valor_rateado_centavos` em `rateio_despesas`, uma vez por parcela. Não soma o `valor_total_centavos` repetido nas cotas, nem adiciona os rateios internos da holding.
- Sua cota: somente o vínculo autenticado; para sócio, a parcela de `rateio_hold` daquele sócio.
- Competência: `data_competencia_demonstrativo`, com fallback para `data_emissao`. Cancelamentos e estornos são excluídos.
- Horas: decolagem até pouso, incluindo a virada de meia-noite; na ausência dos horários, usa `tempo_voo` em horas decimais. Uma etapa sem tempo impede apresentar custo/hora como completo.
- Natureza: a informação explícita prevalece. Categorias reconhecidas são classificadas, reservas são separadas e os demais valores continuam em “Não classificados”. O critério de rateio não define a natureza econômica.

## Simulação

`POST /api/portal/simulador/voo` mantém a resposta e os parâmetros antigos. A nova projeção é solicitada com `incluir_estrutura: true`, `horas_ano`, `dias_jornada`, `passageiros` e, opcionalmente, `quantidade_cotas`.

A projeção exige também permissão financeira. Sem `quantidade_cotas`, usa a participação real cadastrada, inclusive quando desigual. Com o campo, calcula um cenário de cotas iguais, sem gravar ou alterar contratos e rateios.

- Curto prazo: combustível estimado pelo cadastro e preços reais, taxas por trecho cadastradas ou médias observadas, e pernoites cadastrados ou média histórica de viagem por dia com voo.
- Médio prazo: custos fixos dos meses com lançamentos, anualizados, multiplicados pela participação e divididos pelas horas anuais planejadas, vezes a duração da viagem.
- Longo prazo: reserva por hora cadastrada, manutenção/reservas por hora já cadastradas no simulador antigo, ou reserva explicitamente identificada no histórico por hora voada. A origem é indicada na resposta.

A base é a janela dos últimos 12 meses completos, pelo calendário de Brasília. Meses sem lançamentos não são tratados como meses com custo fixo zero ao calcular a média. Não há valores padrão da demonstração. Uma premissa ausente resulta em `null`, lista de pendências e subtotal dos custos conhecidos; não em total completo. Despesas sem natureza também tornam a projeção parcial.

Nenhuma migration nova é necessária. As colunas opcionais de custos da aeronave são lidas apenas se existirem; o histórico é usado quando há base suficiente.

## Validação e publicação

`npm run type-check` e `node --import tsx --test tests/portal-custos-reais.test.mjs` validam tipos, SQL em SQLite, participação desigual, holdings, vínculos, permissões, centavos, horários e compatibilidade do contrato antigo.

Publicar o backend antes do frontend correspondente. A rota antiga de simulação continua disponível para acessos sem permissão financeira.
