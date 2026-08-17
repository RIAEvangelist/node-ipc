import {execFileSync} from 'node:child_process';
import {lstat, mkdir, mkdtemp, readdir, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const npmCli = process.env.npm_execpath;

function npm(args, cwd) {
    if (!npmCli) {
        throw new Error('package footprint requires an npm script');
    }
    return execFileSync(process.execPath, [npmCli, ...args], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'inherit']
    });
}

async function treeSize(root) {
    const total = {bytes: 0, files: 0};
    async function visit(directory) {
        for (const entry of await readdir(directory, {withFileTypes: true})) {
            const target = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                await visit(target);
            } else if (entry.isFile()) {
                total.bytes += (await lstat(target)).size;
                total.files += 1;
            }
        }
    }
    await visit(root);
    return total;
}

function dependencyCounts(tree, packageName) {
    const subject = tree.dependencies?.[packageName] ?? {};
    const unique = new Set();
    let instances = 0;
    function visit(dependencies = {}) {
        for (const [name, dependency] of Object.entries(dependencies)) {
            instances += 1;
            unique.add(`${name}@${dependency.version ?? 'unknown'}`);
            visit(dependency.dependencies);
        }
    }
    visit(subject.dependencies);
    return {
        direct: Object.keys(subject.dependencies ?? {}).length,
        instances,
        unique: unique.size
    };
}

export async function packageFootprint(projectRoot) {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'node-ipc-footprint-'));
    try {
        const [packed] = JSON.parse(npm([
            'pack',
            '--ignore-scripts',
            '--json',
            '--pack-destination',
            temporaryRoot
        ], projectRoot));
        const consumer = path.join(temporaryRoot, 'consumer');
        await mkdir(consumer);
        await writeFile(path.join(consumer, 'package.json'), '{"private":true}\n');
        npm([
            'install',
            '--ignore-scripts',
            '--no-audit',
            '--no-fund',
            '--omit=dev',
            path.join(temporaryRoot, packed.filename)
        ], consumer);

        const installedRoot = path.join(consumer, 'node_modules');
        const packageRoot = path.join(installedRoot, 'node-ipc');
        const dependencyTree = JSON.parse(npm(['ls', '--all', '--json', '--omit=dev'], consumer));
        return {
            dependencies: dependencyCounts(dependencyTree, packed.name),
            installed: await treeSize(installedRoot),
            package: await treeSize(packageRoot),
            tarball: {
                bytes: packed.size,
                files: packed.entryCount,
                integrity: packed.integrity,
                unpackedBytes: packed.unpackedSize
            }
        };
    } finally {
        await rm(temporaryRoot, {force: true, recursive: true});
    }
}
