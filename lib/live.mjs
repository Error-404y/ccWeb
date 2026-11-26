import {createHash} from 'node:crypto';
export function versionedState(data,since=''){
  const {now,...stable}=data;
  const revision=createHash('sha256').update(JSON.stringify(stable)).digest('hex');
  return revision===since?{now,revision,unchanged:true}:{...data,revision};
}
