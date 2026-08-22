function deadline(promise,milliseconds,label){
    let timer;
    return Promise.race([
        promise,
        new Promise((_,reject) => {
            timer=setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds}ms`)),milliseconds);
            timer.unref();
        })
    ]).finally(() => clearTimeout(timer));
}

function lineMessages(child,timeout,label='C oracle'){
    const messages=[];
    let buffered='';
    let closeError;
    let fatalError;
    child.on('error',(error) => fatalError??=error);
    child.on('close',(code,signal) => {
        const error=new Error(`${label} closed: code=${code} signal=${signal}: ${child.benchmarkStderr || ''}`);
        if(code || signal) fatalError??=error;
        else closeError=error;
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data',(chunk) => {
        buffered+=chunk;
        let end;
        while((end=buffered.indexOf('\n')) !== -1){
            const line=buffered.slice(0,end).trim();
            buffered=buffered.slice(end+1);
            if(!line) continue;
            try{
                const entry=JSON.parse(line);
                messages.push(entry);
                child.emit('oracle-message',entry);
            }catch(error){
                fatalError??=error;
                child.emit('oracle-error',error);
            }
        }
    });
    return (type) => deadline(new Promise((resolve,reject) => {
        if(fatalError){reject(fatalError);return;}
        const index=messages.findIndex((entry) => entry.type === type);
        if(index !== -1){
            resolve(messages.splice(index,1)[0]);
            return;
        }
        if(closeError){reject(closeError);return;}
        const receive=(entry) => {
            if(entry.type !== type) return;
            const entryIndex=messages.indexOf(entry);
            if(entryIndex !== -1) messages.splice(entryIndex,1);
            clean();
            resolve(entry);
        };
        const fail=(error) => {
            clean();
            reject(error);
        };
        const close=(code,signal) => fail(new Error(
            `${label} closed before ${type}: code=${code} signal=${signal}: ${child.benchmarkStderr || ''}`
        ));
        const clean=() => {
            child.off('oracle-message',receive);
            child.off('oracle-error',fail);
            child.off('error',fail);
            child.off('close',close);
        };
        child.on('oracle-message',receive);
        child.once('oracle-error',fail);
        child.once('error',fail);
        child.once('close',close);
    }),timeout,`${label} ${type}`);
}

export {lineMessages};
