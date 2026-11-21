/** Importa somente avatars do Storage configurado; a aplicação recebe a imagem pelo Worker. */
export async function importarAvatarLegado(db:D1Database,bucket:R2Bucket,userId:string,avatar:string,authBase:string){
  const url=new URL(avatar),base=new URL(authBase);
  if(url.protocol!=='https:'||url.origin!==base.origin||!/^\/storage\/v1\/object\/(?:public|sign)\//.test(url.pathname)||url.username||url.password)
    throw new Error('origem_avatar_nao_permitida');
  const res=await fetch(url.toString(),{redirect:'error',signal:AbortSignal.timeout(12000)});
  const mime=res.headers.get('content-type')?.split(';')[0]||'';
  const extensions:Record<string,string>={'image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/gif':'gif'};
  if(!res.ok||!extensions[mime])throw new Error('avatar_legado_indisponivel');
  if(Number(res.headers.get('content-length'))>10*1024*1024)throw new Error('avatar_acima_do_limite');
  const reader=res.body?.getReader();if(!reader)throw new Error('avatar_legado_vazio');
  const chunks:Uint8Array[]=[];let size=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>10*1024*1024)throw new Error('avatar_acima_do_limite');chunks.push(value)}}finally{await reader.cancel().catch(()=>undefined)}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength}
  if(!size)throw new Error('avatar_legado_vazio');
  const key=`avatar_profiles/${userId}/${crypto.randomUUID()}.${extensions[mime]}`;
  await bucket.put(key,bytes,{httpMetadata:{contentType:mime},customMetadata:{user_id:userId}});
  try{
    const result=await db.prepare('UPDATE user_profiles SET url_avatar = ?1, data_atualizacao = CURRENT_TIMESTAMP WHERE id = ?2 AND url_avatar = ?3').bind(key,userId,avatar).run();
    if(!result.meta.changes)await bucket.delete(key);
  }catch(error){await bucket.delete(key).catch(()=>undefined);throw error}
  return {bytes,mime};
}
