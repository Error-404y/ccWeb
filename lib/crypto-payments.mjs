import {randomBytes,randomUUID,randomInt} from 'node:crypto';
import {digest} from './accounts.mjs';
import {CONTROL_PLANS,ADDRESS,invoiceStatus} from './access.mjs';
export const COINS=Object.freeze({
 LTC:{name:'Litecoin',id:'litecoin',address:ADDRESS,decimals:8,confirmations:6,scheme:'litecoin'},
 BTC:{name:'Bitcoin',id:'bitcoin',address:'bc1qhe283m2zm7qsymxrpu6nuleyaz8rydtfgfwzgz',decimals:8,confirmations:3,scheme:'bitcoin'},
 SOL:{name:'Solana',id:'solana',address:'3JR35yrwkWwWNM8KUynM1qWnayWs5Bf1hgwfacerxjNo',decimals:9,confirmations:1,scheme:'solana'}
});
const fail=(message,status=400)=>Object.assign(Error(message),{status});
export function initPayments(db){
 const fields=new Set(db.prepare('PRAGMA table_info(access_invoices)').all().map(x=>x.name));
 for(const [name,type] of Object.entries({coin:'TEXT',usd_cents:'INTEGER',amount_atomic:'INTEGER',wallet:'TEXT',verified_at:'INTEGER'}))if(!fields.has(name))db.exec('ALTER TABLE access_invoices ADD COLUMN '+name+' '+type);
 db.exec('CREATE UNIQUE INDEX IF NOT EXISTS payment_unique_amount ON access_invoices(coin,amount_atomic) WHERE coin IS NOT NULL');
}
export function validTx(coin,tx){return typeof tx==='string'&&(coin==='SOL'?/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(tx):/^[a-fA-F0-9]{64}$/.test(tx));}
export function amountText(atomic,coin){const d=COINS[coin].decimals,n=String(atomic).padStart(d+1,'0');return n.slice(0,-d)+'.'+n.slice(-d);}
export function paymentURI(row){const c=COINS[row.coin];return c.scheme+':'+row.wallet+'?amount='+amountText(row.amount_atomic,row.coin);}
let prices=null,priceAt=0;
export async function quotePrice(coin,fetcher=fetch,now=Date.now()){
 if(prices&&now-priceAt<60000)return prices[coin];
 const headers={};if(process.env.QZU_COINGECKO_KEY)headers['x-cg-demo-api-key']=process.env.QZU_COINGECKO_KEY;
 const response=await fetcher('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,litecoin,solana&vs_currencies=usd&include_last_updated_at=true',{headers,signal:AbortSignal.timeout(5000),redirect:'error'});
 if(!response.ok)throw fail('Price feed unavailable. Try again.',503);
 const data=await response.json(),next={};
 for(const [symbol,c] of Object.entries(COINS)){const item=data[c.id];if(!Number.isFinite(item?.usd)||item.usd<=0||!Number.isFinite(item.last_updated_at)||Math.abs(now-item.last_updated_at*1000)>300000)throw fail('Fresh price unavailable.',503);next[symbol]=item.usd;}
 prices=next;priceAt=now;return prices[coin];
}
export function rpcConfigured(coin){return Boolean(COINS[coin]&&process.env['QZU_'+coin+'_RPC_URL']);}
export function createCryptoInvoice(db,plan,coin,usdRate,account=null,now=Date.now()){
 const p=CONTROL_PLANS[plan],c=COINS[coin];
 if(!Object.hasOwn(CONTROL_PLANS,plan)||!Object.hasOwn(COINS,coin)||!p||!c||!Number.isFinite(usdRate)||usdRate<=0)throw fail('Invalid checkout.');
 if(account&&db.prepare("SELECT id FROM access_invoices WHERE account=? AND redeemed IS NULL AND state IN ('submitted','confirmed')").get(account))throw fail('A renewal is already awaiting confirmation or redemption.',409);
 const units=10**c.decimals,base=Math.ceil(p.cents/100/usdRate*units),range=Math.min(1000000,Math.floor(.01/usdRate*units));
 if(!Number.isSafeInteger(base)||base<=0||!Number.isSafeInteger(range)||range<1)throw fail('Quote unavailable.',503);
 const secret='QZO-'+randomBytes(24).toString('hex').toUpperCase(),id=randomUUID();
 db.exec('BEGIN IMMEDIATE');try{
  let atomic=null;
  for(let i=0;i<Math.min(256,range+1);i++){const n=base+randomInt(0,range+1);if(!db.prepare('SELECT id FROM access_invoices WHERE coin=? AND amount_atomic=?').get(coin,n)){atomic=n;break;}}
  if(atomic===null)throw fail('No unique quote available. Try again shortly.',503);
  db.prepare("INSERT INTO access_invoices(id,secret,plan,account,eur_cents,usd_cents,coin,amount_atomic,wallet,created,expires) VALUES(?,?,?,?,0,?,?,?,?,?,?)").run(id,digest(secret),plan,account,p.cents,coin,atomic,c.address,now,now+30*60000);
  db.exec('COMMIT');return {orderKey:secret,...invoiceStatus(db,secret,now)};
 }catch(e){db.exec('ROLLBACK');throw e;}
}
async function rpc(coin,method,params,fetcher=fetch){
 const raw=process.env['QZU_'+coin+'_RPC_URL'];if(!raw)throw fail('Payment verification is not configured.',503);
 const url=new URL(raw),headers={'Content-Type':'application/json'};
 if(url.username||url.password){headers.Authorization='Basic '+Buffer.from(decodeURIComponent(url.username)+':'+decodeURIComponent(url.password)).toString('base64');url.username='';url.password='';}
 if(url.protocol!=='https:'&&!(url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)))throw fail('Unsafe payment RPC configuration.',503);
 const response=await fetcher(url,{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(5000),redirect:'error'});
 if(!response.ok)throw fail('Payment node unavailable.',503);
 const data=await response.json();if(data.error)throw fail('Transaction not available on payment node.',503);return data.result;
}
export function inspectTransaction(row,tx){
 const c=COINS[row.coin];if(!c||!tx)return null;
 const blockTime=(row.coin==='SOL'?tx.blockTime:tx.blocktime)*1000;
 if(!Number.isFinite(blockTime)||blockTime<row.created-120000||blockTime>row.expires)return null;
 if(row.coin==='SOL'){
  if(tx.meta?.err!==null||tx.transaction?.signatures?.[0]!==row.txid)return null;
  const transfers=tx.transaction.message.instructions.filter(i=>i.program==='system'&&i.parsed?.type==='transfer'&&i.parsed.info?.destination===row.wallet);
  if(transfers.length!==1||transfers[0].parsed.info.lamports!==row.amount_atomic)return null;
  const idx=tx.transaction.message.accountKeys.findIndex(k=>k.pubkey===row.wallet);
  if(idx<0||tx.meta.postBalances[idx]-tx.meta.preBalances[idx]!==row.amount_atomic)return null;
  return {confirmations:1,vout:0};
 }
 if(tx.txid!==row.txid||!Number.isInteger(tx.confirmations)||tx.confirmations<c.confirmations||!Array.isArray(tx.vout))return null;
 const outputs=tx.vout.filter(v=>(v.scriptPubKey?.address===row.wallet||(v.scriptPubKey?.addresses?.length===1&&v.scriptPubKey.addresses[0]===row.wallet))&&Number.isFinite(v.value)&&Math.round(v.value*1e8)===row.amount_atomic);
 if(outputs.length!==1||!Number.isInteger(outputs[0].n))return null;
 return {confirmations:tx.confirmations,vout:outputs[0].n};
}
export async function verifyCryptoInvoice(db,id,fetcher=fetch,now=Date.now()){
 const row=db.prepare("SELECT * FROM access_invoices WHERE id=? AND coin IS NOT NULL AND state='submitted'").get(id);if(!row)return false;
 const result=await rpc(row.coin,row.coin==='SOL'?'getTransaction':'getrawtransaction',row.coin==='SOL'?[row.txid,{encoding:'jsonParsed',commitment:'finalized',maxSupportedTransactionVersion:0}]:[row.txid,true],fetcher);
 const evidence=inspectTransaction(row,result);if(!evidence)return false;
 const activation='QZU-'+randomBytes(24).toString('hex').toUpperCase();
 db.exec('BEGIN IMMEDIATE');try{
  const duplicate=db.prepare("SELECT id FROM access_invoices WHERE id<>? AND coin=? AND txid=? AND state='confirmed'").get(id,row.coin,row.txid);if(duplicate)throw fail('Transaction already credited.',409);
  const changed=db.prepare("UPDATE access_invoices SET state='confirmed',activation_hash=?,activation_key=?,fingerprint=?,confirmations=?,vout=?,verified_at=? WHERE id=? AND state='submitted' AND txid=?").run(digest(activation),activation,activation.slice(-8),evidence.confirmations,evidence.vout,now,id,row.txid).changes;
  db.exec('COMMIT');return changed===1;
 }catch(e){db.exec('ROLLBACK');throw e;}
}
