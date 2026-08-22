import Message from 'js-message';
import Parser from './EventParser.js';

class MessageParser extends Parser{
    decode(frame){
        return new Message(frame);
    }
}

export {
    MessageParser as default,
    MessageParser
};
