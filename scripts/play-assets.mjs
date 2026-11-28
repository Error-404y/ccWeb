// Build-time removal of external checkout and direct update implementation.
function replaceBetween(source,start,end,replacement){
  const a=source.indexOf(start),b=source.indexOf(end,a+start.length);
  if(a<0||b<0)throw Error('Play packaging marker missing: '+start);
  return source.slice(0,a)+replacement+'\n'+source.slice(b);
}
export function playAssets(source){
  source=replaceBetween(source,'function updateDownload(release) {','let pushPlugin=null,',`function maybePromptUpdate(){}
$('updateCenter').addEventListener('click',()=>info('Update center','Installed: '+installedVersion+'. Updates are delivered by Google Play.'));`);
  source=replaceBetween(source,'function showAccess(){',"function updateAccessDisplay(){",`function showAccess(){ showAccessKeyOptions(); }
function showRenewal(){showRestrictedAccount('Access unavailable','Your current access is no longer active.');}
function showInvoice(secret,initial,renewal){if(renewal)showRenewal();else showAccess();}
`);
  if(/Litecoin checkout|Pay with Litecoin|Purchase access|access\/invoice|access\/submit|access\/renew|release\.downloads/.test(source))throw Error('External payment or update action remains in Play assets.');
  return source;
}
