import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const directory=path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot=path.resolve(directory,'../..');

function dependencyNames(entry){
    return Object.keys(entry?.dependencies ?? {});
}

function resolveDependency(packages,parentPath,name){
    let current=parentPath;
    while(current){
        const nested=`${current}/node_modules/${name}`;
        if(packages[nested]){
            return nested;
        }
        const marker=current.lastIndexOf('/node_modules/');
        if(marker === -1){
            break;
        }
        current=current.slice(0,marker);
    }
    const root=`node_modules/${name}`;
    return packages[root] ? root : null;
}

function closure(lock,rootPaths){
    const packages=lock.packages;
    const visited=new Set();
    const queue=[];
    const directNames=new Set();
    let directEdges=0;

    for(const rootPath of rootPaths){
        const root=packages[rootPath];
        if(!root){
            throw new Error(`missing package-lock entry ${rootPath}`);
        }
        for(const name of dependencyNames(root)){
            directEdges+=1;
            directNames.add(name);
            const resolved=resolveDependency(packages,rootPath,name);
            if(!resolved){
                throw new Error(`cannot resolve ${name} from ${rootPath}`);
            }
            queue.push(resolved);
        }
    }

    while(queue.length){
        const packagePath=queue.shift();
        if(visited.has(packagePath) || rootPaths.includes(packagePath)){
            continue;
        }
        visited.add(packagePath);
        const entry=packages[packagePath];
        for(const name of dependencyNames(entry)){
            const resolved=resolveDependency(packages,packagePath,name);
            if(!resolved){
                throw new Error(`cannot resolve ${name} from ${packagePath}`);
            }
            queue.push(resolved);
        }
        for(const name of Object.keys(entry.optionalDependencies ?? {})){
            const resolved=resolveDependency(packages,packagePath,name);
            if(resolved){
                queue.push(resolved);
            }
        }
    }

    const uniqueNameVersions=new Set();
    const installScripts=[];
    for(const packagePath of visited){
        const entry=packages[packagePath];
        const name=entry.name ?? packagePath.slice(packagePath.lastIndexOf('node_modules/')+13);
        uniqueNameVersions.add(`${name}@${entry.version ?? 'unknown'}`);
        if(entry.hasInstallScript){
            installScripts.push(`${name}@${entry.version ?? 'unknown'}`);
        }
    }
    for(const rootPath of rootPaths){
        const entry=packages[rootPath];
        if(entry.hasInstallScript){
            const name=entry.name ?? rootPath.slice(rootPath.lastIndexOf('node_modules/')+13);
            installScripts.push(`${name}@${entry.version ?? 'unknown'}`);
        }
    }

    return {
        directDependencyEdges:directEdges,
        directDependencyNames:[...directNames].sort(),
        directUniqueDependencies:directNames.size,
        installedDependencyInstances:visited.size,
        packagesWithInstallScripts:[...new Set(installScripts)].sort(),
        uniqueResolvedDependencies:uniqueNameVersions.size,
        uniqueResolvedNameVersions:[...uniqueNameVersions].sort()
    };
}

function rootClosure(lock,manifest){
    const names=Object.keys(manifest.dependencies ?? {});
    const synthetic={dependencies:Object.fromEntries(names.map(name => [name,manifest.dependencies[name]]))};
    const packages={...lock.packages,'node_modules/node-ipc-subject':synthetic};
    return closure({...lock,packages},['node_modules/node-ipc-subject']);
}

function riskTier(count){
    if(count === 0){
        return 'minimal';
    }
    if(count <= 5){
        return 'low';
    }
    if(count <= 15){
        return 'moderate';
    }
    return 'high';
}

async function dependencyExposure(){
    const [benchmarkLock,rootLock,rootManifest]=await Promise.all([
        readFile(path.join(directory,'package-lock.json'),'utf8').then(JSON.parse),
        readFile(path.join(repositoryRoot,'package-lock.json'),'utf8').then(JSON.parse),
        readFile(path.join(repositoryRoot,'package.json'),'utf8').then(JSON.parse)
    ]);
    const zero={
        directDependencyEdges:0,
        directDependencyNames:[],
        directUniqueDependencies:0,
        installedDependencyInstances:0,
        packagesWithInstallScripts:[],
        uniqueResolvedDependencies:0,
        uniqueResolvedNameVersions:[]
    };
    const result={
        'native-child-process':{...zero},
        'native-net':{...zero},
        'native-tls':{...zero},
        'node-ipc':rootClosure(rootLock,rootManifest),
        'socket-io':closure(benchmarkLock,['node_modules/socket.io','node_modules/socket.io-client']),
        'ws':closure(benchmarkLock,['node_modules/ws']),
        'zeromq':closure(benchmarkLock,['node_modules/zeromq'])
    };
    for(const exposure of Object.values(result)){
        exposure.riskProxy='unique resolved production dependencies';
        exposure.riskTier=riskTier(exposure.uniqueResolvedDependencies);
    }
    return result;
}

export {
    closure,
    dependencyExposure,
    resolveDependency,
    riskTier
};
