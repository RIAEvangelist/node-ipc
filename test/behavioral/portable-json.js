import assert from 'node:assert/strict';
import {TextDecoder} from 'node:util';

const maximumSafeInteger=9_007_199_254_740_991n;
const utf8Decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});

function parsePortableJson(input){
    const source=typeof input === 'string' ? input : utf8Decoder.decode(input);
    assert.equal(typeof source,'string','portable JSON source must be a string');
    let offset=0;

    function fail(message){
        throw new SyntaxError(`${message} at JSON offset ${offset}`);
    }

    function skipWhitespace(){
        while(offset < source.length && /[\t\n\r ]/u.test(source[offset])){
            offset++;
        }
    }

    function parseString(){
        const start=offset;
        if(source[offset++] !== '"'){
            fail('expected a JSON string');
        }
        while(offset < source.length){
            const character=source[offset++];
            if(character === '"'){
                const decoded=JSON.parse(source.slice(start,offset));
                for(let index=0;index<decoded.length;index++){
                    const codeUnit=decoded.charCodeAt(index);
                    if(codeUnit >= 0xD800 && codeUnit <= 0xDBFF){
                        const trailing=decoded.charCodeAt(index+1);
                        if(!(trailing >= 0xDC00 && trailing <= 0xDFFF)){
                            fail('JSON string contains a lone high surrogate');
                        }
                        index++;
                    }else if(codeUnit >= 0xDC00 && codeUnit <= 0xDFFF){
                        fail('JSON string contains a lone low surrogate');
                    }
                }
                return decoded;
            }
            if(character.charCodeAt(0) < 0x20){
                fail('unescaped control character in JSON string');
            }
            if(character !== '\\'){
                continue;
            }
            if(offset >= source.length){
                fail('unterminated JSON escape');
            }
            const escape=source[offset++];
            if(escape === 'u'){
                const digits=source.slice(offset,offset+4);
                if(!/^[\dA-Fa-f]{4}$/u.test(digits)){
                    fail('invalid JSON Unicode escape');
                }
                offset+=4;
            }else if(!/["\\/bfnrt]/u.test(escape)){
                fail('invalid JSON escape');
            }
        }
        fail('unterminated JSON string');
    }

    function parseNumber(location){
        const match=/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(source.slice(offset));
        if(!match){
            fail('invalid JSON number');
        }
        const spelling=match[0];
        offset+=spelling.length;
        if(!/^-?(?:0|[1-9]\d*)$/u.test(spelling) || spelling === '-0'){
            fail(`${location} must contain only canonical safe integers`);
        }
        const integer=BigInt(spelling);
        if(integer < -maximumSafeInteger || integer > maximumSafeInteger){
            fail(`${location} must contain only canonical safe integers`);
        }
    }

    function consumeLiteral(literal){
        if(source.slice(offset,offset+literal.length) !== literal){
            fail(`expected ${literal}`);
        }
        offset+=literal.length;
    }

    function parseArray(location,depth){
        offset++;
        skipWhitespace();
        if(source[offset] === ']'){
            offset++;
            return;
        }
        let index=0;
        while(true){
            parseValue(`${location}[${index++}]`,depth);
            skipWhitespace();
            if(source[offset] === ']'){
                offset++;
                return;
            }
            if(source[offset++] !== ','){
                fail('expected a comma or closing bracket');
            }
            skipWhitespace();
        }
    }

    function parseObject(location,depth){
        offset++;
        skipWhitespace();
        if(source[offset] === '}'){
            offset++;
            return;
        }
        const names=new Set;
        while(true){
            const name=parseString();
            if(names.has(name)){
                fail(`${location} contains duplicate object member ${name}`);
            }
            names.add(name);
            skipWhitespace();
            if(source[offset++] !== ':'){
                fail('expected a colon after an object member name');
            }
            parseValue(`${location}.${name}`,depth);
            skipWhitespace();
            if(source[offset] === '}'){
                offset++;
                return;
            }
            if(source[offset++] !== ','){
                fail('expected a comma or closing brace');
            }
            skipWhitespace();
        }
    }

    function parseValue(location,depth=0){
        skipWhitespace();
        switch(source[offset]){
            case '"':
                parseString();
                return;
            case '{':
                if(depth >= 64){
                    fail(`${location} exceeds the portable JSON nesting limit of 64`);
                }
                parseObject(location,depth+1);
                return;
            case '[':
                if(depth >= 64){
                    fail(`${location} exceeds the portable JSON nesting limit of 64`);
                }
                parseArray(location,depth+1);
                return;
            case 't':
                consumeLiteral('true');
                return;
            case 'f':
                consumeLiteral('false');
                return;
            case 'n':
                consumeLiteral('null');
                return;
            default:
                parseNumber(location);
        }
    }

    parseValue('contract');
    skipWhitespace();
    if(offset !== source.length){
        fail('unexpected trailing JSON content');
    }
    return JSON.parse(source);
}

export {parsePortableJson};
