import IPC from './services/IPC.js';
import {
    AssuredParser,
    FastParser,
    GuardedParser,
    IPCProtocolError,
    Parser,
    RawParser
} from './entities/EventParser.js';

class IPCModule extends IPC{
    IPC=IPC;
}

const singleton=new IPCModule;

export {
    AssuredParser,
    FastParser,
    GuardedParser,
    IPCProtocolError,
    singleton as default,
    IPCModule,
    Parser,
    RawParser
}
