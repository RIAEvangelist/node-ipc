import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const outputDirectory = path.join(directory, 'bin');
const output = path.join(outputDirectory, process.platform === 'win32' ? 'raw-echo.exe' : 'raw-echo');
const source = path.join(directory, 'echo.c');
const requested = process.env.CC;
const candidates = requested ? [requested] : process.platform === 'win32'
    ? ['clang', 'gcc', 'cl']
    : ['cc', 'clang', 'gcc'];

fs.mkdirSync(outputDirectory, {recursive: true});
for (const compiler of candidates) {
    const cl = path.basename(compiler).toLowerCase() === 'cl' || path.basename(compiler).toLowerCase() === 'cl.exe';
    const compileArguments = cl
        ? ['/nologo', '/O2', `/Fe:${output}`, source, 'ws2_32.lib']
        : ['-O3', '-std=c11', source, '-o', output, ...(process.platform === 'win32' ? ['-lws2_32'] : [])];
    const recordedFlags = cl
        ? ['/nologo', '/O2', 'ws2_32.lib']
        : ['-O3', '-std=c11', ...(process.platform === 'win32' ? ['-lws2_32'] : [])];
    const result = spawnSync(compiler, compileArguments, {encoding: 'utf8'});
    if (!result.error && result.status === 0) {
        const version = spawnSync(compiler, cl ? [] : ['--version'], {encoding: 'utf8'});
        fs.writeFileSync(path.join(outputDirectory, 'build.json'), `${JSON.stringify({
            binarySha256: createHash('sha256').update(fs.readFileSync(output)).digest('hex'),
            compiler,
            flags: recordedFlags,
            sourceSha256: createHash('sha256').update(fs.readFileSync(source)).digest('hex'),
            target: {
                architecture: process.arch,
                name: path.basename(output),
                platform: process.platform
            },
            version: `${version.stdout ?? ''}${version.stderr ?? ''}`.trim().split(/\r?\n/, 1)[0]
        }, null, 2)}\n`);
        process.stdout.write(`${output}\n`);
        process.exit(0);
    }
}
throw new Error(`no working C compiler found; set CC to the compiler executable`);
