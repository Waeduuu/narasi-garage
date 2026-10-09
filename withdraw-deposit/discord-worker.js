/**
 * Cloudflare Worker — Discord webhook relay for Narasi Garage.
 * Required Worker secrets: DISCORD_WEBHOOK_URL, ACCESS_KEY
 * Required Worker variable: ALLOWED_ORIGIN (e.g. https://waeduuu.github.io)
 * Deploy separately from GitHub Pages. Never place secrets in the GitHub repo.
 */
const allowed = (origin, env) => !!origin && origin === env.ALLOWED_ORIGIN;
const json = (obj, status, origin, env) => new Response(JSON.stringify(obj), {
  status,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    ...(allowed(origin, env) ? {'access-control-allow-origin':origin, 'vary':'Origin'} : {}),
    'cache-control':'no-store',
    'x-content-type-options':'nosniff'
  }
});
const clean = (value, max) => typeof value === 'string'
  ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max)
  : '';
const msg = value => String(value).replace(/([\\*_~`|>])/g,'\\$1');
export default {
  async fetch(request, env) {
    const origin = request.headers.get('origin') || '';
    if (request.method === 'OPTIONS') {
      if (!allowed(origin, env)) return new Response(null, {status:403});
      return new Response(null,{status:204,headers:{
        'access-control-allow-origin':origin,
        'access-control-allow-methods':'POST, OPTIONS',
        'access-control-allow-headers':'Content-Type, Authorization',
        'access-control-max-age':'3600',
        'vary':'Origin'
      }});
    }
    if (request.method !== 'POST') return json({ok:false,error:'POST required.'},405,origin,env);
    if (!allowed(origin,env)) return json({ok:false,error:'Origin not allowed.'},403,origin,env);
    if (!env.DISCORD_WEBHOOK_URL || !env.ACCESS_KEY || !env.ALLOWED_ORIGIN) return json({ok:false,error:'Server is not configured.'},503,origin,env);
    if (request.headers.get('authorization') !== `Bearer ${env.ACCESS_KEY}`) return json({ok:false,error:'Invalid access key.'},401,origin,env);
    if (Number(request.headers.get('content-length') || 0)>5000) return json({ok:false,error:'Request too large.'},413,origin,env);
    let body;
    try{body=await request.json()}catch{return json({ok:false,error:'Invalid JSON.'},400,origin,env)}
    const action=body?.action,staff=clean(body?.staff,80),item=clean(body?.item,140),note=clean(body?.note,750);
    const quantity=(body?.quantity===null||body?.quantity===undefined||body?.quantity==='')?null:Number(body.quantity);
    if (!['withdraw','deposit'].includes(action) || !staff || !item || (quantity!==null && (!Number.isSafeInteger(quantity)||quantity<1||quantity>999999))) return json({ok:false,error:'Invalid transaction details.'},400,origin,env);
    const stamp=new Date();
    const wib=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Jakarta',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(stamp);
    const id=(action==='deposit'?'DP':'WD')+'-'+stamp.toISOString().replace(/[-:.TZ]/g,'').slice(0,14)+'-'+crypto.randomUUID().slice(0,8).toUpperCase();
    const embed={
      title:action==='deposit'?'📥 NARASI GARAGE | DEPOSIT':'📤 NARASI GARAGE | WITHDRAW',
      color:action==='deposit'?0x00DDE9:0xFF4565,
      fields:[
        {name:'👤 Staff / IC Name',value:msg(staff),inline:true},
        {name:'📦 Item / Description',value:msg(item),inline:true},
        {name:'🔢 Quantity',value:quantity===null?'Not specified':String(quantity),inline:true},
        {name:'📝 Notes / Reason',value:note?msg(note):'—',inline:false},
        {name:'🆔 Transaction ID',value:id,inline:false}
      ],
      footer:{text:'Narasi Garage • Withdraw & Deposit • '+wib+' WIB'},
      timestamp:stamp.toISOString()
    };
    try{
      const result=await fetch(env.DISCORD_WEBHOOK_URL+'?wait=true',{
        method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({username:'Narasi Garage Logs',allowed_mentions:{parse:[]},embeds:[embed]})
      });
      if (!result.ok)return json({ok:false,error:'Discord delivery failed (HTTP '+result.status+').'},502,origin,env);
      return json({ok:true,id,timestamp:wib+' WIB'},200,origin,env);
    }catch{return json({ok:false,error:'Unable to reach Discord.'},502,origin,env)}
  }
};