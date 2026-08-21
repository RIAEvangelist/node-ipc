import path from 'node:path';
import process from 'node:process';
import {pathToFileURL} from 'node:url';

import functionalGroups from './suites/functional.js';
import functionalAdditionalGroups from './suites/functional-additional.js';
import integrationGroups from './suites/integration.js';
import integrationAdditionalGroups from './suites/integration-additional.js';
import regressionGroups from './suites/regression.js';
import regressionAdditionalGroups from './suites/regression-additional.js';
import unitGroups from './suites/unit.js';
import unitAdditionalGroups from './suites/unit-additional.js';
import {run as runSuite} from './suite-runner.js';

const groups=[
    ...unitGroups,
    ...unitAdditionalGroups,
    ...functionalGroups,
    ...functionalAdditionalGroups,
    ...integrationGroups,
    ...integrationAdditionalGroups,
    ...regressionGroups,
    ...regressionAdditionalGroups
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
