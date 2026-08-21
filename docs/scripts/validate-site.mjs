import assert from 'node:assert/strict';
import {existsSync, readFileSync, readdirSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {createInventory} from '../../test/inventory.js';
import {buildOutputs,routesForInventory} from './generate-test-pages.mjs';

const docs=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const inventory=createInventory();
const expectedRoutes=routesForInventory(inventory);
const generatedOutputs=buildOutputs(inventory);
const stagedPaths=new Set([
    'assets/node-ipc-header.png',
    'assets/node-ipc-performance-tiers.png',
    'coverage/report/index.html',
    'data/test-results.json',
    'data/coverage-summary.json',
    'data/benchmarks/index.json'
]);
const errors=[];
const titles=new Set();
const canonicals=new Set();

function walk(directory){
    return readdirSync(directory,{withFileTypes:true}).flatMap(entry => {
        const target=path.join(directory,entry.name);
        return entry.isDirectory() ? walk(target) : [target];
    });
}

function routeFor(file){
    const relative=path.relative(docs,file).replaceAll(path.sep,'/');
    if(relative === 'index.html') return '/';
    return `/${relative.replace(/index\.html$/,'')}`;
}

function check(condition,message){
    if(!condition) errors.push(message);
}

function localTarget(file,value){
    const clean=value.split('#')[0].split('?')[0];
    if(!clean || /^(?:https?:|mailto:|tel:|data:|javascript:)/i.test(clean)) return null;
    if(clean.startsWith('/')) return {error:`root-relative project URL is not portable: ${clean}`};
    const from=path.relative(docs,path.dirname(file)).replaceAll(path.sep,'/');
    const joined=path.posix.normalize(path.posix.join(from,clean));
    const relative=joined.endsWith('/') ? `${joined}index.html` : joined;
    return {relative:relative.replace(/^\.\//,''),target:path.join(docs,...relative.split('/'))};
}

const htmlFiles=walk(docs).filter(file => file.endsWith('.html'));
const routeFiles=htmlFiles.filter(file => path.basename(file) === 'index.html');
const actualRoutes=routeFiles.map(routeFor).sort();
check(actualRoutes.length === expectedRoutes.length,`expected ${expectedRoutes.length} routes, found ${actualRoutes.length}`);
check(JSON.stringify(actualRoutes) === JSON.stringify([...expectedRoutes].sort()),`route mismatch:\n${actualRoutes.join('\n')}`);

for(const [relative,expected] of generatedOutputs){
    const file=path.join(docs,...relative.split('/'));
    check(existsSync(file),`${relative}: missing generated file`);
    if(existsSync(file)) check(readFileSync(file,'utf8') === expected,`${relative}: generated content is stale`);
}

for(const file of htmlFiles){
    const relative=path.relative(docs,file).replaceAll(path.sep,'/');
    const source=readFileSync(file,'utf8');
    check(/<html\s+lang="en"/i.test(source),`${relative}: missing language`);
    check(/<title>[^<]+<\/title>/i.test(source),`${relative}: missing title`);
    check(/<meta\s+name="description"\s+content="[^"]+"/i.test(source),`${relative}: missing description`);
    check(/class="skip-link"/.test(source),`${relative}: missing skip link`);
    check(/<h1[\s>]/i.test(source),`${relative}: missing h1`);
    if(relative !== '404.html'){
        const title=source.match(/<title>([^<]+)<\/title>/i)?.[1];
        const canonical=source.match(/<link\s+rel="canonical"\s+href="([^"]+)"/i)?.[1];
        check(Boolean(canonical),`${relative}: missing canonical`);
        if(title){
            check(!titles.has(title),`${relative}: duplicate title ${title}`);
            titles.add(title);
        }
        if(canonical){
            check(!canonicals.has(canonical),`${relative}: duplicate canonical ${canonical}`);
            canonicals.add(canonical);
            const expected=`https://riaevangelist.github.io/node-ipc${routeFor(file)}`;
            check(canonical === expected,`${relative}: canonical ${canonical} does not match ${expected}`);
        }
        check(/property="og:image"/.test(source),`${relative}: missing Open Graph image`);
        check(/data-site-nav/.test(source),`${relative}: missing global navigation`);
        check(/aria-label="Breadcrumb"/.test(source),`${relative}: missing breadcrumb`);
    }

    const links=[...source.matchAll(/\b(?:href|src)="([^"]+)"/g)].map(match => match[1]);
    for(const link of links){
        const resolved=localTarget(file,link);
        if(!resolved) continue;
        if(resolved.error){
            errors.push(`${relative}: ${resolved.error}`);
            continue;
        }
        if(existsSync(resolved.target)) continue;
        if(stagedPaths.has(resolved.relative)) continue;
        errors.push(`${relative}: missing local target ${link} -> ${resolved.relative}`);
    }
}

const trackedInventoryFile=path.join(docs,'data','test-inventory.json');
const routeManifestFile=path.join(docs,'data','routes.json');
if(existsSync(trackedInventoryFile)){
    const trackedInventory=JSON.parse(readFileSync(trackedInventoryFile,'utf8'));
    check(JSON.stringify(trackedInventory) === JSON.stringify(inventory),'data/test-inventory.json does not match test/inventory.js');
}
if(existsSync(routeManifestFile)){
    const routeManifest=JSON.parse(readFileSync(routeManifestFile,'utf8'));
    check(routeManifest.schemaVersion === 1,'data/routes.json: unsupported schema version');
    check(JSON.stringify(routeManifest.routes) === JSON.stringify(expectedRoutes),'data/routes.json does not match generated routes');
}

for(const group of inventory.groups){
    const category=group.category.toLowerCase();
    const categoryPage=readFileSync(path.join(docs,'testing',category,'index.html'),'utf8');
    check(categoryPage.includes(`./${group.slug}/`),`testing/${category}: missing link to ${group.name}`);
}

const sitemap=readFileSync(path.join(docs,'sitemap.xml'),'utf8');
for(const route of expectedRoutes){
    check(sitemap.includes(`https://riaevangelist.github.io/node-ipc${route}`),`sitemap: missing ${route}`);
}

assert.equal(errors.length,0,`Site validation failed:\n- ${errors.join('\n- ')}`);
console.log(`Validated ${actualRoutes.length} routes, ${htmlFiles.length} HTML files, local links, metadata, and ${inventory.total} exact test cases across ${inventory.groups.length} group pages.`);
