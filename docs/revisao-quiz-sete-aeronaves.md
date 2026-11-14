# Revisão do quiz para os sete modelos

## Situação encontrada

A revisão usou o site no commit `7853d0c` e o backend no commit `08f9dc7`. O site já cadastrava sete aeronaves e fotos no R2. Portanto, o trabalho necessário era alinhar as regras e a integração, não duplicar registros.

| Aeronave | Modelo | Motorização | Pressurizada | Faixa comercial atual de passageiros* |
| --- | --- | --- | --- | --- |
| Cirrus SR20 | SR20 | Monomotor a pistão | Não | Até 3 |
| Matrix | PA-46R-350T | Monomotor a pistão | Não | Até 4 |
| Seneca V | PA-34-220T | Bimotor a pistão | Não | Até 4 |
| Meridian / M500 | PA-46-500TP | Monomotor turboélice | Sim | Até 4 |
| Cheyenne II | PA-31T | Bimotor turboélice | Sim | Até 6 |
| Citation II | Cessna 550 | Bimotor a jato | Sim | Até 7 |
| Hawker Beechcraft 400A | Beechjet 400A | Bimotor a jato | Sim | Até 7 |

\* São faixas conservadoras de triagem comercial em `limitePerfil`, sem contar tripulação. Não são a capacidade certificada de todos os exemplares. A faixa de sete passageiros no 400A também precisa ser confirmada para a configuração real da Share; configurações desse modelo podem diferir. O quiz encaminha oito ou mais para análise individual. Não promete lotação com qualquer bagagem, combustível ou pista.

## Problemas encontrados e correções

| Encontrado | Ajuste |
| --- | --- |
| “7 ou mais” usava o número 8, retirando todas as aeronaves do ranking | Opções “7 passageiros” e “8 ou mais”; sete mantém os jatos elegíveis em pistas pavimentadas |
| Meridian ganhava pontos na resposta “dois motores” | Pontos removidos; continua classificado como monomotor turboélice |
| Meridian recebia pontos para cinco a seis passageiros apesar da própria faixa de quatro | Pontos incoerentes removidos; capacidade continua eliminatória |
| Pressurização era uma preferência de pontos, podendo indicar pistão não pressurizado | Texto passou a “Cabine pressurizada é essencial”; resposta exige modelo pressurizado |
| Filtros dos jatos estavam duplicados por ID | Filtro por família `jato`, abrangendo Citation e 400A |
| 400A e Citation tinham pontuação quase igual | 400A recebe maior peso comercial por tempo; Citation mantém maior peso por preferência por trajetos longos. Isso não representa comparação técnica de alcance sem escalas |
| Motivo de ausência de resultado falava apenas de passageiros | Explica combinação de passageiros, cabine e pistas |
| Frontend v2/sete modelos e backend v1/cinco modelos | Ambos na v3 com o mesmo módulo de pontuação |
| Backend aceitava recomendação enviada pelo cliente | Backend ignora esse campo e calcula pelas respostas validadas |
| SQL inicial alterado para sete modelos não atualizava banco existente | Migração aditiva com `quiz_participacoes` e `quiz_eventos`; registros históricos mantidos |
| Nome e telefone obrigatórios quando marcava a autorização | Contato parcial ou vazio aceito; início também permite “Começar sem informar contato” |
| Erro de contato não era visível na abertura | Erro explícito junto ao formulário, com opção de pular |
| Última pergunta completava apenas 8/9 da barra | Barra completa ao concluir as oito perguntas |
| Falha de imagem substituía qualquer modelo pelo turboélice do hero | Sem substituição por outra aeronave; avisa indisponibilidade da foto |

Na enumeração anterior, 1.631 combinações pediam cabine pressurizada e recebiam modelo sem pressurização. Depois da correção, esse número é zero. Isso é verificação de consistência do algoritmo, não medição de adequação operacional.

## O que ainda depende dos dados da Share

- Configuração de assentos e tripulação de cada aeronave; a lotação nominal do modelo não resolve a missão.
- Rotas reais, distância, peso, bagagem, reservas e desempenho das pistas. “Entre estados” não é medida de distância.
- Custos reais de aquisição da cota, fixos, variáveis e disponibilidade. O quiz não tem valores para calcular a melhor compra.
- Avaliação comercial dos pesos, especialmente entre os dois jatos. Os números atuais representam uma política de triagem ajustável, não uma fórmula técnica de desempenho.
- Publicação sincronizada dos dois PRs, aplicação da migração e configuração do segredo do quiz.

## Referências técnicas primárias

- [Piper M500](https://www.piper.com/model/m500/) e [lançamento da família M-Class](https://www.piper.com/press-releases/piper-aircraft-launches-three-new-m-class-products-the-m600-the-m350-and-the-m500/): monomotor turboélice com cabine pressurizada; não confundir com Matrix a pistão.
- [CAA New Zealand — Beech 400A, relatório de aceitação](https://www.caa.govt.nz/assets/aircraft/type-acceptance-reports/Beech_400A.pdf): bimotor a jato pressurizado e diferenças de configuração.
- [Cirrus SR Series](https://cirrusaircraft.com/aircraft/sr-series/): família SR e CAPS; nenhuma versão nova de aviônicos é presumida para o SR20 da frota.

## Verificação

29 testes do site, incluindo 28.800 combinações, invariantes de passageiros/pistas/pressurização, cobertura dos sete resultados, contato opcional, foto e captura. Backend com testes de rota e autenticação e TypeScript. Testes de banco usam SQL real em SQLite; o D1 de produção deve ser validado após a publicação.

Na suíte geral do backend, foram encontradas as mesmas dez falhas antes e depois desta alteração (financeiro, diário/jornadas e portal). Comparação com a base `08f9dc7`: 317/327 aprovados antes e 321/331 depois, sem falhas novas. Os sete testes da rota do quiz, os cinco de autenticação, TypeScript e o empacotamento `wrangler deploy --dry-run` passaram. Essas falhas anteriores permanecem fora do escopo desta revisão.
