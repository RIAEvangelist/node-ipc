import assert from 'node:assert/strict';
import VanillaTest from 'vanilla-test';

const minimumCategoryCounts=Object.freeze({
    Unit:40,
    Functional:30,
    Integration:40,
    Regression:30
});

function validateInventory(groups){
    const descriptions=new Set();
    const categoryCounts=Object.fromEntries(
        Object.keys(minimumCategoryCounts).map((category) => [category,0])
    );

    for(const group of groups){
        assert.ok(Object.hasOwn(minimumCategoryCounts,group.category),`Unknown category: ${group.category}`);
        assert.equal(typeof group.name,'string');
        assert.ok(group.name.length > 0);
        assert.ok(Array.isArray(group.cases));
        assert.equal(group.cases.length,5,`${group.category}/${group.name} must contain exactly five cases.`);

        for(const entry of group.cases){
            assert.equal(typeof entry.name,'string');
            assert.equal(typeof entry.run,'function');
            const description=`[${group.category}] ${group.name} — ${entry.name}`;
            assert.ok(!descriptions.has(description),`Duplicate case: ${description}`);
            descriptions.add(description);
            categoryCounts[group.category]++;
        }
    }

    for(const [category,minimum] of Object.entries(minimumCategoryCounts)){
        assert.ok(
            categoryCounts[category] >= minimum,
            `${category} must contain at least ${minimum} cases; found ${categoryCounts[category]}.`
        );
    }
    assert.ok(descriptions.size >= 140,`Correctness inventory must contain at least 140 cases; found ${descriptions.size}.`);
    return Object.freeze({categoryCounts,total:descriptions.size});
}

async function run(groups){
    const inventory=validateInventory(groups);
    const test=new VanillaTest;

    console.log('\nnode-ipc correctness inventory');
    for(const [category,count] of Object.entries(inventory.categoryCounts)){
        console.log(`  ${category}: ${count}`);
    }
    console.log(`  Total: ${inventory.total}\n`);

    for(const group of groups){
        console.log(`[${group.category}] ${group.name} (${group.cases.length})`);
        let context;
        let setupError;

        try{
            context=await group.setup?.();
        }catch(error){
            setupError=error;
        }

        for(const entry of group.cases){
            const description=`[${group.category}] ${group.name} — ${entry.name}`;
            test.expects(description);
            try{
                if(setupError){
                    throw setupError;
                }
                await entry.run(context);
                test.pass();
            }catch(error){
                console.error(`\n${description}`);
                console.error(error?.stack || error);
                test.fail();
            }finally{
                test.done();
            }
        }

        try{
            await group.teardown?.(context);
        }catch(error){
            throw new Error(`${group.category}/${group.name} teardown failed: ${error.message}`,{cause:error});
        }
    }

    const result=test.report();
    console.log(`\nCorrectness summary: ${result.total-result.failureCount} passed, ${result.failureCount} failed, ${result.total} total`);
    return result;
}

export {
    minimumCategoryCounts,
    run as default,
    run,
    validateInventory
};
