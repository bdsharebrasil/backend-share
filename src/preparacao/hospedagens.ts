/** Reservas vinculadas ao voo são compartilhadas com a tripulação escalada.
 * O chamador já confirmou que o usuário pertence à tripulação do voo.
 */
export async function hospedagensDoVoo(db:any,voo:{id:string;data_agendada:string;data_fim:string},usuarioId:string){
 const r=await db.prepare(`
      SELECT r.id, r.hotel_id, r.data_checkin, r.data_checkout, r.tipo_quarto,
        r.quantidade_hospedes, r.hospede_nome, r.observacoes, r.status,
        pr.escala_id, pr.servico_id, pr.payload_json AS preparacao_snapshot,
        COALESCE(h.telefone_reservas,h.telefone) AS hotel_telefone, h.email AS hotel_email, h.cafe_manha,
        h.nome AS hotel_nome, h.endereco AS hotel_endereco, h.cidade AS hotel_cidade, h.uf AS hotel_uf
      FROM reservas_hoteis r
      LEFT JOIN hoteis h ON h.id = r.hotel_id
      LEFT JOIN preparacao_voo_reservas pr ON pr.reserva_id=r.id
      WHERE pr.solicitacao_id=?4 OR (pr.id IS NULL AND r.criado_por = ?1
        AND date(r.data_checkin) <= date(?3)
        AND date(r.data_checkout) >= date(?2))
      ORDER BY date(r.data_checkin), r.criado_em
    `).bind(usuarioId, voo.data_agendada, voo.data_fim, voo.id).all();
 return {results:(r.results||[]).map(({preparacao_snapshot,...reserva}:any)=>{
   let p:any=null;if(preparacao_snapshot)try{p=JSON.parse(preparacao_snapshot);}catch{}
   return {...reserva,cafe_estado:p?.cafe_estado||null,cafe_valor:p?.cafe_valor||null,hotel_nome:p?.nome||reserva.hotel_nome,hotel_telefone:p?.telefone||reserva.hotel_telefone};
 })};
}
