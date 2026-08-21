import assert from 'node:assert/strict';
import VanillaTest from 'vanilla-test';

const expectedCategoryCounts=Object.freeze({
    Unit:30,
    Functional:20,
    Integration:20,
    Regression:20
});

function validateInventory(groups){
    const descriptions=new Set();
    const categoryCounts=Object.fromEntries(
        Object.keys(expectedCategoryCounts).map((category) => [category,0])
    );

    for(const group of groups){
        assert.ok(Object.hasOwn(expectedCategoryCounts,group.category),`Unknown category: ${group.category}`);
        assert.equal(typeof group.name,'string');
        assert.ok(group.name.length > 0);
        assert.ok(Array.isArray(group.cases));
        assert.ok(group.cases.length >= 5 && group.cases.length <= 10,`${group.category}/${group.name} must contain 5-10 cases.`);

        for(const entry of group.cases){
            assert.equal(typeof entry.name,'string');
            assert.equal(typeof entry.run,'function');
            const description=`[${group.category}] ${group.name} — ${entry.name}`;
            assert.ok(!descriptions.has(description),`Duplicate case: ${description}`);
            descriptions.add(description);
            categoryCounts[group.category]++;
        }
    }

    assert.deepEqual(categoryCounts,expectedCategoryCounts);
    assert.equal(descriptions.size,90);
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
    expectedCategoryCounts,
    run as default,
    run,
    validateInventory
};
