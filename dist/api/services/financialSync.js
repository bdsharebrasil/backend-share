import { supabase } from '../lib/supabase';
/**
 * Sincroniza uma bank_reconciliation com controle_bancario e contas_areceber
 * ✅ SEGURO: Executado apenas no servidor
 */
export async function syncBankReconciliationToFinancial(reconciliationId, userId) {
    try {
        // Buscar a reconciliation com dados relacionados
        const { data: rec, error: recError } = await supabase
            .from("bank_reconciliations")
            .select(`
        *,
        clients:client_id(company_name, cnpj),
        aircraft:aircraft_id(registration),
        user_profiles:receiver_id(full_name)
      `)
            .eq("id", reconciliationId)
            .single();
        if (recError || !rec) {
            throw new Error("Reconciliação não encontrada");
        }
        let controleBancarioId;
        let contaAreceberId;
        // Determinar tipo de movimento baseado no type
        const tipoMovimento = rec.type === "cliente" ? "entrada" : "saída";
        const grupoCategoria = rec.type === "cliente" ? "Clientes" : "Colaboradores";
        // Criar registro no controle_bancario (fluxo de caixa)
        const descricaoBase = rec.type === "cliente"
            ? `Reembolso - ${rec.clients?.company_name || "Cliente"}${rec.aircraft?.registration ? ` (${rec.aircraft.registration})` : ""}`
            : `Pagamento - ${rec.user_profiles?.full_name || "Colaborador"}`;
        const referencia = `REC-${reconciliationId.slice(0, 8)}`;
        // Verificar se já existe um registro vinculado
        const { data: existing } = await supabase
            .from("controle_bancario")
            .select("id")
            .eq("referencia", referencia)
            .maybeSingle();
        if (!existing) {
            const { data: cbData, error: cbError } = await supabase
                .from("controle_bancario")
                .insert({
                data: rec.date,
                tipo_movimento: tipoMovimento,
                categoria: rec.category || (rec.type === "cliente" ? "Reembolso" : "Pagamento"),
                descricao: `${descricaoBase} - ${rec.description}`,
                valor: rec.amount,
                referencia,
                status: mapReconciliationStatusToFluxo(rec.status, rec.type),
                criado_por: userId,
                colaborador_id: rec.receiver_id || null,
                comprovante_url: rec.comprovante_url || null,
                observacoes: null,
                grupo_categoria: grupoCategoria,
                numero_documento: reconciliationId.slice(0, 8),
            })
                .select("id")
                .single();
            if (cbError) {
                console.error("Erro ao criar controle_bancario:", cbError);
            }
            else {
                controleBancarioId = cbData?.id;
                // Vincular o controle_bancario_id na bank_reconciliation
                await supabase
                    .from("bank_reconciliations")
                    .update({ controle_bancario_id: controleBancarioId })
                    .eq("id", reconciliationId);
            }
        }
        // Se é tipo cliente, criar conta a receber
        if (rec.type === "cliente" && rec.client_id) {
            const { data: existingConta } = await supabase
                .from("contas_areceber")
                .select("id")
                .like("numero", `%${reconciliationId.slice(0, 8)}%`)
                .maybeSingle();
            if (!existingConta) {
                const numeroDocumento = `REIMB-${reconciliationId.slice(0, 8)}`;
                const { data: contaData, error: contaError } = await supabase
                    .from("contas_areceber")
                    .insert({
                    numero: numeroDocumento,
                    referencia: rec.clients?.company_name || "Cliente",
                    cliente_nome: rec.clients?.company_name || "Cliente",
                    cliente_cnpj: rec.clients?.cnpj || "",
                    data_criacao: rec.date,
                    data_vencimento: rec.payment_term || rec.date,
                    valor: rec.amount,
                    categoria: rec.category || "Reembolso de Despesa",
                    descricao: rec.description,
                    status: rec.status === "recebido" ? "recebido" : "pendente",
                    arquivo_pdf_url: rec.nf_url || null,
                    aeronave: rec.aircraft?.registration || "",
                    criado_por: userId,
                })
                    .select("id")
                    .single();
                if (contaError) {
                    console.error("Erro ao criar conta a receber:", contaError);
                }
                else {
                    contaAreceberId = contaData?.id;
                }
            }
        }
        return {
            success: true,
            controleBancarioId,
            contaAreceberId,
        };
    }
    catch (error) {
        console.error("Erro na sincronização financeira:", error);
        return {
            success: false,
            error: error.message,
        };
    }
}
// Função auxiliar para buscar categoria_id (NÃO cria novas categorias)
// Usa busca case-insensitive para evitar duplicatas
async function getCategoriaId(nomeCategoria, userId) {
    try {
        if (!userId) {
            console.error(`❌ Erro: userId não fornecido para buscar categoria "${nomeCategoria}"`);
            return null;
        }
        console.log(`🔍 Buscando categoria: "${nomeCategoria}"`);
        // Busca case-insensitive para encontrar categorias existentes
        const { data, error } = await supabase
            .from("categorias_movimentacao")
            .select("id, nome")
            .ilike("nome", nomeCategoria)
            .eq("grupo_categoria", "FOLHA DE PAGAMENTO")
            .eq("ativo", true)
            .limit(1)
            .maybeSingle();
        if (error) {
            console.error(`❌ Erro ao buscar categoria "${nomeCategoria}":`, {
                message: error.message,
                code: error.code,
                details: error.details,
                hint: error.hint
            });
            return null;
        }
        if (!data) {
            // NÃO criar novas categorias - apenas logar aviso
            console.warn(`⚠️ Categoria "${nomeCategoria}" não encontrada no grupo FOLHA DE PAGAMENTO.`);
            console.warn(`📋 Verifique se as categorias de folha de pagamento estão cadastradas corretamente.`);
            return null;
        }
        console.log(`✅ Categoria "${nomeCategoria}" encontrada: ${data.nome} (${data.id})`);
        return data.id;
    }
    catch (error) {
        console.error(`❌ Exceção ao buscar categoria "${nomeCategoria}":`, {
            message: error?.message || String(error),
            stack: error?.stack
        });
        return null;
    }
}
export async function syncSalaryPaymentToFinancial(paymentId, userId, employeeName, employeeId, paymentData) {
    console.log("🔄 Sincronizando pagamento de", employeeName);
    try {
        // 1. Mapear cada tipo de salário para sua categoria correspondente
        const categoriasMap = {
            holerite: "Salários Holerite",
            beneficio: "Cartão Benefício",
            horasVoo: "Pagamento de Horas de Voo",
            extra: "Bônus ou Extra",
            decimoTerceiro: "Décimo Terceiro Salário",
            ferias: "Pagamento de Férias"
        };
        // 2. Pré-carregar todos os IDs das categorias
        const categoriasIds = {};
        let todasCategoriasFalharam = false;
        for (const [key, nome] of Object.entries(categoriasMap)) {
            categoriasIds[key] = await getCategoriaId(nome, userId);
            if (!categoriasIds[key]) {
                console.warn(`⚠️ Categoria "${nome}" não pôde ser obtida`);
                todasCategoriasFalharam = true;
            }
        }
        // Se todas as categorias falharem, mostrar instrução clara
        if (todasCategoriasFalharam && Object.values(categoriasIds).every(id => !id)) {
            const mensagemErro = `
╔════════════════════════════════════════════════════════════════════╗
║         ❌ ERRO: CATEGORIAS DE SALÁRIO NÃO ENCONTRADAS           ║
╠════════════════════════════════════════════════════════════════════╣
║                                                                    ║
║  As categorias necessárias não existem no banco de dados.         ║
║                                                                    ║
║  📋 SOLUÇÃO:                                                       ║
║  1. Acesse: https://app.supabase.com → Seu Projeto               ║
║  2. Vá para: SQL Editor                                           ║
║  3. Cole o script abaixo e execute:                              ║
║                                                                    ║
║  INSERT INTO public.categorias_movimentacao                       ║
║    (nome, tipo, grupo_categoria, descricao, ativo)               ║
║  VALUES                                                            ║
║    ('Salários Holerite', 'despesa', 'FOLHA DE PAGAMENTO', ...), ║
║    ('Cartão Benefício', 'despesa', 'FOLHA DE PAGAMENTO', ...),  ║
║    ('Pagamento de Horas de Voo', 'despesa', 'FOLHA DE PAGAM...║
║    ('Bônus ou Extra', 'despesa', 'FOLHA DE PAGAMENTO', ...),   ║
║    ('Décimo Terceiro Salário', 'despesa', 'FOLHA DE PAGAM...    ║
║    ('Pagamento de Férias', 'despesa', 'FOLHA DE PAGAMENTO', ..);║
║  ON CONFLICT (nome) DO NOTHING;                                  ║
║                                                                    ║
║  📄 Arquivo completo: CREATE_SALARY_CATEGORIES.sql               ║
║                                                                    ║
╚════════════════════════════════════════════════════════════════════╝
      `;
            console.error(mensagemErro);
            return {
                success: false,
                error: `Categorias de salário não encontradas. Execute CREATE_SALARY_CATEGORIES.sql no Supabase.`
            };
        }
        // 2. Preparar movimentações
        const entries = [];
        const errors = [];
        const hoje = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
        const dataPagamento = paymentData.data_pagamento || hoje;
        // Salário Base (Holerite)
        if (paymentData.base_salary_holerite && paymentData.base_salary_holerite > 0) {
            const categoriaId = categoriasIds["holerite"];
            if (!categoriaId) {
                errors.push({ tipo: "Salário Holerite", error: "Categoria não encontrada" });
            }
            else {
                console.log(`💰 Criando movimentação Salário Holerite: R$ ${paymentData.base_salary_holerite}`);
                const entry = {
                    data: dataPagamento,
                    tipo_movimento: "saida",
                    categoria_id: categoriaId,
                    descricao: `Salário Holerite - ${employeeName}`,
                    valor: paymentData.base_salary_holerite,
                    conta_banco: paymentData.banco || null,
                    numero_documento: `SAL-${paymentId}`,
                    status: "pago",
                    colaborador_id: employeeId,
                    criado_por: userId,
                    grupo_categoria: "FOLHA DE PAGAMENTO",
                    comprovante_url: paymentData.comprovante_url || null,
                    observacoes: paymentData.obs || null,
                };
                const { data: inserted, error } = await supabase
                    .from("controle_bancario")
                    .insert(entry)
                    .select("id");
                if (error) {
                    console.error("❌ Erro ao criar movimentação Salário Holerite:", error);
                    errors.push({ tipo: "Salário Holerite", error: error.message, details: error });
                }
                else {
                    console.log("✅ Salário Holerite criado no controle_bancario:", inserted);
                    entries.push(inserted[0]);
                }
            }
        }
        // Horas de Voo (Tripulação)
        if (paymentData.horas_voo && parseFloat(paymentData.horas_voo) > 0) {
            const categoriaId = categoriasIds["horasVoo"];
            if (!categoriaId) {
                errors.push({ tipo: "Tripulação - Horas de Voo", error: "Categoria não encontrada" });
            }
            else {
                console.log(`✈️ Criando movimentação Tripulação - Horas de Voo: R$ ${paymentData.horas_voo}`);
                const entry = {
                    data: dataPagamento,
                    tipo_movimento: "saida",
                    categoria_id: categoriaId,
                    descricao: `Tripulação - Horas de Voo - ${employeeName}`,
                    valor: parseFloat(paymentData.horas_voo),
                    conta_banco: paymentData.banco || null,
                    numero_documento: `HORAS-${paymentId}`,
                    status: "pago",
                    colaborador_id: employeeId,
                    criado_por: userId,
                    grupo_categoria: "FOLHA DE PAGAMENTO",
                    comprovante_url: paymentData.comprovante_url || null,
                    observacoes: paymentData.obs || null,
                };
                const { data: inserted, error } = await supabase
                    .from("controle_bancario")
                    .insert(entry)
                    .select("id");
                if (error) {
                    console.error("❌ Erro ao criar movimentação Tripulação - Horas de Voo:", error);
                    errors.push({ tipo: "Tripulação - Horas de Voo", error: error.message, details: error });
                }
                else {
                    console.log("✅ Tripulação - Horas de Voo criadas no controle_bancario:", inserted);
                    entries.push(inserted[0]);
                }
            }
        }
        // Benefício
        if (paymentData.benefit && parseFloat(paymentData.benefit) > 0) {
            const categoriaId = categoriasIds["beneficio"];
            if (!categoriaId) {
                errors.push({ tipo: "Salários Benefício", error: "Categoria não encontrada" });
            }
            else {
                console.log(`🎁 Criando movimentação Salários Benefício: R$ ${paymentData.benefit}`);
                const entry = {
                    data: dataPagamento,
                    tipo_movimento: "saida",
                    categoria_id: categoriaId,
                    descricao: `Salários Benefício - ${employeeName}`,
                    valor: parseFloat(paymentData.benefit),
                    conta_banco: paymentData.banco || null,
                    numero_documento: `BEN-${paymentId}`,
                    status: "pago",
                    colaborador_id: employeeId,
                    criado_por: userId,
                    grupo_categoria: "FOLHA DE PAGAMENTO",
                    comprovante_url: paymentData.comprovante_url || null,
                    observacoes: paymentData.obs || null,
                };
                const { data: inserted, error } = await supabase
                    .from("controle_bancario")
                    .insert(entry)
                    .select("id");
                if (error) {
                    console.error("❌ Erro ao criar movimentação Salários Benefício:", error);
                    errors.push({ tipo: "Salários Benefício", error: error.message, details: error });
                }
                else {
                    console.log("✅ Salários Benefício criado no controle_bancario:", inserted);
                    entries.push(inserted[0]);
                }
            }
        }
        // Extra
        if (paymentData.extra && parseFloat(paymentData.extra) > 0) {
            const categoriaId = categoriasIds["extra"];
            if (!categoriaId) {
                errors.push({ tipo: "Salários Extras e Adicionais", error: "Categoria não encontrada" });
            }
            else {
                console.log(`➕ Criando movimentação Salários Extras e Adicionais: R$ ${paymentData.extra}`);
                const entry = {
                    data: dataPagamento,
                    tipo_movimento: "saida",
                    categoria_id: categoriaId,
                    descricao: `Salários Extras e Adicionais - ${employeeName}`,
                    valor: parseFloat(paymentData.extra),
                    conta_banco: paymentData.banco || null,
                    numero_documento: `EXTRA-${paymentId}`,
                    status: "pago",
                    colaborador_id: employeeId,
                    criado_por: userId,
                    grupo_categoria: "FOLHA DE PAGAMENTO",
                    comprovante_url: paymentData.comprovante_url || null,
                    observacoes: paymentData.obs || null,
                };
                const { data: inserted, error } = await supabase
                    .from("controle_bancario")
                    .insert(entry)
                    .select("id");
                if (error) {
                    console.error("❌ Erro ao criar movimentação Salários Extras e Adicionais:", error);
                    errors.push({ tipo: "Salários Extras e Adicionais", error: error.message, details: error });
                }
                else {
                    console.log("✅ Salários Extras e Adicionais criado no controle_bancario:", inserted);
                    entries.push(inserted[0]);
                }
            }
        }
        // Férias
        if (paymentData.ferias && paymentData.ferias > 0) {
            const categoriaId = categoriasIds["ferias"];
            if (!categoriaId) {
                errors.push({ tipo: "Férias", error: "Categoria não encontrada" });
            }
            else {
                console.log(`🏖️ Criando movimentação Férias: R$ ${paymentData.ferias}`);
                const entry = {
                    data: dataPagamento,
                    tipo_movimento: "saida",
                    categoria_id: categoriaId,
                    descricao: `Férias - ${employeeName}`,
                    valor: paymentData.ferias,
                    conta_banco: paymentData.banco || null,
                    numero_documento: `FER-${paymentId}`,
                    status: "pago",
                    colaborador_id: employeeId,
                    criado_por: userId,
                    grupo_categoria: "FOLHA DE PAGAMENTO",
                    comprovante_url: paymentData.comprovante_url || null,
                    observacoes: paymentData.obs || null,
                };
                const { data: inserted, error } = await supabase
                    .from("controle_bancario")
                    .insert(entry)
                    .select("id");
                if (error) {
                    console.error("❌ Erro ao criar movimentação Férias:", error);
                    errors.push({ tipo: "Férias", error: error.message, details: error });
                }
                else {
                    console.log("✅ Férias criadas no controle_bancario:", inserted);
                    entries.push(inserted[0]);
                }
            }
        }
        // 13º Salário - Parcela 1
        if (paymentData.decimo_terceiro_parcela1 && paymentData.decimo_terceiro_parcela1 > 0) {
            const categoriaId = categoriasIds["decimoTerceiro"];
            if (!categoriaId) {
                errors.push({ tipo: "13º Salário Parcela 1", error: "Categoria não encontrada" });
            }
            else {
                console.log(`🎄 Criando movimentação 13º Salário Parcela 1: R$ ${paymentData.decimo_terceiro_parcela1}`);
                const entry = {
                    data: dataPagamento,
                    tipo_movimento: "saida",
                    categoria_id: categoriaId,
                    descricao: `Salário Décimo Terceiro - 1ª Parcela - ${employeeName}`,
                    valor: paymentData.decimo_terceiro_parcela1,
                    conta_banco: paymentData.banco || null,
                    numero_documento: `13P1-${paymentId}`,
                    status: "pago",
                    colaborador_id: employeeId,
                    criado_por: userId,
                    grupo_categoria: "FOLHA DE PAGAMENTO",
                    comprovante_url: paymentData.comprovante_url || null,
                    observacoes: paymentData.obs || null,
                };
                const { data: inserted, error } = await supabase
                    .from("controle_bancario")
                    .insert(entry)
                    .select("id");
                if (error) {
                    console.error("❌ Erro ao criar movimentação 13º P1:", error);
                    errors.push({ tipo: "13º Salário Parcela 1", error: error.message, details: error });
                }
                else {
                    console.log("✅ 13º Salário Parcela 1 criado no controle_bancario:", inserted);
                    entries.push(inserted[0]);
                }
            }
        }
        // 13º Salário - Parcela 2
        if (paymentData.decimo_terceiro_parcela2 && paymentData.decimo_terceiro_parcela2 > 0) {
            const categoriaId = categoriasIds["decimoTerceiro"];
            if (!categoriaId) {
                errors.push({ tipo: "13º Salário Parcela 2", error: "Categoria não encontrada" });
            }
            else {
                console.log(`🎁 Criando movimentação 13º Salário Parcela 2: R$ ${paymentData.decimo_terceiro_parcela2}`);
                const entry = {
                    data: dataPagamento,
                    tipo_movimento: "saida",
                    categoria_id: categoriasIds["decimoTerceiro"],
                    descricao: `Salário Décimo Terceiro - 2ª Parcela - ${employeeName}`,
                    valor: paymentData.decimo_terceiro_parcela2,
                    conta_banco: paymentData.banco || null,
                    numero_documento: `13P2-${paymentId}`,
                    status: "pago",
                    colaborador_id: employeeId,
                    criado_por: userId,
                    grupo_categoria: "FOLHA DE PAGAMENTO",
                    comprovante_url: paymentData.comprovante_url || null,
                    observacoes: paymentData.obs || null,
                };
                const { data: inserted, error } = await supabase
                    .from("controle_bancario")
                    .insert(entry)
                    .select("id");
                if (error) {
                    console.error("❌ Erro ao criar movimentação 13º P2:", error);
                    errors.push({ tipo: "13º Salário Parcela 2", error: error.message, details: error });
                }
                else {
                    console.log("✅ 13º Salário Parcela 2 criado no controle_bancario:", inserted);
                    entries.push(inserted[0]);
                }
            }
        }
        // Resultado final
        if (entries.length === 0) {
            console.warn(`⚠️ AVISO: Nenhuma movimentação foi criada para o pagamento ${paymentId}`);
        }
        if (errors.length > 0) {
            console.error(`❌ ${errors.length} erro(s) ao criar movimentações de salário`);
            return {
                success: false,
                error: `${errors.length} erro(s) ao sincronizar`,
                details: { entries, errors }
            };
        }
        console.log(`✅ Sincronização concluída! ${entries.length} movimentação(ões) criada(s)`);
        return {
            success: true,
            details: { entries, errors: [] }
        };
    }
    catch (error) {
        console.error("❌ Exceção em syncSalaryPaymentToFinancial:", error);
        return {
            success: false,
            error: error.message || "Erro desconhecido",
            details: error
        };
    }
}
export async function deleteSalaryPaymentFromFinancial(paymentId) {
    console.log(`🗑️ Deletando movimentações do pagamento ${paymentId}`);
    try {
        const { error } = await supabase
            .from("controle_bancario")
            .delete()
            .like("numero_documento", `%-${paymentId}`);
        if (error) {
            console.error("❌ Erro ao deletar movimentações:", error);
            throw error;
        }
        console.log("✅ Movimentações deletadas com sucesso");
    }
    catch (error) {
        console.error("❌ Exceção ao deletar:", error);
        throw error;
    }
}
/**
 * Deleta registros do fluxo de caixa vinculados a uma reconciliação
 */
export async function deleteReconciliationFromFinancial(reconciliationId) {
    try {
        const referencia = `REC-${reconciliationId.slice(0, 8)}`;
        await supabase
            .from("controle_bancario")
            .delete()
            .eq("referencia", referencia);
        // Também deletar conta a receber vinculada
        await supabase
            .from("contas_areceber")
            .delete()
            .like("numero", `%${reconciliationId.slice(0, 8)}%`);
    }
    catch (error) {
        console.error("Erro ao deletar reconciliação do fluxo de caixa:", error);
    }
}
/**
 * Mapeia status da reconciliação para status do fluxo de caixa
 */
function mapReconciliationStatusToFluxo(status, type) {
    if (type === "cliente") {
        switch (status) {
            case "recebido":
                return "confirmado";
            case "enviado":
                return "pendente";
            default:
                return "pendente";
        }
    }
    else {
        // colaborador
        switch (status) {
            case "pago":
                return "confirmado";
            case "enviado":
                return "pendente";
            default:
                return "pendente";
        }
    }
}
//# sourceMappingURL=financialSync.js.map