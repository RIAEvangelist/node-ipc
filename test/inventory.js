import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath,pathToFileURL} from 'node:url';

import {groups} from './CI.js';
import {minimumCategoryCounts,validateInventory} from './suite-runner.js';

const require=createRequire(import.meta.url);

function createInventory(){
    const validated=validateInventory(groups);
    const groupNames=new Set;
    const groupSlugs=new Set;
    const projectPackage=readJSON(fileURLToPath(new URL('../package.json',import.meta.url)));
    const runnerPackage=readJSON(path.join(path.dirname(require.resolve('vanilla-test')),'package.json'));
    assert.equal(
        projectPackage.devDependencies['vanilla-test'],
        runnerPackage.version,
        'The installed vanilla-test version must exactly match package.json.'
    );

    for(const group of groups){
        const name=`${group.category}/${group.name}`;
        const slug=`${group.category.toLowerCase()}/${slugify(group.name)}`;
        assert.ok(!groupNames.has(name),`Duplicate group: ${name}`);
        assert.ok(!groupSlugs.has(slug),`Duplicate group slug: ${slug}`);
        assert.ok(slugify(group.name).length > 0,`Empty group slug: ${name}`);
        groupNames.add(name);
        groupSlugs.add(slug);
    }

    return {
        schemaVersion:2,
        runner:{
            name:'vanilla-test',
            version:runnerPackage.version
        },
        total:validated.total,
        categories:{...validated.categoryCounts},
        minimumCategories:{...minimumCategoryCounts},
        groups:groups.map((group) => ({
            category:group.category,
            name:group.name,
            slug:slugify(group.name),
            count:group.cases.length,
            cases:group.cases.map((entry) => entry.name)
        }))
    };
}

function slugify(value){
    return value
        .normalize('NFKD')
        .toLowerCase()
        .replace(/[^a-z0-9]+/gu,'-')
        .replace(/^-|-$/gu,'');
}

function readJSON(file){
    return JSON.parse(readFileSync(file,'utf8'));
}

const directInvocation=process.argv[1]
    && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if(directInvocation){
    try{
        console.log(JSON.stringify(createInventory(),null,2));
    }catch(error){
        console.error(error?.stack || error);
        process.exitCode=1;
    }
}

export {createInventory as default,createInventory};
