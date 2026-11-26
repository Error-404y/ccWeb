import { readFileSync } from 'node:fs';
import { createPrivateKey, sign } from 'node:crypto';

const authURL='https://oauth2.googleapis.com/token';
const scope='https://www.googleapis.com/auth/firebase.messaging';
const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');

export function firebaseDelivery(credentials,{request=fetch,now=Date.now}={}){
  if(credentials?.type!=='service_account'||!/^[-a-z0-9]{4,63}$/.test(credentials.project_id||'')||typeof credentials.client_email!=='string')throw Error('Invalid Firebase service account.');
  const key=createPrivateKey(credentials.private_key);
  if(key.asymmetricKeyType!=='rsa')throw Error('Invalid Firebase signing key.');
  let cached=null,pending=null;
  async function accessToken(){
    if(cached&&cached.until>now()+60000)return cached.value;
    if(pending)return pending;
    pending=(async()=>{
      const iat=Math.floor(now()/1000);
      const unsigned=encode({alg:'RS256',typ:'JWT'})+'.'+encode({iss:credentials.client_email,scope,aud:authURL,iat,exp:iat+3600});
      const assertion=unsigned+'.'+sign('RSA-SHA256',Buffer.from(unsigned),key).toString('base64url');
      const response=await request(authURL,{method:'POST',redirect:'error',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion}),signal:AbortSignal.timeout(10000)});
      if(!response.ok)throw Error('Firebase authentication failed ('+response.status+').');
      const result=await response.json();
      if(typeof result.access_token!=='string'||!Number.isFinite(result.expires_in)||result.expires_in<=0)throw Error('Invalid Firebase authentication response.');
      cached={value:result.access_token,until:now()+result.expires_in*1000};return cached.value;
    })();
    try{return await pending;}finally{pending=null;}
  }
  return async token=>{
    const bearer=await accessToken();
    const response=await request('https://fcm.googleapis.com/v1/projects/'+credentials.project_id+'/messages:send',{method:'POST',redirect:'error',headers:{'Content-Type':'application/json',Authorization:'Bearer '+bearer},body:JSON.stringify({message:{token,notification:{title:'qzu.',body:'New activity. Open qzu. to view.'},android:{priority:'HIGH',ttl:'60s',collapse_key:'qzu_activity',restricted_package_name:'cc.qzu.app',notification:{tag:'qzu_activity',visibility:'PRIVATE'}}}}),signal:AbortSignal.timeout(10000)});
    if(response.status===401)cached=null;
    if(!response.ok){
      const error=await response.json().catch(()=>null);
      const invalid=error?.error?.details?.some(detail=>detail.errorCode==='UNREGISTERED');
      if(invalid)return {unregistered:true};
      throw Error('Firebase delivery failed ('+response.status+').');
    }
    return {ok:true};
  };
}
export function loadFirebaseDelivery(path){
  if(!path)return null;
  try{return firebaseDelivery(JSON.parse(readFileSync(path,'utf8')));}
  catch{console.warn('Firebase push configuration could not be loaded. Check file access and credentials.');return null;}
}
