import { supabase } from "@/integrations/supabase/client";

/* =====================================================
   TIPOS
===================================================== */

export interface CategoriaMovimentacao {
  id: string;
  nome: string;
  grupo_categoria: string | null;
  cor?: string | null;
  icone?: string | null;
  descricao?: string | null;
}

export interface BankReconciliation {
  id: string;
  date: string;
  description: string;
  amount: number;
  status: string;
  category: string | null;
  payment_term: string | null;
  percentual: string | null;
  boleto_url?: string | null;
  nf_url?: string | null;
  pdf_url?: string | null;
  reference_type?: string | null;
  reference_id?: string | null;
  categorias_movimentacao?: CategoriaMovimentacao | null;
  receipt_data?: any;
}

export interface ClientPortalTotals {
  pendente: number;
  enviado: number;
  recebido: number;
}

/* =====================================================
   SERVICE PRINCIPAL
===================================================== */

export async function loadClientPortalData(
  clientId: string,
  aircraftId: string
): Promise<{
  reconciliations: BankReconciliation[];
  totals: ClientPortalTotals;
  success: boolean;
}> {
  try {
    /* -----------------------------------------------
       1. CATEGORIAS (MAPEADAS PELO NOME)
    ------------------------------------------------ */
    const { data: categorias, error: catError } = await supabase
      .from("categorias_movimentacao")
      .select("id, nome, grupo_categoria, cor, icone, descricao")
      .eq("ativo", true);

    if (catError) throw catError;

    const categoriaMap = new Map<string, CategoriaMovimentacao>();
    (categorias || []).forEach((cat) => {
      categoriaMap.set(cat.nome, cat);
    });

    /* -----------------------------------------------
       2. CONCILIAÇÕES
    ------------------------------------------------ */
    const { data: reconciliations, error: recError } = await supabase
      .from("bank_reconciliations")
      .select("*")
      .eq("client_id", clientId)
      .eq("aircraft_id", aircraftId)
      .eq("type", "cliente")
      .order("date", { ascending: false });

    if (recError) throw recError;

    /* -----------------------------------------------
       3. ENRIQUECER DADOS
    ------------------------------------------------ */
    const enriched: BankReconciliation[] = await Promise.all(
      (reconciliations || []).map(async (rec: any) => {
        const categoria = rec.category
          ? categoriaMap.get(rec.category)
          : null;

        let receipt = null;
        if (rec.reference_type === "receipt" && rec.reference_id) {
          const { data } = await supabase
            .from("receipts")
            .select("*")
            .eq("id", rec.reference_id)
            .single();
          receipt = data;
        }

        return {
          ...rec,
          categorias_movimentacao: categoria
            ? {
              ...categoria,
              grupo_categoria: "Reembolso", // REGRA FIXA
            }
            : null,
          receipt_data: receipt,
        };
      })
    );

    /* -----------------------------------------------
       4. TOTAIS (SEMPRE PELO VALOR DO CLIENTE)
    ------------------------------------------------ */
    const totals: ClientPortalTotals = {
      pendente: enriched
        .filter((r) => r.status === "pendente")
        .reduce((s, r) => s + Number(r.amount || 0), 0),

      enviado: enriched
        .filter((r) => r.status === "enviado")
        .reduce((s, r) => s + Number(r.amount || 0), 0),

      recebido: enriched
        .filter((r) => r.status === "recebido")
        .reduce((s, r) => s + Number(r.amount || 0), 0),
    };

    return {
      reconciliations: enriched,
      totals,
      success: true,
    };
  } catch (error) {
    console.error("Erro no clientPortal.service:", error);
    return {
      reconciliations: [],
      totals: { pendente: 0, enviado: 0, recebido: 0 },
      success: false,
    };
  }
}

/* =====================================================
   DETALHES DE UM REEMBOLSO
===================================================== */

export async function getReembolsoDetails(reconciliationId: string) {
  try {
    const { data: rec, error } = await supabase
      .from("bank_reconciliations")
      .select("*")
      .eq("id", reconciliationId)
      .single();

    if (error) throw error;

    const { data: categoria } = await supabase
      .from("categorias_movimentacao")
      .select("id, nome, grupo_categoria, cor, icone, descricao")
      .eq("nome", rec.category)
      .single();

    let receipt = null;
    if (rec.reference_type === "receipt" && rec.reference_id) {
      const { data } = await supabase
        .from("receipts")
        .select("*")
        .eq("id", rec.reference_id)
        .single();
      receipt = data;
    }

    return {
      reconciliation: {
        ...rec,
        categorias_movimentacao: categoria
          ? { ...categoria, grupo_categoria: "Reembolso" }
          : null,
      },
      receipt,
      success: true,
    };
  } catch (error) {
    console.error("Erro ao buscar detalhes do reembolso:", error);
    return {
      reconciliation: null,
      receipt: null,
      success: false,
    };
  }
}

/* =====================================================
   DOWNLOAD DE ARQUIVOS
===================================================== */

export async function downloadFileFromUrl(
  url: string,
  fileName: string
): Promise<{ success: boolean }> {
  try {
    if (!url) throw new Error("URL inválida");

    // URL pública
    if (url.startsWith("http")) {
      const response = await fetch(url);
      if (!response.ok) throw new Error("Erro ao baixar arquivo");

      const blob = await response.blob();
      const downloadUrl = URL.createObjectURL(blob);

      const a = document.createElement("a");
      a.href = downloadUrl;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(downloadUrl);

      return { success: true };
    }

    // Supabase storage
    const { data, error } = await supabase.storage
      .from("n.f-boletos-clients")
      .download(url);

    if (error) throw error;

    const downloadUrl = URL.createObjectURL(data);
    const a = document.createElement("a");
    a.href = downloadUrl;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(downloadUrl);

    return { success: true };
  } catch (error) {
    console.error("Erro no download:", error);
    return { success: false };
  }
}
