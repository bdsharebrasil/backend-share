interface SyncResult {
    success: boolean;
    controleBancarioId?: string;
    contaAreceberId?: string;
    error?: string;
}
interface SalaryPaymentData {
    base_salary_holerite?: number | null;
    horas_voo?: string | null;
    benefit?: string | null;
    extra?: string | null;
    ferias?: number | null;
    decimo_terceiro_parcela1?: number | null;
    decimo_terceiro_parcela2?: number | null;
    comprovante_url?: string | null;
    obs?: string | null;
    banco?: string | null;
    data_pagamento?: string | null;
}
/**
 * Sincroniza uma bank_reconciliation com controle_bancario e contas_areceber
 * ✅ SEGURO: Executado apenas no servidor
 */
export declare function syncBankReconciliationToFinancial(reconciliationId: string, userId: string): Promise<SyncResult>;
export declare function syncSalaryPaymentToFinancial(paymentId: string, userId: string, employeeName: string, employeeId: string, paymentData: SalaryPaymentData): Promise<{
    success: boolean;
    error?: string;
    details?: any;
}>;
export declare function deleteSalaryPaymentFromFinancial(paymentId: string): Promise<void>;
/**
 * Deleta registros do fluxo de caixa vinculados a uma reconciliação
 */
export declare function deleteReconciliationFromFinancial(reconciliationId: string): Promise<void>;
export {};
//# sourceMappingURL=financialSync.d.ts.map