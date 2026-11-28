import {createHash} from 'node:crypto';
export function versionedState(data,since=''){
  const {now,...stable}=data;
  const revision=createHash('sha256').update(JSON.stringify(stable)).digest('hex');
  return revision===since?{now,revision,unchanged:true}:{...data,revision};
}

export function createLiveWakeup(delay = 500) {
  const waiters = new Set();
  let timer;
  return {
    subscribe(check) {
      waiters.add(check);
      return () => waiters.delete(check);
    },
    changed() {
      if (timer || !waiters.size) return;
      timer = setTimeout(() => {
        timer = null;
        for (const check of waiters) check();
      }, delay);
      timer.unref();
    }
  };
}
