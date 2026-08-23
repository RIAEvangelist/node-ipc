import assert from 'node:assert/strict';
import {lstat,readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {manifestEntry,validDate,validateResult} from './lib.js';

export async function validateHistory(directory,{allowMissing=false,allowUnindexed=new Set,tracked=true}={}){
    const names=[];
    for(const entry of await readdir(directory,{withFileTypes:true})){
        assert.equal(entry.isSymbolicLink(),false,`${entry.name}: symbolic links are forbidden`);
        if(entry.isFile() && /^run-[A-Za-z0-9-]+[.]json$/u.test(entry.name)) names.push(entry.name);
    }
    const indexPath=path.join(directory,'index.json');
    let index;
    try{
        const details=await lstat(indexPath);
        assert.ok(details.isFile() && !details.isSymbolicLink(),'history manifest must be a regular file');
        index=JSON.parse(await readFile(indexPath,'utf8'));
    }catch(error){
        if(error.code !== 'ENOENT') throw error;
        assert.equal(allowMissing,true,'history manifest is missing');
        index={schemaVersion:1,updatedAt:null,results:[]};
    }
    const retained=names.filter((name) => !allowUnindexed.has(name)).sort();
    const expected=Array.isArray(index.results) ? index.results.map((entry) => entry.file).sort() : [];
    assert.deepEqual(retained,expected,'history result inventory differs');
    assert.deepEqual(
        names.filter((name) => allowUnindexed.has(name)).sort(),
        [...allowUnindexed].sort(),
        'recoverable history inventory differs'
    );
    const records=new Map;
    for(const name of retained){
        const file=path.join(directory,name);
        const details=await lstat(file);
        assert.ok(details.isFile() && !details.isSymbolicLink(),`${name}: result must be a regular file`);
        const bytes=await readFile(file);
        const result=validateResult(JSON.parse(bytes),{tracked});
        assert.equal(result.record.file,name,`${name}: record filename differs`);
        records.set(name,{bytes,result});
    }
    validateHistoryIndex(index,records);
    return index;
}

export function validateHistoryIndex(index,records){
    assert.deepEqual(Object.keys(index).sort(),['results','schemaVersion','updatedAt'],'history manifest fields differ');
    assert.equal(index.schemaVersion,1,'history manifest schemaVersion differs');
    assert.ok(Array.isArray(index.results),'history manifest results differ');
    if(index.results.length) assert.ok(validDate(index.updatedAt),'history manifest update time is invalid');
    else assert.equal(index.updatedAt,null,'empty history update time differs');
    assert.equal(records.size,index.results.length,'history result inventory differs');
    const ids=new Set;
    const files=new Set;
    for(const entry of index.results){
        assert.equal(typeof entry?.id,'string','history result id differs');
        assert.equal(entry.file,`${entry.id}.json`,`${entry.id}: history filename differs`);
        assert.equal(ids.has(entry.id),false,`${entry.id}: duplicate history id`);
        assert.equal(files.has(entry.file),false,`${entry.file}: duplicate history filename`);
        ids.add(entry.id);
        files.add(entry.file);
        const record=records.get(entry.file);
        assert.ok(record,`${entry.file}: history result is missing`);
        assert.deepEqual(manifestEntry(record.result,record.bytes),entry,`${entry.file}: history manifest entry differs`);
    }
    return index;
}
