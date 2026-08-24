#!/usr/bin/env node

import assert from 'node:assert/strict';

import {parsePortableJson} from './portable-json.js';

for(const [name,source] of [
    ['fraction','{"value":1.0}'],
    ['exponent','{"value":1e0}'],
    ['negative zero','{"value":-0}'],
    ['unsafe positive integer','{"value":9007199254740992}'],
    ['unsafe negative integer','{"value":-9007199254740992}'],
    ['duplicate member','{"value":1,"value":2}'],
    ['escape-equivalent duplicate member','{"value":1,"\\u0076alue":2}'],
    ['lone high surrogate','{"value":"\\uD800"}'],
    ['lone low surrogate','{"value":"\\uDC00"}'],
    ['excessive nesting','['.repeat(65)+'0'+']'.repeat(65)]
]){
    assert.throws(
        () => parsePortableJson(source),
        {name:'SyntaxError'},
        `${name} must not enter the shared behavior contract`
    );
}

assert.deepEqual(
    parsePortableJson(
        '{"minimum":-9007199254740991,"zero":0,"maximum":9007199254740991,"array":[true,null,"ok"]}'
    ),
    {
        minimum:-9_007_199_254_740_991,
        zero:0,
        maximum:9_007_199_254_740_991,
        array:[true,null,'ok']
    }
);
assert.deepEqual(parsePortableJson('{"emoji":"\\uD83D\\uDE00"}'),{emoji:'😀'});
assert.ok(Array.isArray(parsePortableJson('['.repeat(64)+'0'+']'.repeat(64))));
assert.throws(() => parsePortableJson(Buffer.from([0x22,0xC0,0x22])),TypeError);
assert.throws(
    () => parsePortableJson(Buffer.concat([
        Buffer.from([0xEF,0xBB,0xBF]),
        Buffer.from('{"value":1}')
    ])),
    {name:'SyntaxError'},
    'a UTF-8 byte-order mark must not enter the shared behavior contract'
);

console.log('portable behavior-contract JSON checks passed');
