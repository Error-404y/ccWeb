'use strict';
(()=>{
  const planLabels={week:'1 Week',month:'1 Month',year:'1 Year',monthly:'5 Months (legacy)',lifetime:'Lifetime',admin:'Administrator',seller:'Seller',legacy:'Existing access'};
  function accessSummary(access,now){
    if(!access||!Object.hasOwn(planLabels,access.plan))return {plan:'Unavailable',remaining:'Access information unavailable',status:'Unknown',timed:false};
    const plan=planLabels[access.plan],timed=['week','month','year','monthly'].includes(access.plan);
    if(timed&&Number.isFinite(access.paidUntil)&&Number.isFinite(now)&&access.paidUntil<=now)return {plan,remaining:'Expired',status:'Expired',timed};
    if(!access.active)return {plan,remaining:'No remaining access',status:'Inactive',timed};
    if(!timed)return {plan,remaining:'No expiration',status:'Active',timed};
    if(!Number.isFinite(access.paidUntil)||!Number.isFinite(now))return {plan,remaining:'Expiration unavailable',status:'Unknown',timed};
    const ms=access.paidUntil-now;
    if(ms<=0)return {plan,remaining:'Expired',status:'Expired',timed};
    const hours=Math.floor(ms/3600000),days=Math.floor(hours/24),rest=hours%24;
    return {plan,remaining:hours===0?'Less than 1 hour':(days?days+' day'+(days===1?'':'s')+(rest?', ':''):'')+(rest?rest+' hour'+(rest===1?'':'s'):''),status:'Active',timed};
  }
  function unreadCount(feed){return (feed?.posts||[]).filter(p=>p.id>(feed.seen||0)).length;}
  function attachEdgeBack(surface,{current,close,edge=26}){
    let gesture=null,suppress=false;
    const clear=()=>{const id=gesture?.id;gesture=null;if(id!==undefined&&surface.hasPointerCapture?.(id))try{surface.releasePointerCapture(id);}catch{}};
    const owns=e=>gesture?.id===e.pointerId;
    const horizontal=(dx,dy)=>dx>0&&dx>=Math.abs(dy)*1.6;
    surface.addEventListener('pointerdown',e=>{
      if(gesture&&!owns(e)){clear();return;}if(gesture)clear();
      suppress=false;
      const active=current(),bounds=surface.getBoundingClientRect();
      if(!active||!e.isPrimary||e.button!==0||!['touch','pen'].includes(e.pointerType)||e.clientX<bounds.left||e.clientX>bounds.left+edge||e.target.closest?.('button,a,input,textarea,select,audio,video,[contenteditable],dialog'))return;
      gesture={id:e.pointerId,x:e.clientX,y:e.clientY,active,tracking:false};
      // Reserve only the edge gesture, not the rest of the message surface.
      e.stopPropagation();
    },true);
    surface.addEventListener('pointermove',e=>{
      if(!owns(e))return;
      if(current()!==gesture.active){clear();return;}
      const dx=e.clientX-gesture.x,dy=e.clientY-gesture.y;
      if(dx < -10 || (Math.abs(dy)>12 && !horizontal(dx,dy))){clear();return;}
      if(dx>=12&&horizontal(dx,dy)){gesture.tracking=true;try{surface.setPointerCapture(e.pointerId);}catch{}e.stopPropagation();if(e.cancelable)e.preventDefault();}
    },true);
    surface.addEventListener('pointerup',e=>{
      if(!owns(e))return;
      const g=gesture,dx=e.clientX-g.x,dy=e.clientY-g.y,valid=current()===g.active&&dx>=72&&horizontal(dx,dy);
      clear();if(g.tracking||valid){suppress=true;e.stopPropagation();if(e.cancelable)e.preventDefault();}if(valid)close();
    },true);
    surface.addEventListener('pointercancel',e=>{if(owns(e)){suppress=gesture.tracking;clear();}},true);
    surface.addEventListener('lostpointercapture',e=>{if(owns(e)&&e.target===surface&&!surface.hasPointerCapture?.(e.pointerId))clear();},true);
    surface.addEventListener('click',e=>{if(suppress&&e.detail!==0){suppress=false;e.preventDefault();e.stopPropagation();}},true);
    return clear;
  }
  window.QzuSimplicity=Object.freeze({accessSummary,unreadCount,attachEdgeBack});
})();
