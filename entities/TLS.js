import fs from 'node:fs';

function createClientTLSOptions(config,connectionOptions,assured=false){
    const options=loadTLSOptions(config);
    Object.assign(options,connectionOptions);
    if(options.rejectUnauthorized === undefined){
        options.rejectUnauthorized=true;
    }
    if(assured && (
        options.rejectUnauthorized !== true
        || !options.ca
        || !options.key
        || !options.cert
    )){
        throw tlsConfigurationError(
            'Assured network clients require a key, certificate, trusted CA, and rejectUnauthorized=true.',
            'ERR_IPC_ASSURED_TLS'
        );
    }
    return options;
}

function createServerTLSOptions(config,assured=false){
    const options=loadTLSOptions(config);

    if(!options.key || !options.cert){
        throw tlsConfigurationError(
            'TLS servers require an explicit key and certificate. Supply tls.key/tls.cert values or tls.private/tls.public file paths.'
        );
    }
    if(options.ca && options.requestCert === undefined){
        options.requestCert=true;
    }
    if(options.requestCert && options.rejectUnauthorized === undefined){
        options.rejectUnauthorized=true;
    }
    if(assured && (
        options.requestCert !== true
        || options.rejectUnauthorized !== true
        || !options.ca
    )){
        throw tlsConfigurationError(
            'Assured network servers require a trusted client CA, requestCert=true, and rejectUnauthorized=true.',
            'ERR_IPC_ASSURED_TLS'
        );
    }

    return options;
}

function loadTLSOptions(config){
    if(!config || typeof config !== 'object' || Array.isArray(config)){
        throw tlsConfigurationError('ipc.config.tls must be an options object');
    }

    const options={...config};
    if(options.private){
        options.key=fs.readFileSync(options.private);
    }
    if(options.public){
        options.cert=fs.readFileSync(options.public);
    }
    if(typeof options.dhparam === 'string' && !options.dhparam.includes('BEGIN DH PARAMETERS')){
        options.dhparam=fs.readFileSync(options.dhparam);
    }
    if(options.trustedConnections){
        const paths=Array.isArray(options.trustedConnections)
            ? options.trustedConnections
            : [options.trustedConnections];
        const trusted=paths.map((trustedPath) => fs.readFileSync(trustedPath));
        const existing=options.ca === undefined
            ? []
            : (Array.isArray(options.ca) ? options.ca : [options.ca]);
        options.ca=[...existing,...trusted];
    }

    delete options.private;
    delete options.public;
    delete options.trustedConnections;

    return options;
}

function tlsConfigurationError(message,code='ERR_IPC_TLS_CONFIGURATION'){
    const error=new Error(message);
    error.code=code;
    return error;
}

export {
    createClientTLSOptions,
    createServerTLSOptions
};
