import { Router, Request, Response } from 'express';
import {
  syncBankReconciliationToFinancial,
  syncSalaryPaymentToFinancial,
  deleteSalaryPaymentFromFinancial,
  deleteReconciliationFromFinancial,
} from '../../../api/services/financialSync';

const router: Router = Router();

router.post('/sync-bank-reconciliation', async (req: Request, res: Response) => {
  try {
    const { reconciliationId, userId } = req.body;

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

  } catch (error: any) {
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

router.post('/sync-salary-payment', async (req: Request, res: Response) => {
  try {
    const { paymentId, userId, employeeName, employeeId, paymentData } = req.body;

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

    const result = await syncSalaryPaymentToFinancial(
      paymentId,
      userId,
      employeeName,
      employeeId,
      paymentData
    );

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

  } catch (error: any) {
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

router.delete('/salary-payment/:paymentId', async (req: Request, res: Response) => {
  try {
    const { paymentId } = req.params;

    if (!paymentId || typeof paymentId !== 'string') {
      return res.status(400).json({
        error: 'Invalid paymentId',
        message: 'paymentId must be a non-empty string'
      });
    }

    console.log(`🗑️ [Financial Sync] Deletando movimentações do pagamento: ${paymentId}`);

    await deleteSalaryPaymentFromFinancial(paymentId);

    return res.json({
      success: true,
      message: 'Salary payment deleted successfully',
      paymentId,
      timestamp: new Date().toISOString()
    });

  } catch (error: any) {
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

router.delete('/bank-reconciliation/:reconciliationId', async (req: Request, res: Response) => {
  try {
    const { reconciliationId } = req.params;

    if (!reconciliationId || typeof reconciliationId !== 'string') {
      return res.status(400).json({
        error: 'Invalid reconciliationId',
        message: 'reconciliationId must be a non-empty string'
      });
    }

    console.log(`🗑️ [Financial Sync] Deletando reconciliação: ${reconciliationId}`);

    await deleteReconciliationFromFinancial(reconciliationId);

    return res.json({
      success: true,
      message: 'Bank reconciliation deleted successfully',
      reconciliationId,
      timestamp: new Date().toISOString()
    });

  } catch (error: any) {
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
