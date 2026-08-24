#!/usr/bin/env node

import {run} from '../../../test/behavioral/vanilla-test.js';

try{
    const result=await run({
        pairs:[
            ['csharp','node'],
            ['node','csharp']
        ]
    });
    process.exitCode=result.ok ? 0 : 1;
}catch(error){
    console.error(error?.stack || error);
    process.exitCode=2;
}
