// Regras de triagem comercial, versão compartilhada pelo navegador e pelo Worker.
// Não são dados homologados da frota. A Share deve validar configuração e missão.
export const VERSAO_QUIZ = "2026-11-v3";
export const MOMENTOS = {
  EXPLORANDO: "Conhecendo as possibilidades",
  ATE_3_MESES: "Nos próximos 3 meses",
  ATE_6_MESES: "Entre 3 e 6 meses",
  ESTE_ANO: "Mais adiante",
};
export const WHATSAPP_NUMERO = "5565981730641";
export const AERONAVES_IMAGENS_BASE_URL =
  "https://pub-f4fb8ab5edc0402a840f54b4988012c2.r2.dev/quiz";
export const ORDEM_DESEMPATE = [
  "cirrus",
  "matrix",
  "seneca",
  "meridian",
  "cheyenne",
  "citation",
  "hawker400a",
];
export const AERONAVES = {
  cirrus: {
    nome: "Cirrus SR20",
    modelo: "SR20",
    imagem: `${AERONAVES_IMAGENS_BASE_URL}/SR20.png`,
    tipo: "Monomotor a pistão",
    perfil: "Liberdade para estar mais perto",
    familia: "pistao",
    pressurizada: false,
    motores: 1,
    limitePerfil: 3,
    resumo: "Para viagens regionais, grupos menores e uma rotina que pede agilidade.",
    destaques: [
      "Uma opção para deslocamentos regionais frequentes.",
      "Estrutura mais enxuta para começar a explorar a aviação compartilhada.",
    ],
    considerar: [
      "Espaço, bagagem e ocupação precisam ser avaliados juntos.",
      "Cabine não pressurizada.",
    ],
  },
  matrix: {
    nome: "Piper Matrix",
    modelo: "PA-46R-350T",
    imagem: `${AERONAVES_IMAGENS_BASE_URL}/PA-46R-350T.png`,
    tipo: "Monomotor a pistão",
    perfil: "Mais espaço para seus planos",
    familia: "pistao",
    pressurizada: false,
    motores: 1,
    limitePerfil: 4,
    resumo: "Uma alternativa para levar a família e equilibrar espaço, deslocamento e custo.",
    destaques: [
      "Cabine que favorece viagens em família.",
      "Uma alternativa intermediária para comparar com os bimotores.",
    ],
    considerar: [
      "A quantidade de passageiros depende da configuração e da missão.",
      "Cabine não pressurizada.",
    ],
  },
  seneca: {
    nome: "Seneca V",
    modelo: "PA-34-220T",
    imagem: `${AERONAVES_IMAGENS_BASE_URL}/SENECA-V-PA-34-220T.jpg`,
    tipo: "Bimotor a pistão",
    perfil: "Conexões que fazem seu dia render",
    familia: "pistao",
    pressurizada: false,
    motores: 2,
    limitePerfil: 4,
    resumo:
      "Para quem valoriza a configuração bimotora e deslocamentos entre cidades e propriedades.",
    destaques: [
      "Dois motores, alinhados à sua preferência de configuração.",
      "Uma alternativa para estudar nas suas rotas regionais.",
    ],
    considerar: ["Pistas de propriedades exigem avaliação individual.", "Cabine não pressurizada."],
  },
  cheyenne: {
    nome: "Cheyenne II",
    modelo: "PA-31T",
    imagem: `${AERONAVES_IMAGENS_BASE_URL}/CHEYENNEII-PA-31T.jpeg`,
    tipo: "Bimotor turboélice · pressurizado",
    perfil: "Seu tempo ganha novas distâncias",
    familia: "turboelice",
    pressurizada: true,
    motores: 2,
    limitePerfil: 6,
    resumo: "Um próximo passo para quem procura cabine pressurizada e viagens com mais pessoas.",
    destaques: [
      "Cabine pressurizada para considerar em viagens mais longas.",
      "Turbinas e configuração bimotora para ampliar as alternativas de deslocamento.",
    ],
    considerar: [
      "A infraestrutura e as condições de cada pista precisam ser analisadas.",
      "O plano de uso deve considerar os custos fixos e variáveis.",
    ],
  },
  citation: {
    nome: "Citation II",
    modelo: "Cessna 550",
    imagem: `${AERONAVES_IMAGENS_BASE_URL}/c550.jpg`,
    tipo: "Bimotor a jato · pressurizado",
    perfil: "Mais destinos no mesmo dia",
    familia: "jato",
    pressurizada: true,
    motores: 2,
    limitePerfil: 7,
    resumo:
      "Para uma agenda entre cidades, com prioridade ao tempo e à experiência de uma cabine de jato.",
    destaques: [
      "Uma opção quando reduzir o tempo em deslocamento é prioridade.",
      "Cabine pressurizada para conectar seus compromissos.",
    ],
    considerar: [
      "Aeroportos e pistas precisam ser compatíveis com a operação.",
      "Participação, disponibilidade e custos serão definidos em uma proposta.",
    ],
  },
  meridian: {
    nome: "Meridian / M500",
    modelo: "PA-46-500TP",
    imagem: `${AERONAVES_IMAGENS_BASE_URL}/PA-46-500TP.jpg`,
    tipo: "Monomotor turboélice · pressurizado",
    perfil: "Alcance para a sua rotina",
    familia: "turboelice",
    pressurizada: true,
    motores: 1,
    limitePerfil: 4,
    resumo: "Uma opção pressurizada para conectar cidades e propriedades com praticidade.",
    destaques: [
      "Cabine pressurizada para viagens regionais com mais conforto.",
      "Uma alternativa turboélice para equilibrar alcance e operação.",
    ],
    considerar: [
      "Rotas, pistas e bagagem precisam ser avaliadas para cada missão.",
      "A configuração monomotora deve ser comparada às suas preferências.",
    ],
  },
  hawker400a: {
    nome: "Hawker Beechcraft 400A",
    modelo: "Beechjet 400A",
    imagem: `${AERONAVES_IMAGENS_BASE_URL}/400A.png`,
    tipo: "Bimotor a jato · pressurizado",
    perfil: "Velocidade para conectar compromissos",
    familia: "jato",
    pressurizada: true,
    motores: 2,
    limitePerfil: 7,
    resumo: "Para quem busca a experiência de um jato executivo em rotas entre cidades.",
    destaques: [
      "Cabine pressurizada e configuração bimotora para comparar em viagens de negócios.",
      "Uma opção para estudar quando o tempo de deslocamento é decisivo.",
    ],
    considerar: [
      "Aeroportos, pistas e infraestrutura precisam ser compatíveis com a operação.",
      "Disponibilidade, custos e missão serão confirmados em uma proposta.",
    ],
  },
};
const opcao = (valor, rotulo, resumo, pontos = {}, detalhe = "") => ({
  valor,
  rotulo,
  resumo,
  pontos,
  detalhe,
});
export const PERGUNTAS = [
  {
    id: "uso",
    curto: "Seu momento",
    titulo: "O que você quer fazer com o tempo que vai ganhar?",
    ajuda: "Imagine a viagem que você gostaria de fazer com mais liberdade.",
    opcoes: [
      opcao(
        "familia",
        "Estar mais perto da família",
        "Família e lazer fazem parte dos seus planos",
        { cirrus: 2, matrix: 3, seneca: 1 },
        "Fins de semana, férias e momentos juntos",
      ),
      opcao(
        "negocios",
        "Fazer meus negócios irem mais longe",
        "Você quer conectar compromissos e negócios",
        { matrix: 1, seneca: 1, meridian: 1, cheyenne: 2, citation: 2, hawker400a: 2 },
        "Visitas, reuniões e mais de uma cidade no dia",
      ),
      opcao(
        "fazendas",
        "Conectar fazendas e propriedades",
        "Você precisa estar próximo da operação rural",
        { cirrus: 2, seneca: 3, meridian: 1, cheyenne: 1 },
        "Menos estrada, mais presença na operação",
      ),
      opcao(
        "equipe",
        "Viajar com minha equipe",
        "Você costuma viajar em grupo",
        { matrix: 1, meridian: 1, cheyenne: 3, citation: 2, hawker400a: 2 },
        "Pessoas e projetos seguindo juntos",
      ),
    ],
  },
  {
    id: "pax",
    curto: "Passageiros",
    titulo: "Quantos passageiros vão normalmente?",
    ajuda: "Inclua você. Não conte o piloto ou a tripulação.",
    opcoes: [
      opcao("1-2", "1 a 2 passageiros", "Seu grupo costuma ser pequeno", {
        cirrus: 4,
        matrix: 1,
        seneca: 1,
      }),
      opcao("3-4", "3 a 4 passageiros", "Você quer espaço para um grupo de 3 a 4 passageiros", {
        matrix: 4,
        seneca: 3,
        meridian: 4,
        cheyenne: 1,
      }),
      opcao("5-6", "5 a 6 passageiros", "Você precisa acomodar um grupo maior", {
        cheyenne: 4,
        citation: 3,
        hawker400a: 3,
      }),
      opcao("7", "7 passageiros", "Você costuma viajar com sete passageiros", {
        citation: 4,
        hawker400a: 4,
      }),
      opcao(
        "8+",
        "8 passageiros ou mais",
        "Seu grupo pede uma avaliação específica de assentos",
        {},
      ),
    ],
  },
  {
    id: "distancia",
    curto: "Suas viagens",
    titulo: "Como são os seus trajetos mais comuns?",
    ajuda: "Não precisa conhecer milhas ou termos de aviação. Pense nos seus destinos.",
    opcoes: [
      opcao(
        "regional",
        "Dentro do estado e regiões próximas",
        "Você prioriza deslocamentos regionais",
        { cirrus: 4, matrix: 2, seneca: 3 },
        "Fazendas, cidades vizinhas e polos regionais",
      ),
      opcao(
        "media",
        "Entre estados próximos",
        "Você conecta estados próximos",
        { matrix: 3, seneca: 2, meridian: 4, cheyenne: 3, citation: 1, hawker400a: 2 },
        "Viagens regionais um pouco mais longas",
      ),
      opcao(
        "longa",
        "Entre regiões do Brasil",
        "Você quer conectar diferentes regiões",
        { matrix: 1, meridian: 1, cheyenne: 3, citation: 5, hawker400a: 4 },
        "Destinos mais distantes e viagens de negócios",
      ),
      opcao(
        "muito-longa",
        "Longas distâncias, com poucas paradas",
        "Você valoriza autonomia e menos escalas",
        { meridian: 1, cheyenne: 1, citation: 6, hawker400a: 4 },
        "A equipe vai estudar as rotas e eventuais escalas",
      ),
    ],
  },
  {
    id: "horas",
    curto: "Frequência",
    titulo: "Quanto você imagina voar por mês?",
    ajuda: "Uma estimativa está ótima. Vamos ajustar isso juntos depois.",
    opcoes: [
      opcao("ate-3", "Até 3 horas", "Você estima até 3 horas por mês", {
        cirrus: 2,
        matrix: 1,
        seneca: 1,
      }),
      opcao("3-6", "De 3 a 6 horas", "Você estima de 3 a 6 horas por mês", {
        cirrus: 1,
        matrix: 2,
        seneca: 2,
        meridian: 1,
        cheyenne: 1,
      }),
      opcao("6-12", "De 6 a 12 horas", "Você estima de 6 a 12 horas por mês", {
        matrix: 1,
        seneca: 1,
        meridian: 1,
        cheyenne: 3,
        citation: 2,
      }),
      opcao("12+", "Mais de 12 horas", "Você prevê uma rotina de voos mais frequente", {
        meridian: 1,
        cheyenne: 2,
        citation: 3,
        hawker400a: 3,
      }),
      opcao("nao-sei", "Ainda estou descobrindo", "Seu plano de uso ainda está em construção", {}),
    ],
  },
  {
    id: "pista",
    curto: "Destinos e pistas",
    titulo: "Onde você precisa chegar?",
    ajuda: "Isso ajuda a selecionar o tipo de operação a estudar.",
    opcoes: [
      opcao(
        "asfalto",
        "Aeroportos com pista pavimentada",
        "Seus destinos têm pistas pavimentadas",
        { meridian: 1, citation: 1, hawker400a: 1 },
      ),
      opcao(
        "misto",
        "Aeroportos e pistas de propriedades",
        "Você precisa alternar aeroportos e propriedades",
        { cirrus: 1, matrix: 1, seneca: 2, meridian: 1, cheyenne: 1 },
      ),
      opcao(
        "terra",
        "Principalmente fazendas e pistas não pavimentadas",
        "O acesso a propriedades é essencial",
        { cirrus: 2, seneca: 3, meridian: 1, cheyenne: 1 },
      ),
      opcao(
        "nao-sei",
        "Quero ajuda para avaliar meus destinos",
        "Seus destinos serão avaliados pela equipe",
        {},
      ),
    ],
  },
  {
    id: "prioridade",
    curto: "Sua prioridade",
    titulo: "O que faria a maior diferença para você?",
    ajuda: "Escolha o que mais pesa neste momento.",
    opcoes: [
      opcao("tempo", "Ganhar o máximo de tempo", "Agilidade é sua prioridade", {
        matrix: 1,
        meridian: 3,
        cheyenne: 3,
        citation: 4,
        hawker400a: 6,
      }),
      opcao(
        "equilibrio",
        "Equilibrar conforto e custo",
        "Você busca equilíbrio entre experiência e custo",
        { cirrus: 1, matrix: 3, seneca: 2, meridian: 3, cheyenne: 2 },
      ),
      opcao(
        "custo",
        "Começar com uma estrutura mais econômica",
        "Você valoriza uma estrutura de custo mais enxuta",
        { cirrus: 5, matrix: 2, seneca: 1 },
      ),
    ],
  },
  {
    id: "conforto",
    curto: "Experiência de cabine",
    titulo: "Como você imagina a experiência a bordo?",
    ajuda:
      "Cabine pressurizada é um dos fatores para comparar as opções. O conforto também depende da missão e das condições do voo.",
    opcoes: [
      opcao("sim", "Cabine pressurizada é essencial", "Você precisa de cabine pressurizada", {
        meridian: 5,
        cheyenne: 4,
        citation: 4,
        hawker400a: 4,
      }),
      opcao(
        "indiferente",
        "Quero avaliar o melhor custo e benefício",
        "Você está aberto a diferentes experiências de cabine",
        { cirrus: 2, matrix: 2, seneca: 2, meridian: 2 },
      ),
    ],
  },
  {
    id: "seguranca",
    curto: "Preferência de configuração",
    titulo: "Tem alguma configuração que chama sua atenção?",
    ajuda:
      "É uma preferência para a nossa conversa. A recomendação não é uma classificação de segurança.",
    opcoes: [
      opcao(
        "dois-motores",
        "Prefiro uma aeronave com dois motores",
        "Você prefere a configuração bimotora",
        { seneca: 4, cheyenne: 4, citation: 3, hawker400a: 3 },
      ),
      opcao(
        "caps",
        "Tenho interesse no paraquedas do Cirrus",
        "O sistema CAPS do Cirrus chamou sua atenção",
        { cirrus: 4 },
      ),
      opcao(
        "indiferente",
        "Quero que a Share me ajude a escolher",
        "Você está aberto à orientação da Share",
        {},
      ),
    ],
  },
];
export function respostasCompletas(respostas) {
  return !!respostas && PERGUNTAS.every((p) => p.opcoes.some((o) => o.valor === respostas[p.id]));
}
export function descreverPerfil(respostas) {
  return PERGUNTAS.map((p) => ({
    pergunta: p.id,
    titulo: p.curto,
    rotulo: p.opcoes.find((o) => o.valor === respostas[p.id])?.rotulo || "Não informado",
  }));
}
export function recomendar(respostas) {
  if (!respostasCompletas(respostas))
    throw new Error("Responda todas as perguntas para ver seu perfil.");
  const pontos = Object.fromEntries(ORDEM_DESEMPATE.map((id) => [id, 0]));
  const contribuicoes = Object.fromEntries(ORDEM_DESEMPATE.map((id) => [id, []]));
  for (const p of PERGUNTAS) {
    const o = p.opcoes.find((o) => o.valor === respostas[p.id]);
    for (const [id, v] of Object.entries(o.pontos)) {
      pontos[id] += v;
      if (v > 0) contribuicoes[id].push({ valor: v, texto: o.resumo });
    }
  }
  const grupo = { "1-2": 2, "3-4": 4, "5-6": 6, 7: 7, "8+": 8 }[respostas.pax];
  const ranking = ORDEM_DESEMPATE.filter(
    (id) =>
      AERONAVES[id].limitePerfil >= grupo &&
      !(AERONAVES[id].familia === "jato" && ["terra", "misto"].includes(respostas.pista)) &&
      (respostas.conforto !== "sim" || AERONAVES[id].pressurizada),
  )
    .sort(
      (a, b) => pontos[b] - pontos[a] || ORDEM_DESEMPATE.indexOf(a) - ORDEM_DESEMPATE.indexOf(b),
    )
    .map((id) => ({ id, pontos: pontos[id] }));
  const principal = ranking[0]?.id || null;
  const avisos = [];
  if (["terra", "misto", "nao-sei"].includes(respostas.pista))
    avisos.push("Vamos analisar comprimento, superfície e condições das pistas dos seus destinos.");
  if (["longa", "muito-longa"].includes(respostas.distancia))
    avisos.push(
      "Rotas, bagagem e ocupação definem a autonomia disponível e a necessidade de escalas.",
    );
  if (principal && respostas.conforto === "sim" && !AERONAVES[principal].pressurizada)
    avisos.push(
      "Esta opção não tem cabine pressurizada. Vamos comparar essa preferência com as alternativas.",
    );
  if (principal && respostas.seguranca === "dois-motores" && AERONAVES[principal].motores === 1)
    avisos.push(
      "Esta opção é monomotora. Sua preferência por dois motores merece uma comparação personalizada.",
    );
  if (principal && respostas.seguranca === "caps" && principal !== "cirrus")
    avisos.push(
      "O interesse no CAPS será considerado na conversa; a opção sugerida não possui esse sistema.",
    );
  if (!principal)
    avisos.push(
      "O conjunto de passageiros, cabine e pistas precisa de uma avaliação personalizada. Nenhuma opção foi indicada automaticamente.",
    );
  return {
    principal,
    segunda: ranking[1]?.id || null,
    ranking,
    motivos: principal
      ? contribuicoes[principal]
          .sort((a, b) => b.valor - a.valor)
          .slice(0, 3)
          .map((x) => x.texto)
      : [],
    avisos,
  };
}
export function montarMensagem(respostas, resultado, contato = {}, protocolo = "") {
  return [
    "Olá! Fiz o quiz “Descubra sua aeronave” da Share Brasil e quero conhecer as cotas.",
    contato.nome ? `Nome: ${contato.nome}` : "",
    contato.telefone ? `WhatsApp: ${contato.telefone}` : "",
    contato.cidade ? `Cidade/base: ${contato.cidade}` : "",
    protocolo ? `Referência: ${protocolo}` : "",
    `Sugestão inicial: ${resultado.principal ? AERONAVES[resultado.principal].nome : "análise personalizada"}`,
    resultado.segunda ? `Alternativa: ${AERONAVES[resultado.segunda].nome}` : "",
    "",
    ...descreverPerfil(respostas).map((x) => `${x.titulo}: ${x.rotulo}`),
    contato.rotas ? `Rotas desejadas: ${contato.rotas}` : "",
    contato.momento ? `Momento: ${MOMENTOS[contato.momento] || contato.momento}` : "",
  ]
    .filter((x) => x !== "")
    .join("\n");
}
export function linkWhatsApp(respostas, resultado, contato, protocolo) {
  return `https://wa.me/${WHATSAPP_NUMERO}?text=${encodeURIComponent(montarMensagem(respostas, resultado, contato, protocolo))}`;
}
