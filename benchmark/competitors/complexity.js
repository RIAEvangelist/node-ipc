import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {subjectIds} from './subjects.js';

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

async function complexityReport(){
    const result={};
    for(const subject of subjectIds){
        const file=`adapters/${subject}.js`;
        const bytes=await readFile(path.join(directory,file));
        const text=bytes.toString('utf8');
        result[subject]={
            implementationBytes:bytes.length,
            implementationFiles:1,
            source:file,
            sourceSha256:createHash('sha256').update(bytes).digest('hex'),
            sourceLines:sourceLines(text)
        };
    }
    return result;
}

export {
    complexityReport,
    sourceLines
};
