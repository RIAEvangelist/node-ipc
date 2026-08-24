import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {laneDefinitions,laneIds,moduleIds} from './lanes.js';

const directory=path.dirname(fileURLToPath(import.meta.url));

function sourceLines(text){
    let inBlock=false;
    return text.split(/\r?\n/u).filter(line => {
        const value=line.trim();
        if(!value){
            return false;
        }
        if(inBlock){
            if(value.includes('*/')){
                inBlock=false;
            }
            return false;
        }
        if(value.startsWith('/*')){
            inBlock=!value.includes('*/');
            return false;
        }
        return !value.startsWith('//');
    }).length;
}

async function complexityEntry(files){
    const sources=await Promise.all(files.map(async file => {
        const text=(await readFile(path.join(directory,file),'utf8')).replaceAll('\r\n','\n');
        return {bytes:Buffer.from(text,'utf8'),file,text};
    }));
    const digest=createHash('sha256');
    if(sources.length === 1){
        digest.update(sources[0].bytes);
    }else{
        for(const source of sources){
            digest.update(`${source.file}\0${source.bytes.length}\0`);
            digest.update(source.bytes);
        }
    }
    return {
        implementationBytes:sources.reduce((total,source) => total+source.bytes.length,0),
        implementationFiles:sources.length,
        source:files.join(', '),
        sourceSha256:digest.digest('hex'),
        sourceLines:sources.reduce((total,source) => total+sourceLines(source.text),0)
    };
}

async function complexityReport(){
    const result={};
    const cache=new Map;
    const entry=files => {
        const key=files.join('\0');
        if(!cache.has(key)){
            cache.set(key,complexityEntry(files));
        }
        return cache.get(key);
    };
    for(const moduleId of moduleIds){
        result[moduleId]=await entry([`adapters/${moduleId}.js`]);
    }
    for(const laneId of laneIds){
        const files=laneDefinitions[laneId].sourceFiles;
        if(files.length > 1){
            result[laneId]=await entry(files);
        }
    }
    return result;
}

export {
    complexityReport,
    sourceLines
};
