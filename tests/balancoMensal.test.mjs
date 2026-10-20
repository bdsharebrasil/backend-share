import test from 'node:test'
import assert from 'node:assert/strict'
import { calcularBalancoMensal as calcular, distribuirCentavos, simularProximaDespesa } from '../src/financeiro/balancoMensal.ts'
const ps = [{id:'a',nome:'A',dominio:'CLIENTES'},{id:'b',nome:'B',dominio:'CLIENTES'}]
const linha = (id,pessoa,devido,pago=0,pagador=null,extra={})=>({id,participanteId:pessoa,dominio:'CLIENTES',origemChave:'d1',competencia:'2026-10-01',categoria:'Seguro',descricao:'Seguro',tipo:'FIXO',devido,pagoReal:pago,pagadorId:pagador,direto:true,dataPagamento:'2026-10-03',status:'EM_ABERTO',...extra})
const run=(rs,ev=[],aj=[],participantes=ps)=>calcular(participantes,rs,ev,aj,'2026-10-01','2026-10-31')
test('um paga tudo: A recebe 500 de B; zero do não pagador permanece zero',()=>{
 const r=run([linha('1','a',50000,100000,'a'),linha('2','b',50000,0,'a')])
 assert.deepEqual(r.saldos.map(s=>s.saldoCentavos),[50000,-50000]);assert.deepEqual(r.compensacoes,[{deId:'b',paraId:'a',valorCentavos:50000}])
})
test('cada um paga sua parte: nenhum ajuste',()=>{
 const r=run([linha('1','a',50000,50000,'a'),linha('2','b',50000,50000,'b')]);assert.deepEqual(r.compensacoes,[])
 assert.equal(r.diferencaCustoPagamentoCentavos,0)
})
test('pagamento de caixa Share não é pessoal e não bloqueia a simulação',()=>{
 const r=run([linha('1','a',50000,50000,null),linha('2','b',50000)], [{id:'s',rateioId:'1',pagadorId:null,tipoPagador:'SHARE',valor:50000,data:'2026-10-04',status:'CONFIRMADO'}])
 assert.equal(r.pagoPessoalCentavos,0)
 assert.ok(!r.avisos.some(a=>a.includes('Pagamento sem cotista identificável')))
 assert.doesNotThrow(()=>simularProximaDespesa(r,10000,[{id:'a',peso:50},{id:'b',peso:50}]))
})
test('pagamento legado não direto é caixa comum, não cotista sem identidade',()=>{
 const r=run([linha('1','a',50000,50000,null,{direto:false}),linha('2','b',50000)])
 assert.equal(r.pagoPessoalCentavos,0)
 assert.ok(!r.avisos.some(a=>a.includes('Pagamento sem cotista identificável')))
 assert.doesNotThrow(()=>simularProximaDespesa(r,10000,[{id:'a',peso:50},{id:'b',peso:50}]))
})
test('evento de cotista sem vínculo continua gerando aviso de conciliação',()=>{
 const r=run([linha('1','a',50000),linha('2','b',50000)], [{id:'p',rateioId:'1',pagadorId:null,tipoPagador:'COTISTA',valor:10000,data:'2026-10-04',status:'CONFIRMADO'}])
 assert.ok(r.avisos.some(a=>a.includes('Pagamento sem cotista identificável')))
 assert.throws(()=>simularProximaDespesa(r,10000,[{id:'a',peso:50},{id:'b',peso:50}]),/Concilie os avisos/)
})
test('ledger prevalece sobre agregado do trigger e crédito vai ao pagador real',()=>{
 const r=run([linha('1','a',50000,50000,null),linha('2','b',50000,50000,null)],[
 {id:'p1',rateioId:'1',pagadorId:'a',valor:50000,data:'2026-10-02',status:'CONFIRMADO'},
 {id:'p2',rateioId:'2',pagadorId:'a',valor:50000,data:'2026-10-02',status:'CONFIRMADO'}])
 assert.equal(r.pagoPessoalCentavos,100000);assert.equal(r.saldos[1].pagoCentavos,0)
})
test('estorno de evento não ressuscita o agregado legado',()=>{
 const r=run([linha('1','a',50000,50000,'a')],[{id:'p',rateioId:'1',pagadorId:'a',valor:50000,data:'2026-10-02',status:'ESTORNADO'}])
 assert.equal(r.pagoPessoalCentavos,0)
})
test('despesa sem pagamento não inventa crédito; diferença fica visível',()=>{
 const r=run([linha('1','a',50000),linha('2','b',50000)])
 assert.equal(r.diferencaCustoPagamentoCentavos,100000);assert.deepEqual(r.compensacoes,[])
})
test('corte por competência e pagamentos até o fim, incluindo pagamento antecipado',()=>{
 const r=run([linha('1','a',10000,10000,'a',{dataPagamento:'2026-09-01'}),linha('2','b',10000,10000,'b',{dataPagamento:'2026-11-01'}),linha('3','b',10000,0,null,{competencia:'2026-09-01'})])
 assert.equal(r.custoTotalCentavos,20000);assert.equal(r.pagoPessoalCentavos,10000)
})
test('transferir responsabilidade mantém custo e pagamento, muda compensação',()=>{
 const r=run([linha('1','a',50000,100000,'a'),linha('2','b',50000) ],[],[{id:'x',origemRateioId:'1',destinoRateioId:'2',valor:10000,motivo:'Despesa particular'}])
 assert.equal(r.custoTotalCentavos,100000);assert.equal(r.pagoPessoalCentavos,100000);assert.equal(r.compensacoes[0].valorCentavos,60000)
})
test('ajuste também muda distribuição econômica de eventos já pagos',()=>{
 const r=run([linha('1','a',50000),linha('2','b',50000)],[{id:'p',rateioId:'1',pagadorId:'a',valor:100000,data:'2026-10-01',status:'CONFIRMADO'}],[{id:'x',origemRateioId:'1',destinoRateioId:'2',valor:50000,motivo:'B assume tudo'}])
 assert.equal(r.compensacoes[0].valorCentavos,100000);assert.equal(r.linhas[0].devido,0)
})
test('ajuste entre despesas distintas rejeitado',()=>assert.throws(()=>run([linha('1','a',100),linha('2','b',100,0,null,{origemChave:'outra'})],[],[{id:'x',origemRateioId:'1',destinoRateioId:'2',valor:50,motivo:'teste'}])))
test('cancelado não compõe custo nem crédito',()=>assert.equal(run([linha('1','a',10000,10000,'a',{status:'CANCELADO'})]).custoTotalCentavos,0))
test('holding: banco conjunto não credita pessoal, bolso próprio credita',()=>{
 const participantes=ps.map(p=>({...p,dominio:'HOLD:h'}))
 const r=run([linha('1','a',50000,50000,null,{dominio:'HOLD:h',direto:false}),linha('2','b',50000,50000,'b',{dominio:'HOLD:h'})],[],[],participantes)
 assert.equal(r.saldos[0].pagoCentavos,0);assert.equal(r.saldos[1].pagoCentavos,50000)
})
test('centavos conservados no rateio por horas e porcentagens',()=>{
 assert.deepEqual(distribuirCentavos(100,[1,1,1]),[34,33,33]);assert.deepEqual(distribuirCentavos(10000,[25,75]),[2500,7500]);assert.throws(()=>distribuirCentavos(100,[0,0]))
})
test('compensação bilateral preserva matriz da planilha',()=>{
 const r=run([linha('1','a',2245563,3559035,'a'),linha('2','b',1313472,0,'a'),linha('3','a',1139000,0,'b',{origemChave:'d2'}),linha('4','b',2710841,3849841,'b',{origemChave:'d2'})])
 assert.equal(r.compensacoes[0].deId,'b');assert.equal(r.compensacoes[0].paraId,'a');assert.equal(r.compensacoes[0].valorCentavos,174472)
})

test('inconsistência real da planilha fica explícita: 787,17 sem rateio',()=>{
 const r=run([linha('1','a',2245563,3559035,'a'),linha('2','b',1313472,0,'a'),linha('3','a',1139000,0,'b',{origemChave:'d2'}),linha('4','b',2710841,3928558,'b',{origemChave:'d2'})])
 assert.equal(r.diferencaCustoPagamentoCentavos,-78717);assert.ok(r.avisos.some(a=>a.includes('supera o custo')))
})
