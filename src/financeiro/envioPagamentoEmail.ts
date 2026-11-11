type Registro = Record<string, unknown>;
const objeto = (valor: unknown): Registro => valor && typeof valor === 'object' && !Array.isArray(valor) ? valor as Registro : {};
export function dadosRascunhoEmail(valor: unknown): Registro {
  if (typeof valor === 'string') { try { return objeto(JSON.parse(valor)); } catch { return {}; } }
  return objeto(valor);
}
/** O formulário selecionado define o escopo; um anexo compartilhado não inclui novos cotistas. */
export function destinatariosSelecionadosEmail(valor: unknown): string[] {
  const dados = dadosRascunhoEmail(valor);
  const form = objeto(dados.form);
  const ids = Array.isArray(form.cotista_ids) ? form.cotista_ids : Array.isArray(dados.cotistasEmail)
    ? dados.cotistasEmail.map(c => objeto(c).id) : [];
  const salvos = Array.isArray(dados.cotistasEmail) ? dados.cotistasEmail.map(c => objeto(c).id).filter(id => typeof id === 'string') : [];
  return [...new Set(ids.filter((id): id is string => typeof id === 'string' && Boolean(id.trim())).map(id => id.trim()).filter(id => !salvos.length || salvos.includes(id)))];
}
export function reconciliarEmailRascunho(valor: unknown, registros: Registro[]) {
  const dados = dadosRascunhoEmail(valor);
  const selecionados = destinatariosSelecionadosEmail(dados);
  const destinatarios = registros.filter(r => selecionados.includes(String(r.cotista_id)));
  const status = { ...objeto(dados.statusEmailCotista) };
  for (const r of destinatarios) status[String(r.cotista_id)] = r.status;
  const enviados = destinatarios.filter(r => r.status === 'ENVIADO' && r.email_id);
  return { dados: { ...dados, statusEmailCotista: status }, destinatarios,
    total: selecionados.length, enviados: enviados.length,
    falhos: destinatarios.filter(r => r.status === 'FALHOU').length,
    concluido: selecionados.length > 0 && enviados.length === selecionados.length };
}
