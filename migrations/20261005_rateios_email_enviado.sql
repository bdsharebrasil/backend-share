-- Mantém o status de envio disponível na parcela exibida pelo dashboard.
ALTER TABLE rateio_despesas ADD COLUMN email_enviado_em TEXT;
ALTER TABLE rateio_hold ADD COLUMN email_enviado_em TEXT;
