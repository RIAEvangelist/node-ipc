function baseWilliamsOrder(size){
    if(size < 2 || size%2 !== 0){
        throw new Error('Williams ordering requires an even number of subjects');
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

function williamsOrder(subjects,block){
    const size=subjects.length;
    const base=baseWilliamsOrder(size);
    const row=block%size;
    return base.map(index => subjects[(index+row)%size]);
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

export {
    baseWilliamsOrder,
    buildPlan,
    williamsOrder
};
