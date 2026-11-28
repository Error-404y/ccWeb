import {randomBytes,randomUUID,randomInt} from 'node:crypto';
import {digest} from './accounts.mjs';
import {CONTROL_PLANS,ADDRESS,invoiceStatus,PAYMENT_SUBMISSION_GRACE} from './access.mjs';
export const COINS=Object.freeze({
 LTC:{name:'Litecoin',id:'litecoin',address:ADDRESS,decimals:8,confirmations:6,scheme:'litecoin'},
 BTC:{name:'Bitcoin',id:'bitcoin',address:'bc1qhe283m2zm7qsymxrpu6nuleyaz8rydtfgfwzgz',decimals:8,confirmations:3,scheme:'bitcoin'},
 SOL:{name:'Solana',id:'solana',address:'3JR35yrwkWwWNM8KUynM1qWnayWs5Bf1hgwfacerxjNo',decimals:9,confirmations:1,scheme:'solana'}
});
const fail=(message,status=400)=>Object.assign(Error(message),{status});
export function initPayments(db){
 const fields=new Set(db.prepare('PRAGMA table_info(access_invoices)').all().map(x=>x.name));
 for(const [name,type] of Object.entries({coin:'TEXT',usd_cents:'INTEGER',amount_atomic:'INTEGER',wallet:'TEXT',verified_at:'INTEGER',last_checked:'INTEGER',ticket_required:'INTEGER NOT NULL DEFAULT 0',ticket_released:'INTEGER'}))if(!fields.has(name))db.exec('ALTER TABLE access_invoices ADD COLUMN '+name+' '+type);
 db.exec('CREATE UNIQUE INDEX IF NOT EXISTS payment_unique_amount ON access_invoices(coin,amount_atomic) WHERE coin IS NOT NULL');
}
export function validTx(coin,tx){return typeof tx==='string'&&(coin==='SOL'?/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(tx):/^[a-fA-F0-9]{64}$/.test(tx));}
export function amountText(atomic,coin){const d=COINS[coin].decimals,n=String(atomic).padStart(d+1,'0');return n.slice(0,-d)+'.'+n.slice(-d);}
export function paymentURI(row){const c=COINS[row.coin];return c.scheme+':'+row.wallet+'?amount='+amountText(row.amount_atomic,row.coin);}
const prices = new Map();
const QUOTE_CACHE = 60_000;
const PRICE_MAX_AGE = 300_000;
export async function quotePrice(coin,fetcher=fetch,now=Date.now()){
 if(!Object.hasOwn(COINS,coin))throw fail('Choose a payment network.');
 const cached = prices.get(coin);
 if(cached && now >= cached.fetched && now - cached.fetched < QUOTE_CACHE && Math.abs(now - cached.updated) <= PRICE_MAX_AGE) return cached.usd;
 const headers={};if(process.env.QZU_COINGECKO_KEY)headers['x-cg-demo-api-key']=process.env.QZU_COINGECKO_KEY;
 const response=await fetcher('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,litecoin,solana&vs_currencies=usd&include_last_updated_at=true',{headers,signal:AbortSignal.timeout(5000),redirect:'error'});
 if(!response.ok)throw fail('Price feed unavailable. Try again.',503);
 const data=await response.json();
 let quote;
 for(const [symbol, network] of Object.entries(COINS)){
  const item = data?.[network.id];
  if(!Number.isFinite(item?.usd) || item.usd <= 0 || !Number.isFinite(item.last_updated_at)) continue;
  const updated = item.last_updated_at * 1000;
  if(Math.abs(now - updated) > PRICE_MAX_AGE) continue;
  const previous = prices.get(symbol);
  if(!previous || updated >= previous.updated) prices.set(symbol, {usd:item.usd, updated, fetched:now});
  if(symbol === coin) quote = item.usd;
 }
 if(quote === undefined) throw fail('Fresh price unavailable for ' + COINS[coin].name + '.',503);
 return quote;
}
const explorers=Object.freeze({BTC:'https://mempool.space/api',LTC:'https://litecoinspace.org/api'});
const publicEnabled=()=>process.env.QZU_PUBLIC_PAYMENT_VERIFICATION!=='false';
function configuredRPC(coin){return process.env['QZU_'+coin+'_RPC_URL']||(coin==='SOL'&&publicEnabled()?'https://api.mainnet.solana.com':'');}
export function rpcConfigured(coin){return Boolean(Object.hasOwn(COINS,coin)&&(configuredRPC(coin)||(publicEnabled()&&explorers[coin])));}
function useExplorer(coin){return !configuredRPC(coin)&&publicEnabled()&&Boolean(explorers[coin]);}
async function explorerRead(coin,path,fetcher=fetch,json=false){
 const response=await fetcher(explorers[coin]+path,{signal:AbortSignal.timeout(6500),redirect:'error'});
 if(!response.ok)throw fail('Blockchain provider unavailable. Your order is saved.',503);
 return json?response.json():response.text();
}
async function explorerTransaction(coin,txid,fetcher){
 if(!validTx(coin,txid))return null;
 const tx=await explorerRead(coin,'/tx/'+txid,fetcher,true);
 if(tx?.txid!==txid||!tx.status?.confirmed||!Number.isInteger(tx.status.block_height)||!Number.isFinite(tx.status.block_time)||!Array.isArray(tx.vout))return null;
 const height=Number((await explorerRead(coin,'/blocks/tip/height',fetcher)).trim());
 if(!Number.isSafeInteger(height)||height<tx.status.block_height)return null;
 return {txid,blocktime:tx.status.block_time,confirmations:height-tx.status.block_height+1,vout:tx.vout.map((v,n)=>({n,value:Number.isSafeInteger(v.value)?v.value/1e8:NaN,scriptPubKey:{address:v.scriptpubkey_address}}))};
}
export function existingCryptoInvoice(db,secret,plan,coin,account=null,now=Date.now()){
 if(typeof secret!=='string'||!/^QZO-[A-F0-9]{48}$/.test(secret))throw fail('Invalid checkout reference.');
 const row=db.prepare('SELECT * FROM access_invoices WHERE secret=?').get(digest(secret));
 if(!row)return null;
 if(row.plan!==plan||row.coin!==coin||row.account!==account||!Number.isSafeInteger(row.usd_cents)||row.usd_cents<=0)throw fail('This reference belongs to a different order. Open that order separately.',409);
 return {orderKey:secret,...invoiceStatus(db,secret,now)};
}
export function createCryptoInvoice(db,plan,coin,usdRate,account=null,now=Date.now(),requestKey=null,ticketFlow=false){
 const p=CONTROL_PLANS[plan],c=COINS[coin];
 if(!Object.hasOwn(CONTROL_PLANS,plan)||!Object.hasOwn(COINS,coin)||!p||!c||!Number.isFinite(usdRate)||usdRate<=0)throw fail('Invalid checkout.');
 const units=10**c.decimals,base=Math.ceil(p.cents/100/usdRate*units),range=Math.min(1000000,Math.floor(.01/usdRate*units));
 if(!Number.isSafeInteger(base)||base<=0||!Number.isSafeInteger(range)||range<1)throw fail('Quote unavailable.',503);
 const secret=requestKey||'QZO-'+randomBytes(24).toString('hex').toUpperCase(),id=randomUUID();
 db.exec('BEGIN IMMEDIATE');try{
  if(requestKey){
   const existing=existingCryptoInvoice(db,requestKey,plan,coin,account,now);
   if(existing){db.exec('COMMIT');return existing;}
  }
  const outstanding = account && db.prepare(`SELECT id FROM access_invoices WHERE account=? AND redeemed IS NULL
   AND (state='confirmed' OR (state='submitted' AND (coin IS NULL OR confirmations>0 OR submitted>?)))`).get(account, now-PAYMENT_SUBMISSION_GRACE);
  if(outstanding)throw fail('A renewal is already awaiting confirmation or redemption.',409);
  let atomic=null;
  for(let i=0;i<Math.min(256,range+1);i++){const n=base+randomInt(0,range+1);if(!db.prepare('SELECT id FROM access_invoices WHERE coin=? AND amount_atomic=?').get(coin,n)){atomic=n;break;}}
  if(atomic===null)throw fail('No unique quote available. Try again shortly.',503);
  db.prepare("INSERT INTO access_invoices(id,secret,plan,account,eur_cents,usd_cents,coin,amount_atomic,wallet,created,expires,ticket_required) VALUES(?,?,?,?,0,?,?,?,?,?,?,?)").run(id,digest(secret),plan,account,p.cents,coin,atomic,c.address,now,now+30*60000,ticketFlow?1:0);
  db.exec('COMMIT');return {orderKey:secret,...invoiceStatus(db,secret,now)};
 }catch(e){db.exec('ROLLBACK');throw e;}
}
async function rpc(coin,method,params,fetcher=fetch){
 const raw=configuredRPC(coin);if(!raw)throw fail('Payment verification is not configured.',503);
 const url=new URL(raw),headers={'Content-Type':'application/json'};
 if(url.username||url.password){headers.Authorization='Basic '+Buffer.from(decodeURIComponent(url.username)+':'+decodeURIComponent(url.password)).toString('base64');url.username='';url.password='';}
 if(url.protocol!=='https:'&&!(url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)))throw fail('Unsafe payment RPC configuration.',503);
 const response=await fetcher(url,{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(5000),redirect:'error'});
 if(!response.ok)throw fail('Payment node unavailable.',503);
 const data=await response.json();if(data.error)throw fail('Transaction not available on payment node.',503);return data.result;
}
const genesis={BTC:'000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f',LTC:'12a765e31ffd4059bada1e25190f6e98c99d9714d334efa41a195a7e7e04bfe2',SOL:'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'};
export async function verifyNetwork(coin,fetcher=fetch){
 const value=useExplorer(coin)?(await explorerRead(coin,'/block-height/0',fetcher)).trim():await rpc(coin,coin==='SOL'?'getGenesisHash':'getblockhash',coin==='SOL'?[]:[0],fetcher);
 if(value!==genesis[coin])throw fail('Payment node is not on the expected mainnet.',503);
}
export function inspectTransaction(row,tx,{partial=false}={}){
 const c=COINS[row.coin];if(!c||!tx)return null;
 const stamp=row.coin==='SOL'?tx.blockTime:tx.blocktime;if(!Number.isFinite(stamp))return null;const blockTime=stamp*1000;
 if(!Number.isFinite(blockTime)||blockTime<row.created-120000||blockTime>row.expires+24*3600000)return null;
 if(row.coin==='SOL'){
  if(tx.meta?.err!==null||tx.transaction?.signatures?.[0]!==row.txid)return null;
  const transfers=tx.transaction.message.instructions.filter(i=>i.program==='system'&&i.parsed?.type==='transfer'&&i.parsed.info?.destination===row.wallet);
  if(transfers.length!==1||transfers[0].parsed.info.lamports!==row.amount_atomic)return null;
  const idx=tx.transaction.message.accountKeys.findIndex(k=>k.pubkey===row.wallet);
  if(idx<0||tx.meta.postBalances[idx]-tx.meta.preBalances[idx]!==row.amount_atomic)return null;
  return {confirmations:1,vout:0};
 }
 if(tx.txid!==row.txid||!Number.isInteger(tx.confirmations)||tx.confirmations<(partial?1:c.confirmations)||!Array.isArray(tx.vout))return null;
 const outputs=tx.vout.filter(v=>(v.scriptPubKey?.address===row.wallet||(v.scriptPubKey?.addresses?.length===1&&v.scriptPubKey.addresses[0]===row.wallet))&&Number.isFinite(v.value)&&Math.round(v.value*1e8)===row.amount_atomic);
 if(outputs.length!==1||!Number.isInteger(outputs[0].n))return null;
 return {confirmations:tx.confirmations,vout:outputs[0].n};
}
export async function verifyCryptoInvoice(db,id,fetcher=fetch,now=Date.now()){
 const row=db.prepare("SELECT * FROM access_invoices WHERE id=? AND coin IS NOT NULL AND state='submitted'").get(id);if(!row)return false;
 db.prepare('UPDATE access_invoices SET last_checked=? WHERE id=?').run(now,id);
 await verifyNetwork(row.coin,fetcher);
 const result=useExplorer(row.coin)?await explorerTransaction(row.coin,row.txid,fetcher):await rpc(row.coin,row.coin==='SOL'?'getTransaction':'getrawtransaction',row.coin==='SOL'?[row.txid,{encoding:'jsonParsed',commitment:'finalized',maxSupportedTransactionVersion:0}]:[row.txid,true],fetcher);
 const evidence=inspectTransaction(row,result,{partial:true});if(!evidence)return false;
 if(evidence.confirmations<COINS[row.coin].confirmations){db.prepare("UPDATE access_invoices SET confirmations=? WHERE id=? AND state='submitted' AND txid=?").run(evidence.confirmations,id,row.txid);return false;}

 db.exec('BEGIN IMMEDIATE');try{
  const duplicate=db.prepare("SELECT id FROM access_invoices WHERE id<>? AND (coin=? OR (coin IS NULL AND ?='LTC')) AND txid=? AND state='confirmed'").get(id,row.coin,row.coin,row.txid);if(duplicate)throw fail('Transaction already credited.',409);
  const changed=db.prepare("UPDATE access_invoices SET state='confirmed',activation_hash=NULL,activation_key=NULL,confirmations=?,vout=?,verified_at=? WHERE id=? AND state='submitted' AND txid=?").run(evidence.confirmations,evidence.vout,now,id,row.txid).changes;
  db.exec('COMMIT');return changed===1;
 }catch(e){db.exec('ROLLBACK');throw e;}
}
