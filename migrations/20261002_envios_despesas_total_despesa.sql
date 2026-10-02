-- Guarda o valor integral da despesa quando o lançamento representa apenas
-- a parcela rateada; createPaymentRequest grava esse campo ao receber um envio.
ALTER TABLE envio_despesas ADD COLUMN valor_total_despesa REAL;
