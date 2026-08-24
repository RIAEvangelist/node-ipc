import readline from 'node:readline';
import {loadLane} from './lanes.js';

const laneId=process.argv[2];
const runtime={
    platform:process.platform,
    temporaryRoot:process.cwd()
};
let server;
let closePromise;

function send(value){
    process.stdout.write(`${JSON.stringify(value)}\n`);
}

function close({report=true}={}){
    if(!closePromise){
        closePromise=(async() => {
            await server?.close();
            if(report && process.stdout.writable){
                send({pid:process.pid,type:'closed'});
            }
        })();
    }
    return closePromise;
}

async function fail(error){
    const message=error?.stack ?? String(error);
    process.stderr.write(`${message}\n`);
    if(process.stdout.writable){
        send({error:message,pid:process.pid,type:'error'});
    }
    process.exitCode=1;
    try{
        await close();
    }catch(closeError){
        process.stderr.write(`${closeError?.stack ?? closeError}\n`);
    }
}

function closeOnControlLoss(){
    void close({report:false}).catch(error => {
        process.stderr.write(`${error?.stack ?? error}\n`);
        process.exitCode=1;
    });
}

process.on('uncaughtException',fail);
process.on('unhandledRejection',fail);
process.stdout.on('error',closeOnControlLoss);
process.stderr.on('error',() => {});
process.once('disconnect',closeOnControlLoss);

try{
    const lane=await loadLane(laneId);
    server=await lane.createServer({lane,onError:fail,runtime});
    send({
        endpoint:server.endpoint,
        metadata:lane.metadata,
        pid:process.pid,
        type:'ready'
    });
    const input=readline.createInterface({input:process.stdin,terminal:false});
    input.on('line',line => {
        let command;
        try{
            command=JSON.parse(line);
        }catch(error){
            fail(error);
            return;
        }
        if(command.type === 'close'){
            close().then(() => input.close(),fail);
        }
    });
    input.once('close',closeOnControlLoss);
}catch(error){
    await fail(error);
}
