function createInbox(){
    const queued=[];
    const waiters=[];
    let failure;
    let ended=false;

    const push=value => {
        const waiter=waiters.shift();
        if(waiter){
            waiter.resolve(value);
            return;
        }
        queued.push(value);
    };
    const fail=error => {
        failure=error instanceof Error ? error : new Error(String(error));
        while(waiters.length){
            waiters.shift().reject(failure);
        }
    };
    const end=() => {
        ended=true;
        while(waiters.length){
            waiters.shift().reject(new Error('message channel closed'));
        }
    };
    const receive=() => {
        if(queued.length){
            return Promise.resolve(queued.shift());
        }
        if(failure){
            return Promise.reject(failure);
        }
        if(ended){
            return Promise.reject(new Error('message channel closed'));
        }
        return new Promise((resolve,reject) => waiters.push({reject,resolve}));
    };

    return {end,fail,push,receive};
}

export {
    createInbox
};
