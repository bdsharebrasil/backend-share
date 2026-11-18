export type TipoItemChecklist = "check" | "oleo" | "abastecimento" | "documentos";

export type ItemChecklist = {
  id: string;
  label: string;
  tipo?: TipoItemChecklist;
  somenteAeronaves?: string[];
};

export type SecaoChecklist = {
  id: string;
  titulo: string;
  subtitulo: string;
  itens: ItemChecklist[];
};

export const SECOES_CHECKLIST: SecaoChecklist[] = [
  {
    id: "coordenacao",
    titulo: "Coordenação de voo",
    subtitulo: "Planejamento, documentação e preparação da missão",
    itens: [
      { id: "plano_voo", label: "Plano de voo conferido" },
      { id: "documentacao_aeronave", label: "Documentação da aeronave atualizada", tipo: "documentos" },
      { id: "comissaria", label: "Comissaria e comissaria reserva" },
      { id: "ipads", label: "iPad: bateria, atualização e sincronização" },
      { id: "cartoes", label: "Cartões e dados da aeronave atualizados" },
      { id: "notam", label: "NOTAM e meteorologia avaliados" },
      { id: "reservas", label: "Reservas de hotel e logística confirmadas" },
    ],
  },
  {
    id: "despachante",
    titulo: "Despachante — check externo",
    subtitulo: "Combustível, fluidos e itens externos da aeronave",
    itens: [
      { id: "abastecimento", label: "Abastecimento verificado", tipo: "abastecimento" },
      { id: "nivel_oleo", label: "Nível de óleo LH / RH", tipo: "oleo" },
      { id: "oleo_reserva", label: "Óleo reserva disponível" },
      { id: "estacas", label: "Estacas e corda a bordo" },
      { id: "funil", label: "Funil de óleo disponível" },
      { id: "protetores", label: "Protetores dos motores removidos e guardados" },
      { id: "pitot", label: "Capa do pitot removida e guardada" },
      { id: "calcos", label: "Calços retirados e guardados" },
      { id: "dreno", label: "Dreno de combustível realizado" },
      { id: "tampas", label: "Tampas de óleo e combustível conferidas" },
    ],
  },
  {
    id: "interno",
    titulo: "Aeronave — check interno",
    subtitulo: "Cabine, equipamentos, segurança e comissaria",
    itens: [
      { id: "docs_bordo", label: "Documentos presentes na aeronave", tipo: "documentos" },
      { id: "headsets", label: "Headsets testados e pilhas conferidas" },
      { id: "lanterna", label: "Lanterna funcionando e pilhas reservas" },
      { id: "papeis", label: "Papéis, canetas e prancheta" },
      { id: "limpeza", label: "Limpeza interna realizada" },
      { id: "toalha", label: "Toalha de rosto e almofada disponíveis" },
      { id: "primeiros_socorros", label: "Primeiros socorros e itens de toalete" },
      { id: "extintor", label: "Extintor a bordo e dentro da validade" },
      { id: "dados", label: "Atualização de dados conferida" },
      { id: "parabrisas", label: "Capa de para-brisas removida e guardada" },
      { id: "bebidas", label: "Comissaria a bordo e bebidas com gelo" },
      { id: "chaves", label: "Chaves entregues à tripulação" },
    ],
  },
  {
    id: "seguranca",
    titulo: "Segurança e documentação crítica",
    subtitulo: "Itens que devem estar presentes antes da partida",
    itens: [
      { id: "ca", label: "Certificado de Aeronavegabilidade (CA)", tipo: "documentos" },
      { id: "cm", label: "Certificado de Matrícula (CM)", tipo: "documentos" },
      { id: "diario", label: "Diário de bordo", tipo: "documentos" },
      { id: "seguro", label: "Apólice de seguro Reta vigente", tipo: "documentos" },
      { id: "cva", label: "CVA vigente", tipo: "documentos" },
      { id: "cinto", label: "Cintos de segurança conferidos" },
      { id: "elt", label: "ELT — transmissor localizador de emergência" },
      { id: "extintor_seg", label: "Extintor com peso dentro do arco verde" },
    ],
  },
];

export const TOTAL_ITENS_CHECKLIST = SECOES_CHECKLIST.reduce((total, secao) => total + secao.itens.length, 0);

export type RespostaChecklist = { status: "feito" | "alerta" | "nao_feito"; observacao?: string };
export type RespostasChecklist = Record<string, RespostaChecklist>;

