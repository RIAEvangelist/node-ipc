import {fileURLToPath} from 'node:url';

const clientCertificate=fileURLToPath(
    new URL('../../local-node-ipc-certs/client.pub',import.meta.url)
);
const clientKey=fileURLToPath(
    new URL('../../local-node-ipc-certs/private/client.key',import.meta.url)
);
const dhParameters=fileURLToPath(
    new URL('../../local-node-ipc-certs/private/dhparam.pem',import.meta.url)
);
const serverCertificate=fileURLToPath(
    new URL('../../local-node-ipc-certs/server.pub',import.meta.url)
);
const serverKey=fileURLToPath(
    new URL('../../local-node-ipc-certs/private/server.key',import.meta.url)
);

export {
    clientCertificate,
    clientKey,
    dhParameters,
    serverCertificate,
    serverKey
};
