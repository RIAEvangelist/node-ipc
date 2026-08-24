function baseWilliamsOrder(size){
    if(!Number.isSafeInteger(size) || size < 1){
        throw new Error('Williams ordering requires at least one subject');
    }
    const order=[0];
    for(let offset=1;order.length<size;offset+=1){
        order.push(offset);
        if(order.length<size){
            order.push(size-offset);
        }
    }
    return order;
}

function cycleLength(size){
    if(!Number.isSafeInteger(size) || size < 1){
        throw new Error('cycle size must be a positive integer');
    }
    return size === 1 || size%2 === 0 ? size : size*2;
}

function williamsOrder(subjects,block){
    const size=subjects.length;
    if(!Number.isSafeInteger(block) || block < 0){
        throw new Error('block must be a non-negative integer');
    }
    const base=baseWilliamsOrder(size);
    const sequence=block%cycleLength(size);
    const row=sequence%size;
    const order=base.map(index => subjects[(index+row)%size]);
    return size%2 !== 0 && sequence >= size ? order.reverse() : order;
}

function buildPlan(subjects,payloads,workloads,samples){
    const plan=[];
    for(let block=0;block<samples;block+=1){
        payloads.forEach((payloadBytes,payloadIndex) => {
            workloads.forEach((workload,workloadIndex) => {
                const order=williamsOrder(subjects,block+payloadIndex+workloadIndex);
                order.forEach((subject,orderIndex) => plan.push({
                    block,
                    orderIndex,
                    payloadBytes,
                    subject,
                    workload
                }));
            });
        });
    }
    return plan;
}

function buildCohortPlan(lanes,payloads,workloads,samplesByCohort){
    const cohorts=new Map;
    for(const lane of lanes){
        const cohort=cohorts.get(lane.cohortId) ?? [];
        cohort.push(lane);
        cohorts.set(lane.cohortId,cohort);
    }
    const plan=[];
    for(const [cohortId,cohort] of cohorts){
        const samples=typeof samplesByCohort === 'number'
            ? samplesByCohort
            : samplesByCohort[cohortId];
        if(!Number.isSafeInteger(samples) || samples < 1){
            throw new Error(`samples for ${cohortId} must be a positive integer`);
        }
        for(let block=0;block<samples;block+=1){
            payloads.forEach((payloadBytes,payloadIndex) => {
                workloads.forEach((workload,workloadIndex) => {
                    const order=williamsOrder(cohort,block+payloadIndex+workloadIndex);
                    order.forEach((lane,orderIndex) => plan.push({
                        block,
                        cohortId,
                        laneId:lane.id,
                        moduleId:lane.moduleId,
                        orderIndex,
                        payloadBytes,
                        transportId:lane.transportId,
                        workload
                    }));
                });
            });
        }
    }
    return plan;
}

export {
    baseWilliamsOrder,
    buildCohortPlan,
    buildPlan,
    cycleLength,
    williamsOrder
};
