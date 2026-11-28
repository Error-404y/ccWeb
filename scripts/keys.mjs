import {readFileSync} from 'node:fs';
import { developerCommand } from '../lib/admin-socket.mjs';
const [command,...raw]=process.argv.slice(2);
const args=raw[0]==='-'?raw.slice(1):raw;
try{
  let request;
  if(command==='genKey')request={action:'keys-generate',plan:args[0],count:Number(args[1]||1)};
  else if(command==='listKeys'||command==='findKey')request={action:'keys-list',query:args[0]||''};
  else if(command==='resetKey')request={action:'keys-replace',id:args[0]};
  else if(command==='revokeKey')request={action:'keys-revoke',id:args[0],reason:args.slice(1).join(' ')};
  else if(command==='rotateAdminKey'){if(process.stdin.isTTY)throw Error('Provide the old admin key on standard input.');request={action:'access-admin-rotate',key:readFileSync(0,'utf8').trim().toUpperCase()};}
  else if(command==='genAdminKey')request={action:'access-admin-create'};
  else throw Error('Use genKey - 1W|1M|1Y|LT [count], listKeys, findKey, resetKey, revokeKey genAdminKey or rotateAdminKey (stdin).');
  console.log(JSON.stringify(await developerCommand(request),null,2));
}catch(error){console.error(error.message);process.exitCode=1;}
