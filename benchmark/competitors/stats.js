function quantile(sorted,fraction){
    if(!sorted.length){
        return null;
    }
    const position=(sorted.length-1)*fraction;
    const lower=Math.floor(position);
    const upper=Math.ceil(position);
    if(lower === upper){
        return sorted[lower];
    }
    const weight=position-lower;
    return sorted[lower]*(1-weight)+sorted[upper]*weight;
}

function median(values){
    return quantile([...values].sort((left,right) => left-right),0.5);
}

function distribution(values){
    if(!values.length){
        return null;
    }
    const sorted=[...values].sort((left,right) => left-right);
    const middle=quantile(sorted,0.5);
    const deviations=sorted.map(value => Math.abs(value-middle)).sort((left,right) => left-right);
    return {
        count:sorted.length,
        iqr:quantile(sorted,0.75)-quantile(sorted,0.25),
        mad:quantile(deviations,0.5),
        maximum:sorted.at(-1),
        median:middle,
        minimum:sorted[0],
        p25:quantile(sorted,0.25),
        p75:quantile(sorted,0.75)
    };
}

function latencySummary(values){
    const sorted=[...values].sort((left,right) => left-right);
    return {
        count:sorted.length,
        maximumNs:sorted.at(-1),
        meanNs:sorted.reduce((sum,value) => sum+value,0)/sorted.length,
        minimumNs:sorted[0],
        p50Ns:quantile(sorted,0.5),
        p95Ns:quantile(sorted,0.95),
        p99Ns:quantile(sorted,0.99)
    };
}

export {
    distribution,
    latencySummary,
    median,
    quantile
};
