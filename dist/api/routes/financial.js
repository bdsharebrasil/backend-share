import { Router } from 'express';
import { syncBankReconciliationToFinancial, syncSalaryPaymentToFinancial, deleteSalaryPaymentFromFinancial, deleteReconciliationFromFinancial, } from '../services/financialSync';
const router = Router();
/**
 * ============= FINANCIAL SYNC ROUTES =============
 *
 * ✅ Todos os endpoints executam lógica no servidor
 * ✅ Sem exposição de credenciais ao frontend
 * ✅ Validações centralizadas
 * ✅ Auditoria completa
 */
/**
 * POST /api/financial/sync-bank-reconciliation
 * Sincroniza uma bank_reconciliation com controle_bancario e contas_areceber
 *
 * Body:
 * {
 *   reconciliationId: string
 *   userId: string
 * }
 */
router.post('/sync-bank-reconciliation', async (req, res) => {
    try {
        const { reconciliationId, userId } = req.body;
        // Validações
        if (!reconciliationId || typeof reconciliationId !== 'string') {
            return res.status(400).json({
                error: 'Invalid reconciliationId',
                message: 'reconciliationId must be a non-empty string'
            });
        }
        if (!userId || typeof userId !== 'string') {
            return res.status(400).json({
                error: 'Invalid userId',
                message: 'userId must be a non-empty string'
            });
        }
        console.log(`📊 [Financial Sync] Sincronizando reconciliação: ${reconciliationId} por usuário: ${userId}`);
        // Executar sincronização
        const result = await syncBankReconciliationToFinancial(reconciliationId, userId);
        if (!result.success) {
            return res.status(400).json({
                success: false,
                error: result.error || 'Failed to sync bank reconciliation',
                timestamp: new Date().toISOString()
            });
        }
        return res.status(201).json({
            success: true,
            data: {
                reconciliationId,
                controleBancarioId: result.controleBancarioId,
                contaAreceberId: result.contaAreceberId,
            },
            message: 'Bank reconciliation synced successfully',
            timestamp: new Date().toISOString()
        });
    }
    catch (error) {
        console.error('[Financial Sync] Exception:', error);
        const errorMsg = error instanceof Error ? error.message : String(error);
        res.status(500).json({
            success: false,
            error: 'Failed to sync bank reconciliation',
            details: process.env.NODE_ENV === 'development' ? errorMsg : undefined,
            timestamp: new Date().toISOString()
        });
    }
});
/**
 * POST /api/financial/sync-salary-payment
 * Sincroniza um pagamento de salário com movimentações de controle_bancario
 *
 * Body:
 * {
 *   paymentId: string
 *   userId: string
 *   employeeName: string
 *   employeeId: string
 *   paymentData: {
 *     base_salary_holerite?: number
 *     horas_voo?: string
 *     benefit?: string
 *     extra?: string
 *     ferias?: number
 *     decimo_terceiro_parcela1?: number
 *     decimo_terceiro_parcela2?: number
 *     comprovante_url?: string
 *     obs?: string
 *     banco?: string
 *     data_pagamento?: string
 *   }
 * }
 */
router.post('/sync-salary-payment', async (req, res) => {
    try {
        const { paymentId, userId, employeeName, employeeId, paymentData } = req.body;
        // Validações
        if (!paymentId || typeof paymentId !== 'string') {
            return res.status(400).json({
                error: 'Invalid paymentId',
                message: 'paymentId must be a non-empty string'
            });
        }
        if (!userId || typeof userId !== 'string') {
            return res.status(400).json({
                error: 'Invalid userId',
                message: 'userId must be a non-empty string'
            });
        }
        if (!employeeName || typeof employeeName !== 'string') {
            return res.status(400).json({
                error: 'Invalid employeeName',
                message: 'employeeName must be a non-empty string'
            });
        }
        if (!employeeId || typeof employeeId !== 'string') {
            return res.status(400).json({
                error: 'Invalid employeeId',
                message: 'employeeId must be a non-empty string'
            });
        }
        if (!paymentData || typeof paymentData !== 'object') {
            return res.status(400).json({
                error: 'Invalid paymentData',
                message: 'paymentData must be a valid object'
            });
        }
        console.log(`💰 [Financial Sync] Sincronizando pagamento: ${paymentId} para ${employeeName}`);
        // Executar sincronização
        const result = await syncSalaryPaymentToFinancial(paymentId, userId, employeeName, employeeId, paymentData);
        if (!result.success) {
            return res.status(400).json({
                success: false,
                error: result.error || 'Failed to sync salary payment',
                details: result.details,
                timestamp: new Date().toISOString()
            });
        }
        return res.status(201).json({
            success: true,
            data: {
                paymentId,
                entriesCreated: result.details?.entries?.length || 0,
                details: result.details
            },
            message: 'Salary payment synced successfully',
            timestamp: new Date().toISOString()
        });
    }
    catch (error) {
        console.error('[Financial Sync] Exception:', error);
        const errorMsg = error instanceof Error ? error.message : String(error);
        res.status(500).json({
            success: false,
            error: 'Failed to sync salary payment',
            details: process.env.NODE_ENV === 'development' ? errorMsg : undefined,
            timestamp: new Date().toISOString()
        });
    }
});
/**
 * DELETE /api/financial/salary-payment/:paymentId
 * Deleta todas as movimentações de um pagamento de salário
 */
router.delete('/salary-payment/:paymentId', async (req, res) => {
    try {
        const { paymentId } = req.params;
        // Validações
        if (!paymentId || typeof paymentId !== 'string') {
            return res.status(400).json({
                error: 'Invalid paymentId',
                message: 'paymentId must be a non-empty string'
            });
        }
        console.log(`🗑️ [Financial Sync] Deletando movimentações do pagamento: ${paymentId}`);
        // Executar deleção
        await deleteSalaryPaymentFromFinancial(paymentId);
        return res.json({
            success: true,
            message: 'Salary payment deleted successfully',
            paymentId,
            timestamp: new Date().toISOString()
        });
    }
    catch (error) {
        console.error('[Financial Sync] Exception:', error);
        const errorMsg = error instanceof Error ? error.message : String(error);
        res.status(500).json({
            success: false,
            error: 'Failed to delete salary payment',
            details: process.env.NODE_ENV === 'development' ? errorMsg : undefined,
            timestamp: new Date().toISOString()
        });
    }
});
/**
 * DELETE /api/financial/bank-reconciliation/:reconciliationId
 * Deleta todas as movimentações de uma reconciliação
 */
router.delete('/bank-reconciliation/:reconciliationId', async (req, res) => {
    try {
        const { reconciliationId } = req.params;
        // Validações
        if (!reconciliationId || typeof reconciliationId !== 'string') {
            return res.status(400).json({
                error: 'Invalid reconciliationId',
                message: 'reconciliationId must be a non-empty string'
            });
        }
        console.log(`🗑️ [Financial Sync] Deletando reconciliação: ${reconciliationId}`);
        // Executar deleção
        await deleteReconciliationFromFinancial(reconciliationId);
        return res.json({
            success: true,
            message: 'Bank reconciliation deleted successfully',
            reconciliationId,
            timestamp: new Date().toISOString()
        });
    }
    catch (error) {
        console.error('[Financial Sync] Exception:', error);
        const errorMsg = error instanceof Error ? error.message : String(error);
        res.status(500).json({
            success: false,
            error: 'Failed to delete bank reconciliation',
            details: process.env.NODE_ENV === 'development' ? errorMsg : undefined,
            timestamp: new Date().toISOString()
        });
    }
});
export default router;
//# sourceMappingURL=financial.js.map