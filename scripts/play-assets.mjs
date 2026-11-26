// Build-time removal of external checkout and direct update implementation.
function replaceBetween(source,start,end,replacement){
  const a=source.indexOf(start),b=source.indexOf(end,a+start.length);
  if(a<0||b<0)throw Error('Play packaging marker missing: '+start);
  return source.slice(0,a)+replacement+'\n'+source.slice(b);
}
export function playAssets(source){
  source=replaceBetween(source,'function updateDownload(release) {','let pushPlugin=null,',`function maybePromptUpdate(){}
$('updateCenter').addEventListener('click',()=>info('Update center','Installed: '+installedVersion+'. Updates are delivered by Google Play.'));`);
  source=replaceBetween(source,'function showAccess() {',"$('accessSettings').addEventListener",`function showAccess(){
  showCheckout('qzu-Access',[el('p','','Enter your existing access key to continue.'),button('Redeem Key',()=>showKeyEntry(false)),...legalButtons()]);
}
function showKeyEntry(renewal){
  if(renewal){showRenewal();return;}
  const input=el('input','access-key-input');input.placeholder='Use Access-Key';input.setAttribute('aria-label','Use Access-Key');input.autocomplete='off';input.spellcheck=false;input.maxLength=58;
  const submit=button('Continue',async()=>{
    const value=input.value.trim().toUpperCase();
    if(!/^(QZU-[A-F0-9]{48}|QZU-ADMIN-[A-F0-9]{48}|QZU-REVIEW-[A-F0-9]{40})$/.test(value)){dialogError(Error('Enter a valid key.'));return;}
    submit.disabled=true;
    try{const result=await api('session',{accessKey:value});if(result.accessRequired||typeof result.needsSetup!=='boolean')throw Error('Key activation unavailable.');input.value='';forgetInvoice(false);delete modal.dataset.checkout;stopCheckout();sessionReady=true;needsSetup=result.needsSetup;showLogin();}
    catch(error){dialogError(error);submit.disabled=false;}
  });
  showCheckout('Use Access-Key',[input,submit,button('Back',showAccess,'secondary-button')]);
}
function showRenewal(){showRestrictedAccount('Access unavailable','Your current access is no longer active.');}
function showInvoice(secret,initial,renewal){if(renewal)showRenewal();else showAccess();}
`);
  const start=source.indexOf("$('accessSettings').addEventListener");
  if(start<0)throw Error('Missing access settings');
  source=source.slice(0,start)+`$('accessSettings').addEventListener('click',()=>{
  const access=state.access;
  info('qzu-Access',access?.plan==='monthly'?'Existing access until '+new Date(access.paidUntil).toLocaleDateString()+'.':'Lifetime or existing account access.');
});
`;
  if(/Litecoin checkout|Pay with Litecoin|Purchase access|access\/invoice|access\/submit|access\/renew|release\.downloads/.test(source))throw Error('External payment or update action remains in Play assets.');
  return source;
}
