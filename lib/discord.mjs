export async function sendReset(ref,url=process.env.QZU_RESET_WEBHOOK,fetcher=fetch,now=new Date()){
  if(!url) throw new Error('Reset service unavailable.');
  const endpoint=new URL(url);
  if(endpoint.origin!=='https://discord.com'||!/^\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+$/.test(endpoint.pathname)||endpoint.username||endpoint.password||endpoint.search||endpoint.hash)throw new Error('Reset service unavailable.');
  const time=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Zurich',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(now);
  const response=await fetcher(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({content:'Time: '+time+'\nReference: '+ref+'\nApplied',allowed_mentions:{parse:[]}}),redirect:'error',signal:AbortSignal.timeout(8000)});
  if(!response.ok)throw new Error('Reset service unavailable.');
}
