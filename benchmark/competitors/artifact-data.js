import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath,pathToFileURL} from 'node:url';

const directory=path.dirname(fileURLToPath(import.meta.url));

function parseQueries(text){
    const chunks=text.split(/^-- query: ([a-z][a-z-]*)\s*$/gmu);
    const queries={};
    for(let index=1;index<chunks.length;index+=2){
        queries[chunks[index]]=chunks[index+1].trim();
    }
    if(!Object.keys(queries).length){
        throw new Error('artifact-queries.sql contains no named queries');
    }
    return queries;
}

function buildArtifactData(resultFile=path.join(directory,'results/windows-node24-20260823.json')){
    const resolvedResult=path.resolve(resultFile);
    const resultBytes=readFileSync(resolvedResult);
    const resultText=resultBytes.toString('utf8');
    const result=JSON.parse(resultText);
    const sql=readFileSync(path.join(directory,'artifact-queries.sql'),'utf8');
    const queries=parseQueries(sql);
    const database=new DatabaseSync(':memory:');
    database.function('benchmark_result',() => resultText);
    try{
        const datasets={};
        for(const [name,query] of Object.entries(queries)){
            datasets[name]=database.prepare(query).all();
        }
        return {
            datasets,
            queries,
            source:{
                file:resolvedResult,
                id:result.id ?? null,
                schemaVersion:result.schemaVersion,
                sha256:createHash('sha256').update(resultBytes).digest('hex')
            }
        };
    }finally{
        database.close();
    }
}

const directInvocation=process.argv[1]
    && pathToFileURL(process.argv[1]).href === import.meta.url;

if(directInvocation){
    const resultFile=process.argv[2]
        ? path.resolve(process.argv[2])
        : path.join(directory,'results/windows-node24-20260823.json');
    const output=buildArtifactData(resultFile);
    process.stdout.write(`${JSON.stringify(output)}\n`);
}

export {
    buildArtifactData,
    parseQueries
};
