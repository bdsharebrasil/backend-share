import test from 'node:test'
import assert from 'node:assert/strict'
import { ratear, prever } from '../src/lib/ctmCoordenacao.ts'
const cotas=['a','b','c'].map(id=>({id,nome:id,cliente_id:id,socio_id:null,status:'ATIVO',percentual_sociedade:33.33}))
test('cota fixa preserva centavos com três cotas de 33,33%',()=>{
  const r=ratear({tipo_rateio:'percentual',total_pecas:100},cotas,[])
  assert.deepEqual(r.linhas.map(l=>l.centavos),[3334,3333,3333])
})
test('uso considera apenas duração atribuída e não distribui voos sem identificação',()=>{
  const o={tipo_rateio:'horas',total_pecas:100,relatorio_voo_de:'2026-10-01',relatorio_voo_ate:'2026-10-31'}
  assert.deepEqual(ratear(o,cotas,[{cliente_id:'a',tempo_voo:1},{cliente_id:'b',tempo_voo:3}]).linhas.map(l=>l.centavos),[2500,7500,0])
  assert.ok(ratear(o,cotas,[{tempo_voo:2}]).aviso)
})
test('escolhe a primeira previsão conhecida e preserva ausência de leitura',()=>{
  const r={item:'Inspeção',ultima_execucao_data:'2026-01-31',intervalo_meses:1,intervalo_horas:25,ultima_execucao_horas:100}
  assert.equal(prever(r,false,120,1,'2026-02-01').data,'2026-02-06')
  assert.equal(prever(r,false,null,null,'2026-02-01').data,'2026-02-28')
})
