import path from 'node:path';
import process from 'node:process';
import {pathToFileURL} from 'node:url';

import functionalGroups from './suites/functional.js';
import integrationGroups from './suites/integration.js';
import regressionGroups from './suites/regression.js';
import unitGroups from './suites/unit.js';
import {run as runSuite} from './suite-runner.js';

const groups=[
    ...unitGroups,
    ...functionalGroups,
    ...integrationGroups,
    ...regressionGroups
];

async function run(){
    return runSuite(groups);
}

const directInvocation=process.argv[1]
    && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if(directInvocation){
    try{
        const result=await run();
        process.exitCode=result.ok ? 0 : 1;
    }catch(error){
        console.error(error?.stack || error);
        process.exitCode=2;
    }
}

export {
    groups,
    run as default,
    run
};
